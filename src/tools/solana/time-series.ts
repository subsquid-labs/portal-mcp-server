import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { buildTimeSeriesChart, buildTimeSeriesTable } from '../../helpers/chart-metadata.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatNumber } from '../../helpers/formatting.js'
import { buildBucketCoverage, buildBucketGapDiagnostics, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { parseTimeframeToSeconds } from '../../helpers/timeframe.js'
import { computeSolanaTimeSeries } from './time-series-shared.js'

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
      metric: z.enum(['tps', 'transaction_count', 'unique_wallets', 'avg_fee', 'success_rate', 'slots_per_hour']).describe('Metric to chart'),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval'),
      duration: z.enum(['1h', '6h', '24h', '7d']).describe('Total time period to analyze'),
    },
    async ({ dataset, metric, interval, duration }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const head = await getBlockHead(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw createUnsupportedChainError({
          toolName: 'portal_solana_time_series',
          dataset,
          actualChainType: chainType,
          supportedChains: ['solana'],
          suggestions: [
            'Use portal_get_time_series for EVM or Bitcoin datasets.',
            'Use portal_hyperliquid_time_series for Hyperliquid fills.',
          ],
        })
      }

      const result = await computeSolanaTimeSeries({
        dataset,
        metric,
        interval,
        duration,
      })

      const { statistics, time_series: timeSeries } = result
      const filledBuckets = timeSeries.filter((point) => point.slots_in_bucket > 0).length
      const gapDiagnostics = buildBucketGapDiagnostics({
        buckets: timeSeries,
        intervalSeconds: parseTimeframeToSeconds(interval),
        isFilled: (bucket) => bucket.slots_in_bucket > 0,
        anchor: 'latest_block',
        windowComplete:
          result.first_observed_timestamp !== undefined
            ? result.first_observed_timestamp <= timeSeries[0]?.timestamp
            : true,
        ...(result.first_observed_timestamp !== undefined
          ? { firstObservedTimestamp: result.first_observed_timestamp }
          : {}),
        ...(result.last_observed_timestamp !== undefined
          ? { lastObservedTimestamp: result.last_observed_timestamp }
          : {}),
      })
      const summary: any = {
        metric: result.metric,
        unit: result.unit,
        interval: result.interval,
        duration: result.duration,
        total_buckets: timeSeries.length,
        expected_buckets: result.expected_buckets,
        total_slots: result.total_slots,
        returned_blocks: result.returned_blocks,
        from_block: result.from_block,
        to_block: result.to_block,
        observed_span_seconds: result.observed_span_seconds,
        observed_span_formatted: result.observed_span_formatted,
        statistics,
      }

      if (result.chunks_fetched > 1) {
        summary.chunks_fetched = result.chunks_fetched
      }
      if (result.chunk_size_reduced) {
        summary.chunk_size_reduced = true
      }

      return formatResult(
        {
          summary,
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: timeSeries.length,
            unit: result.unit,
            title: `Solana ${metric}`,
            yAxisLabel: metric,
          }),
          tables: [
            buildTimeSeriesTable({
              rowCount: timeSeries.length,
              title: 'Time series buckets',
              valueLabel: metric,
              valueFormat: metric === 'success_rate' ? 'percent' : 'decimal',
              unit: result.unit,
              timestampField: 'timestamp',
              blocksInBucketField: 'blocks_in_bucket',
              blocksInBucketLabel: 'Slots',
              defaultSort: { key: 'bucket_index', direction: 'asc' },
            }),
          ],
          gap_diagnostics: gapDiagnostics,
          time_series: timeSeries,
        },
        `Solana ${metric} over ${duration} in ${interval} intervals. ${timeSeries.length} data points. Avg: ${statistics.avg_formatted}, Min: ${formatNumber(statistics.min)} ${result.unit}, Max: ${formatNumber(statistics.max)} ${result.unit}`,
        {
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: result.to_block,
            resolvedWindow: { range_kind: 'timeframe' },
          }),
          coverage: buildBucketCoverage({
            expectedBuckets: result.expected_buckets,
            returnedBuckets: timeSeries.length,
            filledBuckets,
            anchor: 'latest_block',
            windowComplete:
              result.first_observed_timestamp !== undefined
                ? result.first_observed_timestamp <= timeSeries[0]?.timestamp
                : true,
          }),
          metadata: {
            dataset,
            from_block: result.from_block,
            to_block: result.to_block,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
