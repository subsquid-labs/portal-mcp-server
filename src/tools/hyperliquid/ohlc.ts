import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { buildCandlestickChart, buildOhlcTable, type ChartTooltipDescriptor } from '../../helpers/chart-metadata.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp } from '../../helpers/formatting.js'
import { buildBucketCoverage, buildBucketGapDiagnostics, buildChronologicalPageOrdering, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { buildPaginationInfo, decodeCursor, encodeCursor } from '../../helpers/pagination.js'
import { estimateBlockTime, parseTimeframeToSeconds, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { buildChartPanel, buildMetricCard, buildPortalUi, buildTablePanel } from '../../helpers/ui-metadata.js'
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

type HyperliquidOhlcCursor = {
  tool: 'portal_hyperliquid_get_ohlc'
  dataset: string
  request: {
    coin: string
    interval: OhlcIntervalInput
    duration: OhlcDuration
    user?: string
  }
  window_start_timestamp: number
  window_end_exclusive: number
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
    'portal_hyperliquid_get_ohlc',
    buildToolDescription('portal_hyperliquid_get_ohlc'),
    {
      network: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Network name (default: 'hyperliquid-fills')"),
      coin: z.string().optional().describe('Asset symbol to build candles for (for example: "BTC", "ETH", "SOL"). Optional when continuing with cursor.'),
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
      cursor: z.string().optional().describe('Continuation cursor from a previous candle page'),
    },
    async ({ network, coin, interval, duration, user, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeCursor<HyperliquidOhlcCursor>(cursor, 'portal_hyperliquid_get_ohlc')
        : undefined
      const requestedDataset = cursor ? (network ? await resolveDataset(network) : undefined) : await resolveDataset(network)
      const effectiveDataset = paginationCursor?.dataset ?? requestedDataset
      if (!effectiveDataset) {
        throw new Error('network is required unless you are continuing with cursor')
      }
      let dataset = effectiveDataset
      if (paginationCursor && requestedDataset && requestedDataset !== paginationCursor.dataset) {
        throw new Error('This cursor belongs to a different network. Reuse the same network or omit cursor to start a fresh candle window.')
      }

      coin = paginationCursor?.request.coin ?? coin
      interval = paginationCursor?.request.interval ?? interval
      duration = paginationCursor?.request.duration ?? duration
      user = paginationCursor?.request.user ?? user
      if (!coin) {
        throw new Error('coin is required unless you are continuing with cursor')
      }

      const resolvedInterval = resolveOhlcInterval(duration as OhlcDuration, interval as OhlcIntervalInput)

      const intervalSeconds = parseTimeframeToSeconds(resolvedInterval)
      const durationSeconds = parseTimeframeToSeconds(duration)
      const expectedBuckets = Math.max(1, Math.ceil(durationSeconds / intervalSeconds))
      const buckets = new Map<number, CandleAccumulator>()
      let latestTimestamp = 0
      let earliestTimestamp = Number.MAX_SAFE_INTEGER
      let earliestObservedBelowPageEnd = Number.MAX_SAFE_INTEGER
      let earliestObservedBlock = Number.MAX_SAFE_INTEGER
      let totalFills = 0
      let totalVolume = 0
      let totalBaseVolume = 0
      let chunksFetched = 0
      let chunkSizeReduced = false
      let scannedFromBlock = 0
      let seriesStartTimestamp = 0
      let seriesEndExclusive = 0
      let resolvedWindow
      let endBlock = 0
      let head

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

      const accumulateRange = async (rangeFrom: number, rangeTo: number, options?: { pageEndExclusive?: number; pageStartTimestamp?: number }) => {
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

              if (options?.pageEndExclusive !== undefined && timestamp >= options.pageEndExclusive) {
                continue
              }

              earliestObservedBelowPageEnd = Math.min(earliestObservedBelowPageEnd, timestamp)
              if (blockNumber !== undefined) {
                earliestObservedBlock = Math.min(earliestObservedBlock, blockNumber)
              }

              if (options?.pageStartTimestamp !== undefined && timestamp < options.pageStartTimestamp) {
                continue
              }

              latestTimestamp = Math.max(latestTimestamp, timestamp)
              earliestTimestamp = Math.min(earliestTimestamp, timestamp)
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

      if (paginationCursor) {
        seriesStartTimestamp = paginationCursor.window_start_timestamp
        seriesEndExclusive = paginationCursor.window_end_exclusive
        resolvedWindow = await resolveTimeframeOrBlocks({
          dataset,
          from_timestamp: seriesStartTimestamp,
          to_timestamp: Math.max(0, seriesEndExclusive - 1),
        })

        const estimatedBlocksPerSecond = 1 / estimateBlockTime(dataset, 'hyperliquidFills')
        const cushionBlocks = Math.max(25_000, Math.ceil(durationSeconds * estimatedBlocksPerSecond * 0.15))
        const rangeFrom = Math.max(0, resolvedWindow.from_block - cushionBlocks)
        const rangeTo = resolvedWindow.to_block + cushionBlocks

        const validated = await validateBlockRange(
          dataset,
          rangeFrom,
          rangeTo ?? Number.MAX_SAFE_INTEGER,
          false,
        )
        endBlock = validated.validatedToBlock
        head = validated.head
        scannedFromBlock = rangeFrom

        await accumulateRange(rangeFrom, endBlock, {
          pageStartTimestamp: seriesStartTimestamp,
          pageEndExclusive: seriesEndExclusive,
        })
      } else {
        resolvedWindow = await resolveTimeframeOrBlocks({
          dataset,
          timeframe: duration,
        })
        const fromBlock = resolvedWindow.from_block

        const validated = await validateBlockRange(
          dataset,
          fromBlock,
          resolvedWindow.to_block ?? Number.MAX_SAFE_INTEGER,
          false,
        )
        endBlock = validated.validatedToBlock
        head = validated.head
        scannedFromBlock = fromBlock

        await accumulateRange(fromBlock, endBlock)
      }

      if (latestTimestamp === 0 || totalFills === 0) {
        throw new Error(`No Hyperliquid fills found for ${coin}${user ? ` and user ${user}` : ''} in the requested window`)
      }

      if (!paginationCursor) {
        seriesEndExclusive = Math.floor(latestTimestamp / intervalSeconds) * intervalSeconds + intervalSeconds
        seriesStartTimestamp = seriesEndExclusive - durationSeconds
      }

      let backfillAttempts = 0
      while (earliestObservedBelowPageEnd > seriesStartTimestamp && scannedFromBlock > 0 && backfillAttempts < 8) {
        const observedSeconds = Math.max(1, Math.max(latestTimestamp, seriesEndExclusive - intervalSeconds) - earliestObservedBelowPageEnd)
        const observedBlocks = Math.max(1, endBlock - earliestObservedBlock + 1)
        const missingSeconds = earliestObservedBelowPageEnd - seriesStartTimestamp
        const estimatedBlocksNeeded = Math.ceil((observedBlocks / observedSeconds) * missingSeconds * 2)
        const extensionSize = Math.max(25_000, estimatedBlocksNeeded)
        const extensionFromBlock = Math.max(0, scannedFromBlock - extensionSize)

        if (extensionFromBlock >= scannedFromBlock) {
          break
        }

        await accumulateRange(extensionFromBlock, scannedFromBlock - 1, {
          ...(paginationCursor
            ? {
                pageStartTimestamp: seriesStartTimestamp,
                pageEndExclusive: seriesEndExclusive,
              }
            : {}),
        })
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
      const totalWindowFills = ohlc.reduce((sum, bucket) => sum + bucket.fill_count, 0)
      const totalWindowVolume = ohlc.reduce((sum, bucket) => sum + bucket.volume, 0)
      const totalWindowBaseVolume = ohlc.reduce((sum, bucket) => sum + bucket.base_volume, 0)
      const firstFilledCandle = ohlc.find((bucket) => bucket.fill_count > 0)
      const lastFilledCandle = [...ohlc].reverse().find((bucket) => bucket.fill_count > 0)
      const gapDiagnostics = buildBucketGapDiagnostics({
        buckets: ohlc,
        intervalSeconds,
        isFilled: (bucket) => bucket.fill_count > 0,
        anchor: 'latest_fill',
        windowComplete: earliestObservedBelowPageEnd <= seriesStartTimestamp,
        ...(earliestObservedBelowPageEnd !== Number.MAX_SAFE_INTEGER ? { firstObservedTimestamp: earliestObservedBelowPageEnd } : {}),
        ...(latestTimestamp > 0 ? { lastObservedTimestamp: latestTimestamp } : {}),
      })
      const nextCursor =
        seriesStartTimestamp > 0
          ? encodeCursor({
              tool: 'portal_hyperliquid_get_ohlc',
              dataset,
              request: {
                coin,
                interval,
                duration,
                ...(user ? { user: user.toLowerCase() } : {}),
              },
              window_start_timestamp: Math.max(0, seriesStartTimestamp - durationSeconds),
              window_end_exclusive: seriesStartTimestamp,
            })
          : undefined

      const summary = {
        coin,
        interval: resolvedInterval,
        interval_requested: interval,
        duration,
        total_buckets: ohlc.length,
        filled_buckets: filledBuckets,
        empty_buckets: ohlc.length - filledBuckets,
        total_fills: totalWindowFills,
        total_volume: parseFloat(totalWindowVolume.toFixed(2)),
        total_base_volume: parseFloat(totalWindowBaseVolume.toFixed(6)),
        from_block: scannedFromBlock,
        to_block: endBlock,
        latest_fill_timestamp: latestTimestamp,
        latest_fill_timestamp_human: formatTimestamp(latestTimestamp),
        window_start_timestamp: seriesStartTimestamp,
        window_start_timestamp_human: formatTimestamp(seriesStartTimestamp),
        window_end_exclusive: seriesEndExclusive,
        window_end_exclusive_human: formatTimestamp(Math.max(seriesStartTimestamp, seriesEndExclusive - 1)),
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

      const chartTooltip: ChartTooltipDescriptor = {
        mode: 'axis',
        title_field: 'timestamp_human',
        title_label: 'Time',
        title_format: 'timestamp_human',
        fields: [
          { key: 'open', label: 'Open', format: 'decimal', emphasis: 'primary' },
          { key: 'high', label: 'High', format: 'decimal' },
          { key: 'low', label: 'Low', format: 'decimal' },
          { key: 'close', label: 'Close', format: 'decimal', emphasis: 'primary' },
          { key: 'volume', label: 'Volume', format: 'currency_usd', unit: 'USD' },
          { key: 'base_volume', label: `${coin} size`, format: 'decimal', unit: coin },
          { key: 'fill_count', label: 'Fills', format: 'integer' },
          { key: 'vwap', label: 'VWAP', format: 'decimal' },
        ],
      }

      const ui = buildPortalUi({
        version: 'portal_ui_v1',
        layout: 'chart_focus',
        density: 'compact',
        design_intent: 'market_terminal',
        headline: {
          title: `${coin} Hyperliquid candles`,
          subtitle: `${resolvedInterval} candles over ${duration}${user ? ` for ${user.toLowerCase()}` : ''}`,
        },
        metric_cards: [
          buildMetricCard({ id: 'last_close', label: 'Last close', value_path: 'summary.series_close', format: 'decimal', emphasis: 'primary' }),
          buildMetricCard({ id: 'volume', label: 'Volume', value_path: 'summary.total_volume', format: 'currency_usd', unit: 'USD' }),
          buildMetricCard({ id: 'fills', label: 'Fills', value_path: 'summary.total_fills', format: 'integer' }),
          buildMetricCard({ id: 'filled_buckets', label: 'Filled buckets', value_path: 'summary.filled_buckets', format: 'integer' }),
        ],
        panels: [
          buildChartPanel({
            id: 'candles',
            kind: 'chart_panel',
            title: `${coin} price action`,
            subtitle: 'Hover for OHLC, volume, fills, and VWAP. Drag horizontally to zoom.',
            chart_key: 'chart',
            emphasis: 'primary',
          }),
          buildTablePanel({
            id: 'ohlc-table',
            kind: 'table_panel',
            title: 'Candle table',
            subtitle: 'Each bucket with OHLC, USD volume, and fill count.',
            table_id: 'ohlc',
          }),
        ],
        follow_up_actions: [
          ...(nextCursor ? [{ label: 'Load older candles', intent: 'continue' as const, target: '_pagination.next_cursor' }] : []),
          { label: 'Show raw candle rows', intent: 'show_raw', target: 'ohlc' },
          { label: 'Zoom into the latest move', intent: 'zoom_in', target: 'chart' },
        ],
      })

      return formatResult(
        {
          summary,
          chart: buildCandlestickChart({
            dataKey: 'ohlc',
            interval: resolvedInterval,
            totalCandles: ohlc.length,
            title: `${coin} Hyperliquid candles`,
            subtitle: 'Interactive OHLC chart with hover labels, zoom, and candle table',
            volumePanel: true,
            volumeField: 'volume',
            volumeUnit: 'USD',
            tooltip: chartTooltip,
          }),
          tables: [
            buildOhlcTable({
              id: 'ohlc',
              rowCount: ohlc.length,
              title: `${coin} candle table`,
              subtitle: 'Bucket-aligned OHLC candles with USD volume and fill counts available in the rows',
              volumeField: 'volume',
              volumeLabel: 'Volume',
              volumeUnit: 'USD',
            }),
          ],
          gap_diagnostics: gapDiagnostics,
          ohlc,
        },
        `Built ${resolvedInterval} ${coin} Hyperliquid candles over ${duration}. ${filledBuckets}/${ohlc.length} buckets contain trades.`,
        {
          toolName: 'portal_hyperliquid_get_ohlc',
          ...(nextCursor ? { notices: ['Older candles are available via _pagination.next_cursor.'] } : {}),
          pagination: buildPaginationInfo(expectedBuckets, ohlc.length, nextCursor),
          ordering: buildChronologicalPageOrdering({
            sortedBy: 'timestamp',
            continuation: nextCursor ? 'older' : 'none',
          }),
          freshness,
          execution: buildExecutionMetadata({
            interval: resolvedInterval,
            duration,
            from_block: scannedFromBlock,
            to_block: endBlock,
            range_kind: resolvedWindow.range_kind,
          }),
          ui,
          llm: {
            answer_sequence: ['summary.series_close', 'summary.total_volume', 'summary.total_fills', 'summary.filled_buckets', 'ohlc'],
            parser_notes: [
              'Use summary.series_close as the headline price and primary_preview as the latest candle instead of scanning the whole ohlc array.',
              'Check _coverage and gap_diagnostics before claiming the candle window is fully filled.',
            ],
          },
          coverage: buildBucketCoverage({
            expectedBuckets,
            returnedBuckets: ohlc.length,
            filledBuckets,
            anchor: 'latest_fill',
            windowComplete: earliestObservedBelowPageEnd <= seriesStartTimestamp,
          }),
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
