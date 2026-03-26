import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatNumber } from '../../helpers/formatting.js'
import { parseTimeframeToSeconds, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Solana Time Series
// ============================================================================

export function registerSolanaTimeSeriesool(server: McpServer) {
  server.tool(
    'portal_solana_time_series',
    `Solana-specific time series for charting. Tracks TPS, unique wallets, average fee, success rate, and slot production over time.

WHEN TO USE:
- "Show me Solana TPS over the past 24h"
- "Chart Solana fees over time"
- "Solana unique wallets trend"
- "Solana success rate over the past week"

EXAMPLES:
- TPS trend: { metric: "tps", interval: "1h", duration: "24h" }
- Fee trend: { metric: "avg_fee", interval: "1h", duration: "24h" }
- Wallets: { metric: "unique_wallets", interval: "6h", duration: "7d" }`,
    {
      dataset: z.string().default('solana-mainnet').describe('Dataset name (default: solana-mainnet)'),
      metric: z
        .enum(['tps', 'transaction_count', 'unique_wallets', 'avg_fee', 'success_rate', 'slots_per_hour'])
        .describe('Metric to chart'),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval'),
      duration: z.enum(['1h', '6h', '24h', '7d']).describe('Total time period to analyze'),
    },
    async ({ dataset, metric, interval, duration }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw new Error('portal_solana_time_series is only for Solana chains.')
      }

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

      const slotRange = endBlock - fromBlock
      if (slotRange > 250000) {
        throw new Error(
          `Slot range too large for Solana time series (${slotRange.toLocaleString()} slots, max 250k). ` +
          `Use a shorter duration (e.g., '1h', '6h', or '24h') or a larger interval.`
        )
      }
      const effectiveFrom = fromBlock

      // Bucket data
      type BucketData = {
        slots: number
        txCount: number
        errorCount: number
        totalFees: number
        wallets: Set<string>
        minTimestamp: number
        maxTimestamp: number
      }

      const buckets = new Map<number, BucketData>()

      function getOrCreateBucket(idx: number): BucketData {
        let b = buckets.get(idx)
        if (!b) {
          b = { slots: 0, txCount: 0, errorCount: 0, totalFees: 0, wallets: new Set(), minTimestamp: Infinity, maxTimestamp: 0 }
          buckets.set(idx, b)
        }
        return b
      }

      // Solana blocks are extremely dense (~500 txs/slot with minimal fields).
      // Larger chunks = fewer HTTP round-trips = much faster.
      // 5000 slots × ~500 txs × ~50 bytes ≈ 125MB per chunk (within 150MB limit).
      const CHUNK_SIZE = 5000
      const chunks = Math.ceil(slotRange / CHUNK_SIZE)
      let startTimestamp = 0
      let totalSlotsProcessed = 0

      for (let chunkIdx = 0; chunkIdx < chunks; chunkIdx++) {
        const chunkFrom = effectiveFrom + chunkIdx * CHUNK_SIZE
        const chunkTo = Math.min(chunkFrom + CHUNK_SIZE, endBlock)

        const txQuery = {
          type: 'solana',
          fromBlock: chunkFrom,
          toBlock: chunkTo,
          includeAllBlocks: true,
          fields: {
            block: { number: true, timestamp: true },
            transaction: {
              transactionIndex: true,
              fee: true,
              feePayer: true,
              err: true,
            },
          },
          transactions: [{}],
        }

        let chunkResults: any[]
        try {
          chunkResults = await portalFetchStream(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            txQuery,
            undefined,
            0,
            150 * 1024 * 1024,
          ) as any[]
        } catch (err) {
          throw new Error(`Failed to fetch Solana time-series chunk: ${err instanceof Error ? err.message : String(err)}`)
        }

        for (const block of chunkResults) {
          const ts = block.header?.timestamp ?? block.timestamp
          if (!ts) continue

          // Anchor startTimestamp from the very first block
          if (startTimestamp === 0) startTimestamp = ts

          totalSlotsProcessed++
          const elapsed = ts - startTimestamp
          const bucketIndex = Math.floor(elapsed / intervalSeconds)
          if (bucketIndex >= expectedBuckets || bucketIndex < 0) continue

          const bucket = getOrCreateBucket(bucketIndex)
          bucket.slots++
          if (ts < bucket.minTimestamp) bucket.minTimestamp = ts
          if (ts > bucket.maxTimestamp) bucket.maxTimestamp = ts

          const txs = block.transactions || []
          bucket.txCount += txs.length
          txs.forEach((tx: any) => {
            bucket.totalFees += parseInt(tx.fee || '0') || 0
            if (tx.feePayer) bucket.wallets.add(tx.feePayer)
            if (tx.err) bucket.errorCount++
          })
        }
      }

      if (totalSlotsProcessed === 0) {
        throw new Error('No data available for this time period')
      }

      // Compute metric per bucket
      const unitMap: Record<string, string> = {
        tps: 'tx/s',
        transaction_count: 'txs',
        unique_wallets: 'wallets',
        avg_fee: 'lamports',
        success_rate: '%',
        slots_per_hour: 'slots/h',
      }
      const unit = unitMap[metric] || ''

      let timeSeries = Array.from(buckets.entries())
        .map(([bucketIndex, data]) => {
          const bucketTimestamp = startTimestamp + bucketIndex * intervalSeconds
          const timeSpan = data.maxTimestamp > data.minTimestamp ? data.maxTimestamp - data.minTimestamp : data.slots * 0.4

          let value: number
          switch (metric) {
            case 'tps':
              value = timeSpan > 0 ? data.txCount / timeSpan : 0
              break
            case 'transaction_count':
              value = data.txCount
              break
            case 'unique_wallets':
              value = data.wallets.size
              break
            case 'avg_fee':
              value = data.txCount > 0 ? data.totalFees / data.txCount : 0
              break
            case 'success_rate':
              value = data.txCount > 0 ? ((data.txCount - data.errorCount) / data.txCount) * 100 : 0
              break
            case 'slots_per_hour':
              value = timeSpan > 0 ? (data.slots / timeSpan) * 3600 : 0
              break
            default:
              value = 0
          }

          return {
            bucket_index: bucketIndex,
            timestamp: bucketTimestamp,
            timestamp_human: formatTimestamp(bucketTimestamp),
            slots_in_bucket: data.slots,
            txs_in_bucket: data.txCount,
            value: parseFloat(value.toFixed(2)),
            value_formatted: formatNumber(value) + ' ' + unit,
          }
        })
        .sort((a, b) => a.bucket_index - b.bucket_index)

      // Trim incomplete last bucket
      if (timeSeries.length > 2) {
        const slotCounts = timeSeries.slice(0, -1).map((t) => t.slots_in_bucket)
        const sorted = [...slotCounts].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]
        const last = timeSeries[timeSeries.length - 1]
        if (last.slots_in_bucket < median * 0.3) {
          timeSeries = timeSeries.slice(0, -1)
        }
      }

      // Summary stats
      const values = timeSeries.map((t) => t.value)
      const avg = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
      let min = Infinity, max = -Infinity
      values.forEach((v) => { if (v < min) min = v; if (v > max) max = v })
      if (!isFinite(min)) min = 0
      if (!isFinite(max)) max = 0

      const summary: any = {
        metric,
        unit,
        interval,
        duration,
        total_buckets: timeSeries.length,
        expected_buckets: expectedBuckets,
        total_slots: totalSlotsProcessed,
        from_block: effectiveFrom,
        to_block: endBlock,
        statistics: {
          avg: parseFloat(avg.toFixed(2)),
          avg_formatted: formatNumber(avg) + ' ' + unit,
          min: parseFloat(min.toFixed(2)),
          max: parseFloat(max.toFixed(2)),
        },
      }

      if (chunks > 1) {
        summary.chunks_fetched = chunks
      }

      return formatResult(
        { summary, time_series: timeSeries },
        `Solana ${metric} over ${duration} in ${interval} intervals. ${timeSeries.length} data points. Avg: ${formatNumber(avg)} ${unit}, Min: ${formatNumber(min)} ${unit}, Max: ${formatNumber(max)} ${unit}`,
        {
          metadata: {
            dataset,
            from_block: effectiveFrom,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
