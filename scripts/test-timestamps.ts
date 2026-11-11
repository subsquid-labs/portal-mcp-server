#!/usr/bin/env tsx

import { getBlockHead, getDatasets } from '../dist/cache/datasets.js'
import { detectChainType } from '../dist/helpers/chain.js'
import { buildQueryFreshness } from '../dist/helpers/result-metadata.js'
import {
  getBlockTimestamp,
  getHeadTimestamp,
  getTimestampWindowNotices,
  parseTimeframeToSeconds,
  parseTimestampInput,
  resolveBlockAtTimestamp,
  resolveTimeframeOrBlocks,
  timestampToBlock,
} from '../dist/helpers/timeframe.js'
import { retryPortalProbe } from './live-portal-probe.js'

const REALTIME_MATRIX_CONCURRENCY = 2

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function assertRealtimeTimestampMatrix() {
  const datasets = await retryPortalProbe('real-time dataset catalog', () => getDatasets())
  const realtimeDatasets = datasets.filter((dataset) => dataset.real_time)

  const rows = await mapLimit(realtimeDatasets, REALTIME_MATRIX_CONCURRENCY, (dataset) =>
    retryPortalProbe(`${dataset.dataset} real-time timestamp matrix`, async () => {
      const head = await getBlockHead(dataset.dataset)
      const headTimestamp = await getHeadTimestamp(dataset.dataset, head.number, 0)
      const window = await resolveTimeframeOrBlocks({ dataset: dataset.dataset, timeframe: '1h' })

      assert(
        Number.isFinite(headTimestamp) && headTimestamp > 1_000_000_000,
        `${dataset.dataset} should expose a latest block timestamp`,
      )
      assert(window.to_block === head.number, `${dataset.dataset} 1h window should anchor to the latest indexed head`)
      assert(window.from_block <= window.to_block, `${dataset.dataset} 1h window should be ordered`)

      return {
        dataset: dataset.dataset,
        kind: dataset.metadata?.kind ?? 'unknown',
        head: head.number,
        headTimestamp,
        fromBlock: window.from_block,
        toBlock: window.to_block,
      }
    }),
  )

  const byKind = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.kind] = (acc[row.kind] ?? 0) + 1
    return acc
  }, {})

  console.log(
    `PASS  real-time timestamp matrix -> ${rows.length} datasets (${Object.entries(byKind)
      .map(([kind, count]) => `${kind}:${count}`)
      .join(', ')})`,
  )
}

async function assertHyperliquidFillsExactTimestampLookup() {
  const dataset = 'hyperliquid-fills'
  const head = await retryPortalProbe(`${dataset} indexed head`, () => getBlockHead(dataset))
  const headTimestamp = await retryPortalProbe(`${dataset} head timestamp`, () =>
    getHeadTimestamp(dataset, head.number, 0),
  )
  assert(
    Number.isFinite(headTimestamp) && headTimestamp > 1_000_000_000,
    'Hyperliquid fills head timestamp should resolve from block.timestamp',
  )

  const targetTimestamp = headTimestamp - 300
  const exactProbeBlock = await retryPortalProbe('Hyperliquid fills timestamp', () =>
    timestampToBlock(dataset, targetTimestamp),
  )
  const fiveMinuteWindow = await retryPortalProbe(
    'Hyperliquid fills five-minute window',
    () => resolveTimeframeOrBlocks({ dataset, timeframe: '5m' }),
    { accept: (window) => window.from_lookup?.resolution === 'verified_boundary' },
  )

  assert(
    fiveMinuteWindow.to_block === head.number,
    '5m Hyperliquid fills window should anchor to the cached latest block',
  )
  assert(
    fiveMinuteWindow.from_block < fiveMinuteWindow.to_block,
    '5m Hyperliquid fills window should produce an ordered block range',
  )
  assert(
    fiveMinuteWindow.from_lookup?.resolution === 'verified_boundary',
    '5m Hyperliquid fills window should use a verified Portal timestamp boundary',
  )
  assert(
    fiveMinuteWindow.from_lookup.block_number === fiveMinuteWindow.from_block,
    '5m Hyperliquid fills lookup metadata should match the resolved window',
  )
  assert(
    fiveMinuteWindow.from_lookup.block_timestamp !== undefined &&
      fiveMinuteWindow.from_lookup.block_timestamp >= targetTimestamp,
    '5m Hyperliquid fills boundary should expose a verified block timestamp inside the requested window',
  )
  assert(exactProbeBlock <= head.number, 'Hyperliquid fills timestamp endpoint should return a block at or before head')

  const directLookup = await retryPortalProbe(
    'Hyperliquid fills direct timestamp lookup',
    () => resolveBlockAtTimestamp(dataset, targetTimestamp),
    { accept: (lookup) => lookup.resolution === 'verified_boundary' },
  )
  assert(
    directLookup.resolution === 'verified_boundary',
    'Hyperliquid fills timestamp lookup should use a verified indexed boundary',
  )
  assert(directLookup.block_number <= head.number, 'Hyperliquid fills direct lookup should not exceed indexed head')

  console.log(
    `PASS  Hyperliquid fills 5m window -> ${fiveMinuteWindow.from_block}..${fiveMinuteWindow.to_block} (verified boundary)`,
  )
}

async function assertSubstrateTimestampBoundaryIsVerified() {
  const dataset = 'polkadot'
  const head = await retryPortalProbe(`${dataset} indexed head`, () => getBlockHead(dataset))
  const headTimestamp = await retryPortalProbe(`${dataset} head timestamp`, () =>
    getHeadTimestamp(dataset, head.number, 0),
  )
  const fromTimestamp = headTimestamp - 3_600
  const toTimestamp = headTimestamp - 3_000
  const window = await retryPortalProbe('Polkadot timestamp window', () =>
    resolveTimeframeOrBlocks({
      dataset,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
    }),
  )

  assert(window.from_lookup?.resolution === 'verified_boundary', 'Polkadot from boundary should be verified')
  assert(window.to_lookup?.resolution === 'verified_boundary', 'Polkadot to boundary should be verified')
  assert(
    (window.from_lookup?.block_timestamp ?? 0) >= fromTimestamp,
    'Polkadot from block must not precede the requested timestamp',
  )
  assert(
    (window.to_lookup?.block_timestamp ?? Number.MAX_SAFE_INTEGER) <= toTimestamp,
    'Polkadot to block must not follow the requested timestamp',
  )

  const actualFrom = await retryPortalProbe('Polkadot direct from boundary', () =>
    getBlockTimestamp(dataset, window.from_block, { retries: 0 }),
  )
  const actualTo = await retryPortalProbe('Polkadot direct to boundary', () =>
    getBlockTimestamp(dataset, window.to_block, { retries: 0 }),
  )
  assert(actualFrom === window.from_lookup?.block_timestamp, 'Polkadot from metadata should match direct block data')
  assert(actualTo === window.to_lookup?.block_timestamp, 'Polkadot to metadata should match direct block data')

  console.log(`PASS  Polkadot verified window -> ${window.from_block}..${window.to_block}`)
}

async function assertFutureWindowFailsClosed() {
  const future = '2030-01-01T00:00:00Z'
  let rejected = false
  try {
    await retryPortalProbe('future timestamp rejection', () =>
      resolveTimeframeOrBlocks({
        dataset: 'base-mainnet',
        from_timestamp: future,
        to_timestamp: '2030-01-01T00:05:00Z',
      }),
    )
  } catch (error) {
    rejected = /after the latest indexed block/i.test(error instanceof Error ? error.message : String(error))
  }
  assert(rejected, 'Future timestamp windows should fail closed instead of returning current data')

  const dataset = 'base-mainnet'
  const head = await retryPortalProbe(`${dataset} indexed head`, () => getBlockHead(dataset))
  const headTimestamp = await retryPortalProbe(`${dataset} head timestamp`, () =>
    getHeadTimestamp(dataset, head.number, 0),
  )
  let nearHeadStartRejected = false
  try {
    await retryPortalProbe('near-head future timestamp rejection', () =>
      resolveTimeframeOrBlocks({ dataset, from_timestamp: headTimestamp + 30 }),
    )
  } catch (error) {
    nearHeadStartRejected = /start timestamp is after the latest indexed block/i.test(
      error instanceof Error ? error.message : String(error),
    )
  }
  assert(nearHeadStartRejected, 'A future from boundary inside normal head-lag tolerance must still fail closed')
  console.log('PASS  future timestamp window -> rejected before data query')
}

function assertNaturalLanguageTimeInputs() {
  const now = 1_778_923_600
  const cases: [string, number][] = [
    ['30m', 1_800],
    ['past 30 minutes', 1_800],
    ['in the past 1h', 3_600],
    ['in last 38 mins', 2_280],
    ['last hour', 3_600],
    ['over the previous 2 weeks', 1_209_600],
    ['30 minutes ago', 1_800],
  ]

  for (const [input, seconds] of cases) {
    assert(parseTimeframeToSeconds(input) === seconds, `${input} should parse as ${seconds} seconds`)

    const parsed = parseTimestampInput(input, now)
    assert(parsed.timestamp === now - seconds, `${input} should resolve to now minus ${seconds} seconds`)
    assert(parsed.source === 'relative', `${input} should be classified as a relative timestamp`)
  }

  assert(parseTimestampInput('last hour', now).normalized_input === '1h ago', 'last hour should normalize to 1h ago')
  assert(
    parseTimestampInput('in last 38 mins', now).normalized_input === '38m ago',
    'in last 38 mins should normalize to 38m ago',
  )

  console.log('PASS  natural-language time inputs -> past 30 minutes / in the past 1h / in last 38 mins')
}

async function assertHyperliquidReplicaExactTimestampLookup() {
  const dataset = 'hyperliquid-replica-cmds'
  const window = await retryPortalProbe(
    'Hyperliquid replica five-minute window',
    () => resolveTimeframeOrBlocks({ dataset, timeframe: '5m' }),
    { accept: (candidate) => candidate.from_lookup?.resolution === 'verified_boundary' },
  )
  assert(
    window.from_lookup?.resolution === 'verified_boundary',
    'Hyperliquid replica timeframe should use a verified timestamp boundary',
  )
  assert(window.from_lookup?.boundary === 'from', 'Hyperliquid replica timeframe should expose a from boundary')
  assert(
    (window.from_lookup?.block_timestamp ?? 0) >= window.from_lookup!.timestamp,
    'Hyperliquid replica from block must not precede the requested timestamp',
  )

  const freshness = buildQueryFreshness({
    finality: 'latest',
    headBlockNumber: window.to_block,
    windowToBlock: window.to_block,
    resolvedWindow: window,
  })
  assert(
    freshness.timestamp_bounds?.from?.resolution === 'verified_boundary',
    'Hyperliquid replica freshness should preserve verified timestamp provenance',
  )

  const notices = getTimestampWindowNotices(window)
  assert(
    !notices.some((notice) => /estimated/i.test(notice)),
    'Verified Hyperliquid replica windows should not claim estimation',
  )

  console.log(`PASS  Hyperliquid replica 5m window -> ${window.from_block}..${window.to_block} (verified boundary)`)
}

async function main() {
  console.log('Starting timestamp resolver QA...\n')

  assert(detectChainType('tron-mainnet') === 'tron', 'Tron should use its native Portal query type')
  assertNaturalLanguageTimeInputs()
  await assertHyperliquidReplicaExactTimestampLookup()

  const dataset = 'solana-mainnet'
  const head = await retryPortalProbe(`${dataset} indexed head`, () => getBlockHead(dataset))
  const headTimestamp = await retryPortalProbe(`${dataset} head timestamp`, () =>
    getHeadTimestamp(dataset, head.number, 0),
  )
  assert(
    Number.isFinite(headTimestamp) && headTimestamp > 1_000_000_000,
    'Solana head timestamp should resolve from block.timestamp',
  )

  const targetTimestamp = headTimestamp - 3600
  const exactFromBlock = await retryPortalProbe('Solana timestamp', () => timestampToBlock(dataset, targetTimestamp))
  const oneHourWindow = await retryPortalProbe(
    'Solana one-hour window',
    () => resolveTimeframeOrBlocks({ dataset, timeframe: '1h' }),
    { accept: (window) => window.from_lookup?.resolution === 'verified_boundary' },
  )

  assert(oneHourWindow.to_block === head.number, '1h Solana window should anchor to the cached latest slot')
  if (oneHourWindow.from_lookup?.resolution === 'verified_boundary') {
    assert(
      oneHourWindow.from_lookup.timestamp === targetTimestamp,
      '1h Solana lookup should be anchored to the resolved head timestamp',
    )
    assert(
      Math.abs(oneHourWindow.from_block - exactFromBlock) <= 50,
      '1h Solana timestamp lookup should stay within a small live-index tolerance',
    )
  } else {
    assert(
      oneHourWindow.estimated_timeframe?.resolution === 'estimated',
      'A transient Solana timestamp failure should expose estimated timeframe provenance',
    )
    assert(
      ['timestamp_endpoint_down', 'timestamp_endpoint_unavailable'].includes(
        oneHourWindow.estimated_timeframe?.reason ?? '',
      ),
      'A transient Solana timestamp fallback should explain why exact resolution was unavailable',
    )
    assert(
      oneHourWindow.estimated_timeframe?.dataset === dataset,
      'A transient Solana timestamp fallback should identify the source dataset',
    )
    assert(
      oneHourWindow.estimated_timeframe?.from_block === oneHourWindow.from_block &&
        oneHourWindow.estimated_timeframe?.to_block === oneHourWindow.to_block,
      'A transient Solana timestamp fallback should describe the exact returned block bounds',
    )
  }
  assert(oneHourWindow.from_block < oneHourWindow.to_block, '1h Solana window should produce an ordered slot range')
  console.log(`PASS  Solana 1h window -> ${oneHourWindow.from_block}..${oneHourWindow.to_block}`)

  const nowLookup = await retryPortalProbe('Solana current timestamp', () => resolveBlockAtTimestamp(dataset, 'now'))
  assert(
    ['verified_boundary', 'estimated'].includes(nowLookup.resolution),
    'Solana "now" lookup should resolve to a verified boundary or gracefully estimate from indexed head',
  )
  assert(nowLookup.block_number <= head.number, 'Solana "now" estimate should not exceed indexed head')
  if (nowLookup.resolution === 'estimated') {
    assert(nowLookup.head_timestamp === headTimestamp, 'Solana "now" estimate should use the resolved head timestamp')
  }
  console.log(`PASS  Solana now lookup -> ${nowLookup.block_number} (${nowLookup.resolution})`)

  await assertHyperliquidFillsExactTimestampLookup()
  await assertSubstrateTimestampBoundaryIsVerified()
  await assertFutureWindowFailsClosed()

  await assertRealtimeTimestampMatrix()

  console.log('\nTimestamp resolver QA passed')
}

main().catch((error) => {
  console.error('Timestamp resolver QA failed:', error)
  process.exit(1)
})
