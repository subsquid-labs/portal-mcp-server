import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  describeTimeWindowInput,
  estimateBlockTime,
  parseTimeframeToSeconds,
  parseTimestampInput,
  resolveBlockAtTimestamp,
  resolveTimeframeOrBlocks,
  timeframeToBlocks,
} from './timeframe.js'

const NOW = 1_700_000_000
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('parseTimeframeToSeconds', () => {
  it('parses compact windows', () => {
    assert.equal(parseTimeframeToSeconds('30m'), 1_800)
    assert.equal(parseTimeframeToSeconds('2h'), 7_200)
    assert.equal(parseTimeframeToSeconds('1d'), 86_400)
    assert.equal(parseTimeframeToSeconds('7d'), 604_800)
    assert.equal(parseTimeframeToSeconds('90s'), 90)
  })

  it('rejects input that is not a window', () => {
    assert.throws(() => parseTimeframeToSeconds('soon'))
    assert.throws(() => parseTimeframeToSeconds(''))
  })
})

describe('parseTimestampInput', () => {
  it('reads natural-language relative windows as the same instant', () => {
    for (const input of ['30m', 'past 30 minutes', '30 minutes ago']) {
      assert.deepEqual(parseTimestampInput(input, NOW), {
        timestamp: NOW - 1_800,
        source: 'relative',
        normalized_input: '30m ago',
      })
    }
    assert.deepEqual(parseTimestampInput('in last 38 mins', NOW), {
      timestamp: NOW - 38 * 60,
      source: 'relative',
      normalized_input: '38m ago',
    })
  })

  it('tells unix seconds from milliseconds and keeps ISO datetimes exact', () => {
    assert.equal(parseTimestampInput(1_700_000_000_000, NOW).source, 'unix_milliseconds')
    assert.equal(parseTimestampInput(1_700_000_000_000, NOW).timestamp, 1_700_000_000)
    assert.equal(parseTimestampInput(1_700_000_000, NOW).source, 'unix_seconds')
    assert.deepEqual(parseTimestampInput('2026-01-01T00:00:00Z', NOW), {
      timestamp: 1_767_225_600,
      source: 'iso_datetime',
      normalized_input: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(parseTimestampInput('now', NOW).timestamp, NOW)
  })

  it('never returns a negative instant and rejects empty input', () => {
    assert.equal(parseTimestampInput('100 years ago', NOW).timestamp >= 0, true)
    assert.throws(() => parseTimestampInput('   ', NOW), /Timestamp cannot be empty/)
  })
})

describe('describeTimeWindowInput and timeframeToBlocks', () => {
  it('describes windows the way a person wrote them', () => {
    assert.equal(describeTimeWindowInput('30m'), 'last 30m')
    assert.equal(describeTimeWindowInput('past 30 minutes'), 'the past 30 minutes')
  })

  it('estimates blocks from the chain block time', () => {
    assert.equal(timeframeToBlocks('1h', 'bitcoin-mainnet'), 6)
    assert.equal(timeframeToBlocks('1h', 'ethereum-mainnet'), 300)
    assert.equal(timeframeToBlocks('2h', 'bitcoin-mainnet'), 2 * timeframeToBlocks('1h', 'bitcoin-mainnet'))
  })
})

const BASE_DENIM_TIMESTAMP = 1_793_901_600
const BASE_HEAD_TIMESTAMP = BASE_DENIM_TIMESTAMP + 3 * 86_400
const BASE_HEAD_BLOCK = 100_000_000

function mockBaseTimestamps(options: { exactBoundary?: number; headAvailable?: boolean } = {}) {
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/head') || url.endsWith('/finalized-head')) {
      return Response.json({ number: BASE_HEAD_BLOCK, hash: '0x1234' })
    }
    if (url.endsWith('/metadata')) return Response.json({ start_block: 0 })
    if (url.includes('/timestamps/')) {
      return options.exactBoundary === undefined
        ? new Response('', { status: 404 })
        : Response.json({ block_number: 1_000 })
    }
    if (url.endsWith('/stream')) {
      const query = JSON.parse(String(init?.body))
      if (query.fromBlock === BASE_HEAD_BLOCK && options.headAvailable !== false) {
        return new Response(
          JSON.stringify({ header: { number: BASE_HEAD_BLOCK, timestamp: BASE_HEAD_TIMESTAMP } }) + '\n',
        )
      }
      const exactBoundary = options.exactBoundary
      if (exactBoundary !== undefined && query.fromBlock <= 1_000 && query.toBlock >= 1_000) {
        const records = [999, 1_000, 1_001]
          .filter((number) => number >= query.fromBlock && number <= query.toBlock)
          .map((number) => ({ header: { number, timestamp: exactBoundary + (number - 1_000) * 2 } }))
        return new Response(records.map((record) => JSON.stringify(record)).join('\n') + '\n')
      }
      return new Response('')
    }
    throw new Error(`Unexpected mocked Portal URL: ${url}`)
  }
}

describe('Base cadence estimates', () => {
  it('uses 200ms canonical blocks on both upgraded Base networks', () => {
    assert.equal(estimateBlockTime('base-mainnet', 'evm'), 0.2)
    assert.equal(estimateBlockTime('base-sepolia', 'evm'), 0.2)
    assert.equal(estimateBlockTime('base-custom', 'evm'), 2)
  })

  it('keeps exact historical timestamp boundaries across Denim', async () => {
    const target = BASE_DENIM_TIMESTAMP - 3_600
    mockBaseTimestamps({ exactBoundary: target })
    const result = await resolveBlockAtTimestamp('base-mainnet', target, {
      boundary: 'from',
      headBlock: BASE_HEAD_BLOCK,
      headTimestamp: BASE_HEAD_TIMESTAMP,
      verificationRetries: 0,
    })
    assert.equal(result.resolution, 'verified_boundary')
    assert.equal(result.block_number, 1_000)
  })

  it('keeps verified historical timeframe windows across Denim', async () => {
    mockBaseTimestamps({ exactBoundary: BASE_HEAD_TIMESTAMP - 30 * 86_400 })
    const result = await resolveTimeframeOrBlocks({ dataset: 'base-mainnet', timeframe: '30d' })
    assert.equal(result.from_block, 1_000)
    assert.equal(result.from_lookup?.resolution, 'verified_boundary')
    assert.equal(result.estimated_timeframe, undefined)
  })

  it('estimates recent Sepolia windows at the current cadence when exact lookup is unavailable', async () => {
    mockBaseTimestamps()
    const result = await resolveTimeframeOrBlocks({ dataset: 'base-sepolia', timeframe: '15m' })
    assert.equal(result.estimated_timeframe?.estimated_block_time_seconds, 0.2)
    assert.equal(result.to_block - result.from_block + 1, 4_500)
  })

  it('refuses estimated windows across Denim even after the timestamp failure cache activates', async () => {
    mockBaseTimestamps()
    for (let attempt = 0; attempt < 4; attempt++) {
      await assert.rejects(
        resolveTimeframeOrBlocks({ dataset: 'base-mainnet', timeframe: '30d' }),
        /cannot estimate.*Denim/i,
      )
    }
    const recent = await resolveTimeframeOrBlocks({ dataset: 'base-mainnet', timeframe: '15m' })
    assert.equal(recent.to_block - recent.from_block + 1, 4_500)
  })

  it('refuses an estimated historical timestamp across the cadence upgrade', async () => {
    mockBaseTimestamps()
    await assert.rejects(
      resolveBlockAtTimestamp('base-mainnet', BASE_DENIM_TIMESTAMP - 3_600, {
        headBlock: BASE_HEAD_BLOCK,
        headTimestamp: BASE_HEAD_TIMESTAMP,
        verificationRetries: 0,
      }),
      /cannot estimate.*Denim/i,
    )
  })

  it('refuses estimates reaching before the separate Sepolia activation', async () => {
    mockBaseTimestamps()
    await assert.rejects(
      resolveBlockAtTimestamp('base-sepolia', 1_792_605_600 - 3_600, {
        headBlock: BASE_HEAD_BLOCK,
        headTimestamp: BASE_HEAD_TIMESTAMP,
        verificationRetries: 0,
      }),
      /cannot estimate.*Denim/i,
    )
  })

  it('does not estimate a Base timeframe without a verified indexed head timestamp', async () => {
    mockBaseTimestamps({ headAvailable: false })
    await assert.rejects(
      resolveTimeframeOrBlocks({ dataset: 'base-mainnet', timeframe: '15m' }),
      /indexed head timestamp/i,
    )
  })
})
