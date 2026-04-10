import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { buildTableDescriptor, buildTimeSeriesChart, buildTimeSeriesTable } from '../../helpers/chart-metadata.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp } from '../../helpers/formatting.js'
import { buildBucketCoverage, buildBucketGapDiagnostics, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { getTimestampWindowNotices, parseTimeframeToSeconds, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

type TrendPoint = {
  bucket_index: number
  timestamp: number
  timestamp_human: string
  contract_address: string
  rank: number
  transaction_count: number
}

type BucketAccumulator = {
  timestamp: number
  total_transactions: number
  contract_counts: Map<string, number>
}

function createBuckets(expectedBuckets: number, seriesStartTimestamp: number, intervalSeconds: number): BucketAccumulator[] {
  return Array.from({ length: expectedBuckets }, (_, bucketIndex) => ({
    timestamp: seriesStartTimestamp + bucketIndex * intervalSeconds,
    total_transactions: 0,
    contract_counts: new Map<string, number>(),
  }))
}

export function registerGetTopContractTrendsTool(server: McpServer) {
  server.tool(
    'portal_get_top_contract_trends',
    `Track the busiest EVM contracts over time. Returns top contracts for the whole window plus a grouped time series showing how their activity changes bucket-by-bucket.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'base', 'optimism', etc.)"),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval'),
      duration: z.enum(['1h', '6h', '24h', '7d', '30d']).describe('Total time period to analyze'),
      limit: z.number().max(10).optional().default(5).describe('Number of top contracts to track in the trend output'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Optional natural start time like "6h ago", ISO datetime, or Unix timestamp'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Optional natural end time like "now", ISO datetime, or Unix timestamp'),
    },
    async ({ dataset, interval, duration, limit, from_timestamp, to_timestamp }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_top_contract_trends',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_get_time_series for generic Solana or Bitcoin activity trends.',
            'Use portal_hyperliquid_time_series for Hyperliquid fills-based trends.',
          ],
        })
      }

      const resolvedWindow = await resolveTimeframeOrBlocks({
        dataset,
        timeframe: from_timestamp === undefined && to_timestamp === undefined ? duration : undefined,
        from_timestamp: from_timestamp as TimestampInput | undefined,
        to_timestamp: to_timestamp as TimestampInput | undefined,
      })
      const fromBlock = resolvedWindow.from_block
      const { validatedToBlock: toBlock, head } = await validateBlockRange(
        dataset,
        fromBlock,
        resolvedWindow.to_block ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const intervalSeconds = parseTimeframeToSeconds(interval)
      const durationSeconds = parseTimeframeToSeconds(duration)
      const expectedBuckets = Math.ceil(durationSeconds / intervalSeconds)
      const contractTotals = new Map<string, number>()
      let firstObservedTimestamp: number | undefined
      let lastObservedTimestamp: number | undefined
      let totalTransactions = 0
      const notices = getTimestampWindowNotices(resolvedWindow)

      await portalFetchStreamRangeVisit(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        {
          type: 'evm',
          fromBlock,
          toBlock,
          fields: {
            block: { number: true, timestamp: true },
            transaction: {
              to: true,
            },
          },
          transactions: [{}],
        },
        {
          onRecord: (record) => {
            const block = record as {
              header?: { timestamp?: number }
              timestamp?: number
              transactions?: Array<{ to?: string }>
            }
            const timestamp = block.header?.timestamp ?? block.timestamp
            if (typeof timestamp !== 'number' || timestamp <= 0) return
            if (firstObservedTimestamp === undefined || timestamp < firstObservedTimestamp) firstObservedTimestamp = timestamp
            if (lastObservedTimestamp === undefined || timestamp > lastObservedTimestamp) lastObservedTimestamp = timestamp
          },
        },
      )

      if (lastObservedTimestamp === undefined) {
        throw new Error('No transactions available for this time period')
      }

      const seriesStartTimestamp = lastObservedTimestamp - durationSeconds
      const populatedBuckets = createBuckets(expectedBuckets, seriesStartTimestamp, intervalSeconds)

      await portalFetchStreamRangeVisit(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        {
          type: 'evm',
          fromBlock,
          toBlock,
          fields: {
            block: { number: true, timestamp: true },
            transaction: {
              to: true,
            },
          },
          transactions: [{}],
        },
        {
          onRecord: (record) => {
            const block = record as {
              header?: { timestamp?: number }
              timestamp?: number
              transactions?: Array<{ to?: string }>
            }
            const timestamp = block.header?.timestamp ?? block.timestamp
            if (typeof timestamp !== 'number' || timestamp <= 0) return

            const bucketIndex = Math.floor((timestamp - seriesStartTimestamp) / intervalSeconds)
            if (bucketIndex < 0 || bucketIndex >= expectedBuckets) return

            const bucket = populatedBuckets[bucketIndex]
            for (const tx of block.transactions || []) {
              if (!tx.to) continue
              const contract = tx.to.toLowerCase()
              bucket.total_transactions += 1
              totalTransactions += 1
              bucket.contract_counts.set(contract, (bucket.contract_counts.get(contract) || 0) + 1)
              contractTotals.set(contract, (contractTotals.get(contract) || 0) + 1)
            }
          },
        },
      )

      const topContracts = Array.from(contractTotals.entries())
        .map(([address, count]) => ({
          address,
          transaction_count: count,
          share: totalTransactions > 0 ? (count / totalTransactions) * 100 : 0,
        }))
        .sort((left, right) => right.transaction_count - left.transaction_count)
        .slice(0, limit)
        .map((item, index) => ({
          rank: index + 1,
          address: item.address,
          transaction_count: item.transaction_count,
          share: Number(item.share.toFixed(2)),
        }))

      const rankByAddress = new Map(topContracts.map((item) => [item.address, item.rank]))
      const timeSeries: TrendPoint[] = populatedBuckets.flatMap((bucket, bucketIndex) =>
        topContracts.map((contract) => ({
          bucket_index: bucketIndex,
          timestamp: bucket.timestamp,
          timestamp_human: formatTimestamp(bucket.timestamp),
          contract_address: contract.address,
          rank: rankByAddress.get(contract.address) || 0,
          transaction_count: bucket.contract_counts.get(contract.address) || 0,
        })),
      )

      const filledBuckets = populatedBuckets.filter((bucket) => bucket.total_transactions > 0).length
      const gapDiagnostics = buildBucketGapDiagnostics({
        buckets: populatedBuckets.map((bucket, bucketIndex) => ({
          bucket_index: bucketIndex,
          timestamp: bucket.timestamp,
          timestamp_human: formatTimestamp(bucket.timestamp),
          total_transactions: bucket.total_transactions,
        })),
        intervalSeconds,
        isFilled: (bucket) => bucket.total_transactions > 0,
        anchor: 'latest_block',
        windowComplete:
          firstObservedTimestamp !== undefined ? firstObservedTimestamp <= seriesStartTimestamp : true,
        ...(firstObservedTimestamp !== undefined ? { firstObservedTimestamp } : {}),
        ...(lastObservedTimestamp !== undefined ? { lastObservedTimestamp } : {}),
      })

      return formatResult(
        {
          summary: {
            interval,
            duration,
            total_buckets: expectedBuckets,
            filled_buckets: filledBuckets,
            empty_buckets: expectedBuckets - filledBuckets,
            total_transactions: totalTransactions,
            tracked_contracts: topContracts.length,
            from_block: fromBlock,
            to_block: toBlock,
            window_start_timestamp: seriesStartTimestamp,
            window_start_timestamp_human: formatTimestamp(seriesStartTimestamp),
            window_end_timestamp: lastObservedTimestamp,
            window_end_timestamp_human: formatTimestamp(lastObservedTimestamp),
          },
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: timeSeries.length,
            groupedValueField: 'contract_address',
            recommendedVisual: 'stacked_area',
            dataKey: 'time_series',
            title: 'Contract activity trend',
            yAxisLabel: 'Transactions',
            valueFormat: 'integer',
          }),
          tables: [
            buildTableDescriptor({
              id: 'top_contracts',
              dataKey: 'top_contracts',
              rowCount: topContracts.length,
              title: 'Top contracts in window',
              keyField: 'address',
              defaultSort: { key: 'rank', direction: 'asc' },
              dense: true,
              columns: [
                { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
                { key: 'address', label: 'Contract', kind: 'dimension', format: 'address' },
                { key: 'transaction_count', label: 'Transactions', kind: 'metric', format: 'integer', align: 'right' },
                { key: 'share', label: 'Share', kind: 'metric', format: 'percent', unit: '%', align: 'right' },
              ],
            }),
            buildTimeSeriesTable({
              id: 'trend_series',
              dataKey: 'time_series',
              rowCount: timeSeries.length,
              title: 'Bucketed contract activity',
              groupedValueField: 'contract_address',
              groupedValueLabel: 'Contract',
              valueField: 'transaction_count',
              valueLabel: 'Transactions',
              valueFormat: 'integer',
              timestampField: 'timestamp',
              extraColumns: [
                { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
              ],
              keyField: 'contract_address',
              defaultSort: { key: 'timestamp', direction: 'asc' },
            }),
          ],
          gap_diagnostics: gapDiagnostics,
          top_contracts: topContracts,
          time_series: timeSeries,
        },
        `Tracked ${topContracts.length} top contracts over ${duration} in ${interval} buckets across ${totalTransactions.toLocaleString()} transactions.`,
        {
          ...(notices.length > 0 ? { notices } : {}),
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: toBlock,
            resolvedWindow,
          }),
          coverage: buildBucketCoverage({
            expectedBuckets,
            returnedBuckets: expectedBuckets,
            filledBuckets,
            anchor: 'latest_block',
            windowComplete:
              firstObservedTimestamp !== undefined ? firstObservedTimestamp <= seriesStartTimestamp : true,
          }),
          metadata: {
            dataset,
            from_block: fromBlock,
            to_block: toBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
