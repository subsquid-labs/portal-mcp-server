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

function toSeconds(ts: number): number {
  if (ts > 1e12) return Math.floor(ts / 1000)
  return ts
}

// Top coins to track individually — everything else goes into "Others"
const TOP_COINS = ['BTC', 'ETH', 'SOL', 'HYPE']

export function registerHyperliquidTimeSeriesFilsTool(server: McpServer) {
  server.tool(
    'portal_hyperliquid_time_series',
    `Aggregate Hyperliquid trading metrics over time intervals for charting. Track fill count, volume, unique traders, realized PnL, and liquidation volume over time. Supports per-coin breakdowns for stacked charts.

WHEN TO USE:
- "Show me BTC trading volume over the past 24h"
- "Chart unique traders by coin over the past week"
- "Hyperliquid volume breakdown by coin"
- "Show me Hyperliquid PnL trend"

EXAMPLES:
- Volume by coin: { metric: "volume", interval: "1d", duration: "7d", group_by: "coin" }
- Fill count trend: { metric: "fill_count", interval: "1h", duration: "24h" }
- Traders by coin: { metric: "unique_traders", interval: "1d", duration: "7d", group_by: "coin" }`,
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Dataset name (default: 'hyperliquid-fills')"),
      metric: z
        .enum(['fill_count', 'volume', 'unique_traders', 'realized_pnl', 'liquidation_volume'])
        .describe(
          "Metric: 'fill_count', 'volume' (notional USD), 'unique_traders', 'realized_pnl' (closed PnL USD), 'liquidation_volume' (liquidated notional USD)",
        ),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval'),
      duration: z.enum(['1h', '6h', '24h', '7d', '30d']).describe('Total time period to analyze'),
      coin: z.array(z.string()).optional().describe('Filter by asset symbols (e.g., ["BTC", "ETH"])'),
      user: z.array(z.string()).optional().describe('Filter by trader addresses'),
      group_by: z
        .enum(['coin', 'none'])
        .optional()
        .default('none')
        .describe(
          "Group by: 'coin' (per-coin breakdown per bucket — BTC, ETH, SOL, HYPE, Others), 'none' (single value per bucket)",
        ),
    },
    async ({ dataset, metric, interval, duration, coin, user, group_by }) => {
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

      // Only request fields actually needed for the metric — reduces payload 2-5x
      const fillFields: Record<string, boolean> = { time: true }
      if (metric === 'volume' || metric === 'liquidation_volume') {
        fillFields.px = true
        fillFields.sz = true
      }
      if (metric === 'unique_traders') fillFields.user = true
      if (metric === 'realized_pnl') fillFields.closedPnl = true
      if (metric === 'liquidation_volume') fillFields.dir = true
      if (group_by === 'coin' || coin) fillFields.coin = true
      // volume needs user for group_by coin tracking
      if (group_by === 'coin') {
        fillFields.user = true
        fillFields.px = true
        fillFields.sz = true
      }

      // Bucket definition
      type BucketData = {
        fills: number
        volume: number
        traders: Set<string>
        pnl: number
        liqVolume: number
        byCoin: Map<string, { fills: number; volume: number; traders: Set<string>; pnl: number; liqVolume: number }>
      }

      const buckets = new Map<number, BucketData>()

      function getOrCreateBucket(bucketTimestamp: number): BucketData {
        let b = buckets.get(bucketTimestamp)
        if (!b) {
          b = { fills: 0, volume: 0, traders: new Set(), pnl: 0, liqVolume: 0, byCoin: new Map() }
          buckets.set(bucketTimestamp, b)
        }
        return b
      }

      function getOrCreateCoinData(byCoin: Map<string, any>, coinKey: string) {
        let d = byCoin.get(coinKey)
        if (!d) {
          d = { fills: 0, volume: 0, traders: new Set(), pnl: 0, liqVolume: 0 }
          byCoin.set(coinKey, d)
        }
        return d
      }

      // HL blocks are ~0.083s (~12/sec). Long durations need millions of blocks.
      // Fetch in chunks to avoid OOM, aggregating into buckets incrementally.
      const CHUNK_SIZE = 40000 // ~55 min of HL blocks per chunk (~480k fills, ~96MB)
      const totalBlockRange = endBlock - fromBlock
      const chunks = Math.ceil(totalBlockRange / CHUNK_SIZE)

      let latestTimestamp = 0
      let fillCount = 0

      for (let chunkIdx = 0; chunkIdx < chunks; chunkIdx++) {
        const chunkFrom = fromBlock + chunkIdx * CHUNK_SIZE
        const chunkTo = Math.min(chunkFrom + CHUNK_SIZE, endBlock)

        const chunkQuery = {
          type: 'hyperliquidFills',
          fromBlock: chunkFrom,
          toBlock: chunkTo,
          fields: {
            block: { number: true, timestamp: true },
            fill: fillFields,
          },
          fills: [fillFilter],
        }

        let chunkResults: any[]
        try {
          chunkResults = await portalFetchStream(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            chunkQuery,
            undefined,
            0, // no block limit per chunk
            150 * 1024 * 1024,
          ) as any[]
        } catch (err) {
          throw new Error(`Failed to fetch Hyperliquid time-series chunk: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Process this chunk's fills into buckets
        for (const block of chunkResults) {
          for (const fill of block.fills || []) {
            const ts = toSeconds(fill.time || block.header?.timestamp || 0)
            if (!ts) continue

            latestTimestamp = Math.max(latestTimestamp, ts)
            fillCount++
            const bucketTimestamp = Math.floor(ts / intervalSeconds) * intervalSeconds
            const bucket = getOrCreateBucket(bucketTimestamp)
            const notional = (fill.px || 0) * (fill.sz || 0)
            const isLiquidation =
              fill.dir === 'Short > Long' || fill.dir === 'Long > Short'

            bucket.fills++
            bucket.volume += notional
            if (fill.user) bucket.traders.add(fill.user)
            bucket.pnl += fill.closedPnl || 0
            if (isLiquidation) bucket.liqVolume += notional

            // Per-coin tracking (for group_by)
            if (group_by === 'coin') {
              const coinKey = TOP_COINS.includes(fill.coin) ? fill.coin : 'Others'
              const cd = getOrCreateCoinData(bucket.byCoin, coinKey)
              cd.fills++
              cd.volume += notional
              if (fill.user) cd.traders.add(fill.user)
              cd.pnl += fill.closedPnl || 0
              if (isLiquidation) cd.liqVolume += notional
            }
          }
        }
      }

      if (fillCount === 0) {
        throw new Error('No fills found for the specified filters')
      }

      const seriesEndExclusive = Math.floor(latestTimestamp / intervalSeconds) * intervalSeconds + intervalSeconds
      const seriesStartTimestamp = seriesEndExclusive - durationSeconds

      // Helper to extract metric value
      function getMetricValue(data: { fills: number; volume: number; traders: Set<string>; pnl: number; liqVolume: number }): number {
        switch (metric) {
          case 'fill_count': return data.fills
          case 'volume': return data.volume
          case 'unique_traders': return data.traders.size
          case 'realized_pnl': return data.pnl
          case 'liquidation_volume': return data.liqVolume
          default: return 0
        }
      }

      const timeSeries = Array.from({ length: expectedBuckets }, (_, bucketIndex) => {
        const bucketTimestamp = seriesStartTimestamp + bucketIndex * intervalSeconds
        const data = buckets.get(bucketTimestamp)

        const entry: any = {
          bucket_index: bucketIndex,
          timestamp: bucketTimestamp,
          timestamp_human: formatTimestamp(bucketTimestamp),
          fills_in_bucket: data?.fills ?? 0,
          value: parseFloat((data ? getMetricValue(data) : 0).toFixed(2)),
        }

        if (group_by === 'coin') {
          const breakdown: Record<string, number> = {}
          ;[...TOP_COINS, 'Others'].forEach((c) => {
            const coinData = data?.byCoin.get(c)
            breakdown[c] = coinData ? parseFloat(getMetricValue(coinData).toFixed(2)) : 0
          })
          entry.by_coin = breakdown
        }

        return entry
      })

      // Summary stats
      const values = timeSeries.map((t) => t.value)
      const avg = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
      const totalFillsInSeries = timeSeries.reduce((sum, bucket) => sum + bucket.fills_in_bucket, 0)
      let min = Infinity, max = -Infinity
      values.forEach((v) => { if (v < min) min = v; if (v > max) max = v })
      if (!isFinite(min)) min = 0
      if (!isFinite(max)) max = 0

      const coinNote = coin ? ` for ${coin.join(', ')}` : ''
      const summary: any = {
        metric,
        interval,
        duration,
        total_buckets: timeSeries.length,
        expected_buckets: expectedBuckets,
        total_fills: totalFillsInSeries,
        from_block: fromBlock,
        to_block: endBlock,
        latest_fill_timestamp: latestTimestamp,
        latest_fill_timestamp_human: formatTimestamp(latestTimestamp),
        statistics: {
          avg: parseFloat(avg.toFixed(2)),
          min: parseFloat(min.toFixed(2)),
          max: parseFloat(max.toFixed(2)),
        },
      }

      if (coin) summary.filtered_by_coin = coin
      if (group_by === 'coin') summary.grouped_by = 'coin'
      if (chunks > 1) summary.chunks_fetched = chunks

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
