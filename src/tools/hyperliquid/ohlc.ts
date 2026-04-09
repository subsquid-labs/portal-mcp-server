import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp } from '../../helpers/formatting.js'
import { buildQueryFreshness } from '../../helpers/result-metadata.js'
import { parseTimeframeToSeconds, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { visitHyperliquidFillBlocks } from './fill-stream.js'

type OhlcDuration = '1h' | '6h' | '12h' | '24h' | '7d' | '30d'
type OhlcInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '6h' | '1d'
type OhlcIntervalInput = OhlcInterval | 'auto'

type HyperliquidFill = Record<string, unknown> & {
  time?: number | string
  fillIndex?: number | string
  px?: number | string
  sz?: number | string
}

type CandleAccumulator = {
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number
  base_volume: number
  fill_count: number
  notional_sum: number
}

const AUTO_INTERVAL_BY_DURATION: Record<OhlcDuration, OhlcInterval> = {
  '1h': '5m',
  '6h': '15m',
  '12h': '30m',
  '24h': '1h',
  '7d': '6h',
  '30d': '1d',
}

function getFillIndex(fill: HyperliquidFill): number {
  if (typeof fill.fillIndex === 'number' && Number.isFinite(fill.fillIndex)) {
    return fill.fillIndex
  }

  if (typeof fill.fillIndex === 'string') {
    const parsed = Number(fill.fillIndex)
    if (Number.isFinite(parsed)) return parsed
  }

  return 0
}

function toMilliseconds(timestamp: number | string | undefined): number {
  const numeric = Number(timestamp ?? 0)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  if (numeric > 1e12) return Math.floor(numeric)
  return Math.floor(numeric * 1000)
}

function toSeconds(timestamp: number | string | undefined): number {
  const milliseconds = toMilliseconds(timestamp)
  return milliseconds > 0 ? Math.floor(milliseconds / 1000) : 0
}

function sortFillsForOhlc(fills: HyperliquidFill[]): HyperliquidFill[] {
  return fills.slice().sort((left, right) => {
    const leftTime = toMilliseconds(left.time)
    const rightTime = toMilliseconds(right.time)
    if (leftTime !== rightTime) return leftTime - rightTime

    const leftIndex = getFillIndex(left)
    const rightIndex = getFillIndex(right)
    if (leftIndex !== rightIndex) return leftIndex - rightIndex

    return 0
  })
}

function getOrCreateBucket(
  buckets: Map<number, CandleAccumulator>,
  bucketTimestamp: number,
): CandleAccumulator {
  let bucket = buckets.get(bucketTimestamp)
  if (!bucket) {
    bucket = {
      open: null,
      high: null,
      low: null,
      close: null,
      volume: 0,
      base_volume: 0,
      fill_count: 0,
      notional_sum: 0,
    }
    buckets.set(bucketTimestamp, bucket)
  }
  return bucket
}

function resolveOhlcInterval(duration: OhlcDuration, requestedInterval: OhlcIntervalInput): OhlcInterval {
  if (requestedInterval === 'auto') {
    return AUTO_INTERVAL_BY_DURATION[duration]
  }

  return requestedInterval
}

export function registerHyperliquidOhlcTool(server: McpServer) {
  server.tool(
    'portal_hyperliquid_ohlc',
    `Build trade OHLC candles from Hyperliquid fills. Returns fixed buckets with open, high, low, close, volume, and VWAP for one coin.

WHEN TO USE:
- "Show me BTC candles on Hyperliquid for the last hour"
- "Give me ETH OHLC over the last 24h"
- "Chart SOL trade candles for one trader"

NOTES:
- This is trade-fill OHLC, not oracle or orderbook OHLC.
- Empty intervals are returned with null OHLC values and zero volume.
- Requires a single coin symbol for a clean candle series.`,
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Dataset name (default: 'hyperliquid-fills')"),
      coin: z.string().describe('Asset symbol to build candles for (for example: "BTC", "ETH", "SOL")'),
      interval: z
        .enum(['auto', '1m', '5m', '15m', '30m', '1h', '4h', '6h', '1d'])
        .optional()
        .default('auto')
        .describe('Candle interval. Use auto for chart-friendly defaults: 1h→5m, 6h→15m, 12h→30m, 24h→1h.'),
      duration: z
        .enum(['1h', '6h', '12h', '24h', '7d', '30d'])
        .optional()
        .default('1h')
        .describe('How much recent trading history to cover'),
      user: z.string().optional().describe('Optional trader wallet address (0x-prefixed, lowercase)'),
    },
    async ({ dataset, coin, interval, duration, user }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const resolvedInterval = resolveOhlcInterval(duration as OhlcDuration, interval as OhlcIntervalInput)

      const resolvedWindow = await resolveTimeframeOrBlocks({
        dataset,
        timeframe: duration,
      })
      const fromBlock = resolvedWindow.from_block

      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        fromBlock,
        resolvedWindow.to_block ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const intervalSeconds = parseTimeframeToSeconds(resolvedInterval)
      const durationSeconds = parseTimeframeToSeconds(duration)
      const expectedBuckets = Math.max(1, Math.ceil(durationSeconds / intervalSeconds))
      const buckets = new Map<number, CandleAccumulator>()
      let latestTimestamp = 0
      let earliestTimestamp = Number.MAX_SAFE_INTEGER
      let earliestObservedBlock = endBlock
      let totalFills = 0
      let totalVolume = 0
      let totalBaseVolume = 0
      let chunksFetched = 0
      let chunkSizeReduced = false
      let scannedFromBlock = fromBlock

      const fillFilter: Record<string, unknown> = {
        coin: [coin],
        ...(user ? { user: [user.toLowerCase()] } : {}),
      }
      const fillFields = {
        time: true,
        fillIndex: true,
        px: true,
        sz: true,
      }

      const accumulateRange = async (rangeFrom: number, rangeTo: number) => {
        const result = await visitHyperliquidFillBlocks({
          dataset,
          fromBlock: rangeFrom,
          toBlock: rangeTo,
          fillFilter,
          fillFields,
          maxBytes: 150 * 1024 * 1024,
          concurrency: 1,
          onBlock: (block) => {
            const blockNumber = typeof block.header?.number === 'number' ? block.header.number : undefined
            const fills = sortFillsForOhlc((block.fills || []) as HyperliquidFill[])
            for (let index = 0; index < fills.length; index += 1) {
              const fill = fills[index]
              const timestamp = toSeconds(fill.time)
              const price = Number(fill.px ?? 0)
              const size = Number(fill.sz ?? 0)

              if (!timestamp || !Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
                continue
              }

              latestTimestamp = Math.max(latestTimestamp, timestamp)
              earliestTimestamp = Math.min(earliestTimestamp, timestamp)
              if (blockNumber !== undefined) {
                earliestObservedBlock = Math.min(earliestObservedBlock, blockNumber)
              }
              totalFills += 1

              const bucketTimestamp = Math.floor(timestamp / intervalSeconds) * intervalSeconds
              const bucket = getOrCreateBucket(buckets, bucketTimestamp)
              const notional = price * size

              if (bucket.open === null) bucket.open = price
              bucket.high = bucket.high === null ? price : Math.max(bucket.high, price)
              bucket.low = bucket.low === null ? price : Math.min(bucket.low, price)
              bucket.close = price
              bucket.volume += notional
              bucket.base_volume += size
              bucket.fill_count += 1
              bucket.notional_sum += notional

              totalVolume += notional
              totalBaseVolume += size
            }
          },
        })

        chunksFetched += result.chunksFetched
        chunkSizeReduced = chunkSizeReduced || result.chunkSizeReduced
      }

      await accumulateRange(fromBlock, endBlock)

      if (latestTimestamp === 0 || totalFills === 0) {
        throw new Error(`No Hyperliquid fills found for ${coin}${user ? ` and user ${user}` : ''} in the requested window`)
      }

      const seriesEndExclusive = Math.floor(latestTimestamp / intervalSeconds) * intervalSeconds + intervalSeconds
      const seriesStartTimestamp = seriesEndExclusive - durationSeconds

      let backfillAttempts = 0
      while (earliestTimestamp > seriesStartTimestamp && scannedFromBlock > 0 && backfillAttempts < 8) {
        const observedSeconds = Math.max(1, latestTimestamp - earliestTimestamp)
        const observedBlocks = Math.max(1, endBlock - earliestObservedBlock + 1)
        const missingSeconds = earliestTimestamp - seriesStartTimestamp
        const estimatedBlocksNeeded = Math.ceil((observedBlocks / observedSeconds) * missingSeconds * 2)
        const extensionSize = Math.max(25_000, estimatedBlocksNeeded)
        const extensionFromBlock = Math.max(0, scannedFromBlock - extensionSize)

        if (extensionFromBlock >= scannedFromBlock) {
          break
        }

        await accumulateRange(extensionFromBlock, scannedFromBlock - 1)
        scannedFromBlock = extensionFromBlock
        backfillAttempts += 1
      }

      const ohlc = Array.from({ length: expectedBuckets }, (_, bucketIndex) => {
        const bucketTimestamp = seriesStartTimestamp + bucketIndex * intervalSeconds
        const bucket = buckets.get(bucketTimestamp)
        const vwap = bucket && bucket.base_volume > 0 ? bucket.notional_sum / bucket.base_volume : null

        return {
          bucket_index: bucketIndex,
          timestamp: bucketTimestamp,
          timestamp_human: formatTimestamp(bucketTimestamp),
          open: bucket?.open === null || bucket?.open === undefined ? null : parseFloat(bucket.open.toFixed(6)),
          high: bucket?.high === null || bucket?.high === undefined ? null : parseFloat(bucket.high.toFixed(6)),
          low: bucket?.low === null || bucket?.low === undefined ? null : parseFloat(bucket.low.toFixed(6)),
          close: bucket?.close === null || bucket?.close === undefined ? null : parseFloat(bucket.close.toFixed(6)),
          volume: bucket ? parseFloat(bucket.volume.toFixed(2)) : 0,
          base_volume: bucket ? parseFloat(bucket.base_volume.toFixed(6)) : 0,
          vwap: vwap === null ? null : parseFloat(vwap.toFixed(6)),
          fill_count: bucket?.fill_count ?? 0,
        }
      })

      const filledBuckets = ohlc.filter((bucket) => bucket.fill_count > 0).length
      const firstFilledCandle = ohlc.find((bucket) => bucket.fill_count > 0)
      const lastFilledCandle = [...ohlc].reverse().find((bucket) => bucket.fill_count > 0)

        const summary = {
        coin,
        interval: resolvedInterval,
        interval_requested: interval,
        duration,
        total_buckets: ohlc.length,
        filled_buckets: filledBuckets,
        empty_buckets: ohlc.length - filledBuckets,
        total_fills: totalFills,
        total_volume: parseFloat(totalVolume.toFixed(2)),
        total_base_volume: parseFloat(totalBaseVolume.toFixed(6)),
        from_block: scannedFromBlock,
        to_block: endBlock,
        latest_fill_timestamp: latestTimestamp,
        latest_fill_timestamp_human: formatTimestamp(latestTimestamp),
        ...(user ? { filtered_user: user.toLowerCase() } : {}),
        ...(firstFilledCandle ? { series_open: firstFilledCandle.open } : {}),
        ...(lastFilledCandle ? { series_close: lastFilledCandle.close } : {}),
        ...(chunksFetched > 1 ? { chunks_fetched: chunksFetched } : {}),
        ...(chunkSizeReduced ? { chunk_size_reduced: true } : {}),
        ...(backfillAttempts > 0 ? { backfill_attempts: backfillAttempts } : {}),
      }

      const freshness = buildQueryFreshness({
        finality: 'latest',
        headBlockNumber: head.number,
        windowToBlock: endBlock,
        resolvedWindow,
      })

      return formatResult(
        {
          summary,
          chart: {
            kind: 'candlestick',
            volume_panel: true,
            x_field: 'timestamp',
            candle_fields: {
              open: 'open',
              high: 'high',
              low: 'low',
              close: 'close',
            },
            volume_field: 'volume',
            interval: resolvedInterval,
            total_candles: ohlc.length,
          },
          ohlc,
        },
        `Built ${resolvedInterval} ${coin} Hyperliquid candles over ${duration}. ${filledBuckets}/${ohlc.length} buckets contain trades.`,
        {
          freshness,
          coverage: {
            kind: 'bucket_window',
            window_complete: true,
            expected_buckets: expectedBuckets,
            returned_buckets: ohlc.length,
            filled_buckets: filledBuckets,
            empty_buckets: ohlc.length - filledBuckets,
            anchor: 'latest_fill',
          },
          metadata: {
            dataset,
            from_block: scannedFromBlock,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
