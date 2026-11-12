import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ActionableError } from '../../helpers/errors.js'
import { parseTimeframeToSeconds } from '../../helpers/timeframe.js'
import {
  MAX_SERIES_SCAN_BLOCKS,
  assertSeriesDurationScannable,
  assertSeriesWindowScannable,
  resolveSeriesWindow,
} from './time-series.js'

/*
 * Bound series scans by block count because the same duration spans different
 * amounts of data on different networks.
 */
const window = (dataset: string, chainType: string, blocks: number, duration: string) =>
  assertSeriesWindowScannable({ dataset, chainType, fromBlock: 1, toBlock: blocks, duration })

describe('a series window that cannot be read is refused, not attempted', () => {
  it('lets a window at the ceiling through', () => {
    window('base-mainnet', 'evm', MAX_SERIES_SCAN_BLOCKS, '6h')
  })

  it('refuses one block past it', () => {
    assert.throws(() => window('base-mainnet', 'evm', MAX_SERIES_SCAN_BLOCKS + 1, '6h'), ActionableError)
  })

  it('refuses the seven-day window that used to hang, and says why', () => {
    assert.throws(
      () => window('base-mainnet', 'evm', 3_024_000, '7d'),
      (error: unknown) => {
        assert.ok(error instanceof ActionableError)
        assert.match(error.message, /3,024,000 blocks on base-mainnet/)
        assert.match(error.message, /reads every block in the window/)
        assert.equal(error.code, 'unsupported_operation')
        assert.equal(error.origin, 'client_input')
        assert.equal(error.retryable, false, 'retrying the same request cannot help')
        return true
      },
    )
  })

  it('suggests a shorter Base chart when an hour exceeds the block cap', () => {
    assert.throws(
      () => window('base-mainnet', 'evm', 18_002, '1h'),
      (error: unknown) => {
        assert.ok(error instanceof ActionableError)
        assert.match(error.suggestions[0], /duration '30m'.*roughly 40 minutes/)
        assert.match(error.suggestions[1], /from_timestamp and to_timestamp/)
        assert.equal(error.context?.largest_supported_duration, '30m')
        return true
      },
    )
  })

  it('carries the numbers a caller needs to pick a smaller window', () => {
    assert.throws(
      () => window('base-mainnet', 'evm', 3_024_000, '7d'),
      (error: unknown) => {
        assert.ok(error instanceof ActionableError)
        assert.equal(error.context?.requested_blocks, 3_024_000)
        assert.equal(error.context?.max_scan_blocks, MAX_SERIES_SCAN_BLOCKS)
        assert.equal(error.context?.requested_duration, '7d')
        return true
      },
    )
  })

  it('is a limit on blocks, not on time: the same window passes on a slow chain', () => {
    window('bitcoin-mainnet', 'bitcoin', 1_008, '7d')
    assert.throws(() => window('base-mainnet', 'evm', 3_024_000, '7d'), ActionableError)
  })

  it('lets a 24h Ethereum window through and stops a 24h Base one', () => {
    window('ethereum-mainnet', 'evm', 7_200, '24h')
    assert.throws(() => window('base-mainnet', 'evm', 432_000, '24h'), ActionableError)
  })
})

/*
 * Reject clearly oversized durations before timestamp lookups. Use the exact
 * block count when the estimate is close to the limit.
 */
describe('assertSeriesDurationScannable', () => {
  it('refuses a window far over the bound before any lookup, and says the count is an estimate', () => {
    assert.throws(
      () => assertSeriesDurationScannable({ dataset: 'base-mainnet', chainType: 'evm', duration: '7d' }),
      (error: any) =>
        error instanceof ActionableError &&
        /about 3,024,000 blocks on base-mainnet by its typical block time/.test(error.message) &&
        error.context?.requested_blocks_estimated === true,
    )
  })

  it('leaves a window under the bound, and a borderline one, to the exact check', () => {
    assert.doesNotThrow(() =>
      assertSeriesDurationScannable({ dataset: 'ethereum-mainnet', chainType: 'evm', duration: '24h' }),
    )
    assert.doesNotThrow(() =>
      assertSeriesDurationScannable({ dataset: 'bitcoin-mainnet', chainType: 'bitcoin', duration: '30d' }),
    )
    // 16,200 blocks by estimate: over the bound, but under the margin the estimate is trusted for.
    assert.doesNotThrow(() =>
      assertSeriesDurationScannable({ dataset: 'ethereum-mainnet', chainType: 'evm', duration: '54h' }),
    )
  })

  it('does not refuse what it cannot parse; the exact check will see it', () => {
    assert.doesNotThrow(() =>
      assertSeriesDurationScannable({ dataset: 'base-mainnet', chainType: 'evm', duration: 'whenever' }),
    )
  })
})

/*
 * A timestamp window sets the series span. Bucketing it against a duration
 * pulled in blocks from before the window or dropped its older blocks.
 */
describe('resolveSeriesWindow', () => {
  const now = 1_794_400_000

  it('spans a 30 minute timestamp window, not the 6h default', () => {
    const window = resolveSeriesWindow({
      dataset: 'base-mainnet',
      from_timestamp: now - 2_400,
      to_timestamp: now - 600,
      nowUnix: now,
    })
    assert.equal(parseTimeframeToSeconds(window.duration), 1_800)
    assert.equal(window.windowLabel, '2026-11-11 11:46:40 UTC to 2026-11-11 12:16:40 UTC')
  })

  it('spans a 24h window in full', () => {
    const window = resolveSeriesWindow({ dataset: 'ethereum-mainnet', from_timestamp: '24h ago', nowUnix: now })
    assert.equal(window.duration, '1d')
  })

  it('lets the timestamps win over a duration that would reach outside them', () => {
    const window = resolveSeriesWindow({
      dataset: 'ethereum-mainnet',
      requestedDuration: '6h',
      from_timestamp: '2h ago',
      to_timestamp: 'now',
      nowUnix: now,
    })
    assert.equal(window.duration, '2h')
  })

  it('keeps an explicit duration and the defaults', () => {
    assert.equal(resolveSeriesWindow({ dataset: 'base-mainnet', requestedDuration: '1h' }).duration, '1h')
    assert.deepEqual(resolveSeriesWindow({ dataset: 'base-mainnet' }), { duration: '15m' })
    assert.deepEqual(resolveSeriesWindow({ dataset: 'ethereum-mainnet' }), { duration: '6h' })
  })

  it('leaves an unreadable timestamp to the window resolver', () => {
    assert.deepEqual(resolveSeriesWindow({ dataset: 'ethereum-mainnet', from_timestamp: 'not a time' }), {
      duration: '6h',
    })
  })
})
