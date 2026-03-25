import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp } from '../../helpers/formatting.js'
import { parseTimeframeToSeconds, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Hyperliquid Fill Time Series
// ============================================================================

/**
 * Aggregate Hyperliquid fills over time intervals for charting.
 * Shows trading activity trends: fill count, volume, unique traders over time.
 */
export function registerHyperliquidTimeSeriesFilsTool(server: McpServer) {
  server.tool(
    'portal_hyperliquid_time_series',
    `Aggregate Hyperliquid trading metrics over time intervals for charting. Track fill count, volume, and unique traders over time. Perfect for "show me BTC trading activity over the past 24h" questions.`,
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Dataset name (default: 'hyperliquid-fills')"),
      metric: z
        .enum(['fill_count', 'volume', 'unique_traders'])
        .describe("Metric: 'fill_count', 'volume' (notional USD), 'unique_traders'"),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval'),
      duration: z.enum(['1h', '6h', '24h', '7d']).describe('Total time period to analyze'),
      coin: z.array(z.string()).optional().describe('Filter by asset symbols (e.g., ["BTC", "ETH"])'),
      user: z.array(z.string()).optional().describe('Filter by trader addresses'),
    },
    async ({ dataset, metric, interval, duration, coin, user }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)

      const { from_block: fromBlock, to_block: toBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe: duration,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        fromBlock,
        toBlock ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const intervalSeconds = parseTimeframeToSeconds(interval)
      const durationSeconds = parseTimeframeToSeconds(duration)
      const expectedBuckets = Math.ceil(durationSeconds / intervalSeconds)

      // Build fill filter
      const fillFilter: Record<string, unknown> = {}
      if (coin) fillFilter.coin = coin
      if (user) fillFilter.user = user.map((u) => u.toLowerCase())

      const query = {
        type: 'hyperliquidFills',
        fromBlock,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          fill: {
            user: true,
            coin: true,
            px: true,
            sz: true,
            time: true,
          },
        },
        fills: [fillFilter],
      }

      const blockRange = endBlock - fromBlock
      const maxBlocks = Math.min(blockRange, 100000)
      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
        undefined,
        maxBlocks,
        100 * 1024 * 1024,
      )

      if (results.length === 0) {
        throw new Error('No data available for this time period')
      }

      // Extract all fills with timestamps (HL timestamps are in milliseconds)
      const allFills = results.flatMap((block: any) =>
        (block.fills || []).map((fill: any) => ({
          ...fill,
          // HL fill.time is in ms, convert to seconds for bucketing
          timestamp_s: Math.floor((fill.time || block.header?.timestamp || 0) / 1000),
        })),
      )

      if (allFills.length === 0) {
        throw new Error('No fills found for the specified filters')
      }

      // Find time range from actual data
      const timestamps = allFills.map((f: any) => f.timestamp_s).filter((t: number) => t > 0)
      const startTimestamp = Math.min(...timestamps)

      // Bucket fills by time
      const buckets = new Map<number, any[]>()
      allFills.forEach((fill: any) => {
        if (!fill.timestamp_s) return
        const elapsed = fill.timestamp_s - startTimestamp
        const bucketIndex = Math.floor(elapsed / intervalSeconds)
        if (bucketIndex >= expectedBuckets) return

        if (!buckets.has(bucketIndex)) buckets.set(bucketIndex, [])
        buckets.get(bucketIndex)!.push(fill)
      })

      // Aggregate per bucket
      let timeSeries = Array.from(buckets.entries())
        .map(([bucketIndex, fills]) => {
          const bucketTimestamp = startTimestamp + bucketIndex * intervalSeconds

          let value: number
          if (metric === 'fill_count') {
            value = fills.length
          } else if (metric === 'volume') {
            value = fills.reduce((sum, f) => sum + (f.px || 0) * (f.sz || 0), 0)
          } else if (metric === 'unique_traders') {
            const traders = new Set(fills.map((f: any) => f.user).filter(Boolean))
            value = traders.size
          } else {
            value = 0
          }

          return {
            bucket_index: bucketIndex,
            timestamp: bucketTimestamp,
            timestamp_human: formatTimestamp(bucketTimestamp),
            fills_in_bucket: fills.length,
            value: parseFloat(value.toFixed(2)),
          }
        })
        .sort((a, b) => a.bucket_index - b.bucket_index)

      // Trim incomplete last bucket
      if (timeSeries.length > 2) {
        const fillCounts = timeSeries.slice(0, -1).map((t) => t.fills_in_bucket)
        const median = fillCounts.sort((a, b) => a - b)[Math.floor(fillCounts.length / 2)]
        const last = timeSeries[timeSeries.length - 1]
        if (last.fills_in_bucket < median * 0.3) {
          timeSeries = timeSeries.slice(0, -1)
        }
      }

      // Summary stats
      const values = timeSeries.map((t) => t.value)
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length
      const min = Math.min(...values)
      const max = Math.max(...values)

      const coinNote = coin ? ` for ${coin.join(', ')}` : ''
      const summary: any = {
        metric,
        interval,
        duration,
        total_buckets: timeSeries.length,
        expected_buckets: expectedBuckets,
        total_fills: allFills.length,
        from_block: fromBlock,
        to_block: endBlock,
        statistics: {
          avg: parseFloat(avg.toFixed(2)),
          min: parseFloat(min.toFixed(2)),
          max: parseFloat(max.toFixed(2)),
        },
      }

      if (coin) summary.filtered_by_coin = coin

      return formatResult(
        { summary, time_series: timeSeries },
        `Aggregated ${metric}${coinNote} over ${duration} in ${interval} intervals. ${timeSeries.length} data points. Avg: ${avg.toFixed(2)}, Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}`,
        {
          metadata: {
            dataset,
            from_block: fromBlock,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
