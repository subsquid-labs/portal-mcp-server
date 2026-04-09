import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatNumber } from '../../helpers/formatting.js'
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
        { summary, time_series: timeSeries },
        `Solana ${metric} over ${duration} in ${interval} intervals. ${timeSeries.length} data points. Avg: ${statistics.avg_formatted}, Min: ${formatNumber(statistics.min)} ${result.unit}, Max: ${formatNumber(statistics.max)} ${result.unit}`,
        {
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
