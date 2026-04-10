import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import {
  buildTableDescriptor,
  buildTimeSeriesChart,
  buildTimeSeriesTable,
  type TableValueFormat,
} from '../../helpers/chart-metadata.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError, createUnsupportedMetricError } from '../../helpers/errors.js'
import { portalFetchStream, portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatDuration, formatTimestamp } from '../../helpers/formatting.js'
import { buildBucketCoverage, buildBucketGapDiagnostics, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { getHeadTimestamp, parseTimeframeToSeconds, parseTimestampInput, resolveTimeframeOrBlocks, type TimestampInput } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { buildChartPanel, buildMetricCard, buildPortalUi, buildTablePanel } from '../../helpers/ui-metadata.js'
import { computeSolanaTimeSeries } from '../solana/time-series-shared.js'
import { computeWindowSeries } from './compare-periods.js'
import { visitHyperliquidFillBlocks } from '../hyperliquid/fill-stream.js'
import { hashString53 } from '../../helpers/hash.js'

// ============================================================================
// Tool: Get Time Series Data
// ============================================================================

/**
 * Aggregate blockchain metrics over time intervals.
 * Perfect for "show me activity trends over the past week" questions.
 */

type TimeSeriesMetric =
  | 'transaction_count'
  | 'transactions_per_block'
  | 'avg_gas_price'
  | 'gas_used'
  | 'block_utilization'
  | 'unique_addresses'
  | 'tps'
  | 'avg_fee'
  | 'success_rate'
  | 'slots_per_hour'
  | 'fees_btc'
  | 'block_size_bytes'
  | 'volume'
  | 'fill_count'
  | 'unique_traders'

type TimeSeriesBlock = {
  number?: number
  timestamp?: number
  baseFeePerGas?: string
  gasUsed?: string
  gasLimit?: string
  header?: {
    number?: number
    timestamp?: number
    baseFeePerGas?: string
    gasUsed?: string
    gasLimit?: string
  }
  transactions?: Array<{
    feePayer?: string
    from?: string
    to?: string
  }>
}

type BucketAccumulator = {
  bucketIndex: number
  bucketTimestamp: number
  firstBlockNumber?: number
  lastBlockNumber?: number
  blocksInBucket: number
  txCount: number
  gasPriceSum: number
  gasPriceCount: number
  gasUsedSum: number
  utilizationSum: number
  utilizationCount: number
  addresses: Set<string>
}

const SOLANA_GENERIC_TIME_SERIES_CHUNK_SIZE: Partial<Record<TimeSeriesMetric, number>> = {
  transaction_count: 5000,
  unique_addresses: 1000,
}

const MIN_SOLANA_GENERIC_CHUNK_SIZE = 250
const SOLANA_GENERIC_MAX_BYTES = 150 * 1024 * 1024

function getBlockNumber(block: TimeSeriesBlock): number | undefined {
  return block.number ?? block.header?.number
}

function getBlockTimestamp(block: TimeSeriesBlock): number | undefined {
  return block.timestamp ?? block.header?.timestamp
}

function getBlockBigIntString(block: TimeSeriesBlock, key: 'baseFeePerGas' | 'gasUsed' | 'gasLimit'): string | undefined {
  return block[key] ?? block.header?.[key]
}

function createBucketAccumulators(expectedBuckets: number, seriesStartTimestamp: number, intervalSeconds: number): BucketAccumulator[] {
  return Array.from({ length: expectedBuckets }, (_, bucketIndex) => ({
    bucketIndex,
    bucketTimestamp: seriesStartTimestamp + bucketIndex * intervalSeconds,
    blocksInBucket: 0,
    txCount: 0,
    gasPriceSum: 0,
    gasPriceCount: 0,
    gasUsedSum: 0,
    utilizationSum: 0,
    utilizationCount: 0,
    addresses: new Set<string>(),
  }))
}

function getMetricLabel(metric: TimeSeriesMetric): string {
  switch (metric) {
    case 'transaction_count':
      return 'Transactions'
    case 'transactions_per_block':
      return 'Transactions per block'
    case 'avg_gas_price':
      return 'Average gas price'
    case 'gas_used':
      return 'Gas used'
    case 'block_utilization':
      return 'Block utilization'
    case 'unique_addresses':
      return 'Unique addresses'
    case 'tps':
      return 'TPS'
    case 'avg_fee':
      return 'Average fee'
    case 'success_rate':
      return 'Success rate'
    case 'slots_per_hour':
      return 'Slots per hour'
    case 'fees_btc':
      return 'Fees'
    case 'block_size_bytes':
      return 'Block size'
    case 'volume':
      return 'Volume'
    case 'fill_count':
      return 'Fills'
    case 'unique_traders':
      return 'Unique traders'
  }
}

function getMetricValueFormat(metric: TimeSeriesMetric): TableValueFormat {
  switch (metric) {
    case 'transaction_count':
    case 'unique_addresses':
    case 'fill_count':
    case 'unique_traders':
      return 'integer'
    case 'avg_gas_price':
      return 'gwei'
    case 'block_utilization':
    case 'success_rate':
      return 'percent'
    case 'block_size_bytes':
      return 'bytes'
    case 'fees_btc':
      return 'btc'
    case 'volume':
      return 'currency_usd'
    default:
      return 'decimal'
  }
}

function getMetricUnit(metric: TimeSeriesMetric): string | undefined {
  switch (metric) {
    case 'transaction_count':
      return 'transactions'
    case 'avg_gas_price':
      return 'gwei'
    case 'gas_used':
      return 'gas'
    case 'block_utilization':
    case 'success_rate':
      return '%'
    case 'fees_btc':
      return 'BTC'
    case 'block_size_bytes':
      return 'bytes'
    case 'volume':
      return 'USD'
    case 'fill_count':
      return 'fills'
    default:
      return undefined
  }
}

function buildSimpleSeriesUi(params: {
  title: string
  subtitle: string
  metricLabel: string
  valueFormat: TableValueFormat
  unit?: string
  avgValuePath?: string
  primaryValuePath?: string
  primaryLabel?: string
  tableId?: string
  followUpActions?: Array<{ label: string; intent: 'show_raw' | 'zoom_in' | 'compare_previous'; target?: string }>
}): ReturnType<typeof buildPortalUi> {
  const metricCards = [
    buildMetricCard({
      id: 'filled-buckets',
      label: 'Filled buckets',
      value_path: 'summary.filled_buckets',
      format: 'integer',
    }),
    ...(params.primaryValuePath
      ? [buildMetricCard({
          id: 'primary-value',
          label: params.primaryLabel ?? params.metricLabel,
          value_path: params.primaryValuePath,
          format: params.valueFormat,
          ...(params.unit ? { unit: params.unit } : {}),
          emphasis: 'primary',
        })]
      : []),
    ...(params.avgValuePath
      ? [buildMetricCard({
          id: 'average-value',
          label: `Average ${params.metricLabel.toLowerCase()}`,
          value_path: params.avgValuePath,
          format: params.valueFormat,
          ...(params.unit ? { unit: params.unit } : {}),
        })]
      : []),
  ]

  return buildPortalUi({
    version: 'portal_ui_v1',
    layout: 'chart_focus',
    density: 'compact',
    design_intent: 'analytics_dashboard',
    headline: {
      title: params.title,
      subtitle: params.subtitle,
    },
    metric_cards: metricCards,
    panels: [
      buildChartPanel({
        id: 'series-chart',
        kind: 'chart_panel',
        title: params.metricLabel,
        subtitle: 'Hover to inspect bucket values and drag horizontally to zoom into a narrower range.',
        chart_key: 'chart',
        emphasis: 'primary',
      }),
      buildTablePanel({
        id: 'series-table',
        kind: 'table_panel',
        title: 'Buckets',
        subtitle: 'Exact bucket-level values in ascending time order.',
        table_id: params.tableId ?? 'main',
      }),
    ],
    follow_up_actions: params.followUpActions,
  })
}

function buildComparePreviousUi(metric: TimeSeriesMetric): ReturnType<typeof buildPortalUi> {
  const metricLabel = getMetricLabel(metric)
  const valueFormat = getMetricValueFormat(metric)
  const unit = getMetricUnit(metric)

  return buildPortalUi({
    version: 'portal_ui_v1',
    layout: 'dashboard',
    density: 'compact',
    design_intent: 'analytics_dashboard',
    headline: {
      title: `${metricLabel}: current vs previous`,
      subtitle: 'Compare aligned buckets, inspect deltas, and switch between the line chart and the summary tables.',
    },
    metric_cards: [
      buildMetricCard({
        id: 'current-total',
        label: 'Current total',
        value_path: 'summary_rows[0].current_value',
        format: valueFormat,
        ...(unit ? { unit } : {}),
        emphasis: 'primary',
      }),
      buildMetricCard({
        id: 'previous-total',
        label: 'Previous total',
        value_path: 'summary_rows[0].previous_value',
        format: valueFormat,
        ...(unit ? { unit } : {}),
      }),
      buildMetricCard({
        id: 'pct-change',
        label: 'Pct change',
        value_path: 'summary_rows[0].pct_change',
        format: 'percent',
        unit: '%',
      }),
    ],
    panels: [
      buildChartPanel({
        id: 'comparison-chart',
        kind: 'chart_panel',
        title: 'Comparison chart',
        subtitle: 'Hover over either series to see the aligned bucket values.',
        chart_key: 'chart',
        emphasis: 'primary',
      }),
      buildTablePanel({
        id: 'comparison-summary',
        kind: 'table_panel',
        title: 'Summary',
        subtitle: 'Totals and averages for the current and previous windows.',
        table_id: 'summary_rows',
      }),
      buildTablePanel({
        id: 'comparison-buckets',
        kind: 'table_panel',
        title: 'Aligned buckets',
        subtitle: 'Each current bucket paired with its previous-period counterpart.',
        table_id: 'comparison_series',
      }),
      buildTablePanel({
        id: 'bucket-deltas',
        kind: 'table_panel',
        title: 'Bucket deltas',
        subtitle: 'Absolute and percentage deltas for each aligned bucket.',
        table_id: 'bucket_deltas',
      }),
    ],
    follow_up_actions: [
      { label: 'Show raw comparison rows', intent: 'show_raw', target: 'comparison_series' },
      { label: 'Zoom into the latest divergence', intent: 'zoom_in', target: 'chart' },
    ],
  })
}

function buildGroupedContractUi(): ReturnType<typeof buildPortalUi> {
  return buildPortalUi({
    version: 'portal_ui_v1',
    layout: 'dashboard',
    density: 'compact',
    design_intent: 'analytics_dashboard',
    headline: {
      title: 'Transactions by contract',
      subtitle: 'Track the busiest contracts, compare their bucketed activity, and drill into the ranked contract table.',
    },
    metric_cards: [
      buildMetricCard({ id: 'tracked-contracts', label: 'Tracked contracts', value_path: 'summary.tracked_contracts', format: 'integer', emphasis: 'primary' }),
      buildMetricCard({ id: 'total-transactions', label: 'Transactions', value_path: 'summary.total_transactions', format: 'integer' }),
      buildMetricCard({ id: 'group-limit', label: 'Group limit', value_path: 'summary.group_limit', format: 'integer', subtitle: 'The grouped chart tracks only the top-ranked contracts.' }),
    ],
    panels: [
      buildChartPanel({
        id: 'contract-chart',
        kind: 'chart_panel',
        title: 'Contract activity chart',
        subtitle: 'Stacked contract trends with hover labels and series toggles.',
        chart_key: 'chart',
        emphasis: 'primary',
      }),
      buildTablePanel({
        id: 'top-contracts',
        kind: 'table_panel',
        title: 'Tracked contracts',
        subtitle: 'The ranked contract set driving the grouped chart.',
        table_id: 'top_contracts',
      }),
      buildTablePanel({
        id: 'contract-series',
        kind: 'table_panel',
        title: 'Bucketed contract activity',
        subtitle: 'All contract buckets with timestamps and ranks.',
        table_id: 'contract_series',
      }),
    ],
    follow_up_actions: [
      { label: 'Show raw grouped rows', intent: 'show_raw', target: 'time_series' },
      { label: 'Zoom into the latest buckets', intent: 'zoom_in', target: 'chart' },
    ],
  })
}

export function registerGetTimeSeriesDataTool(server: McpServer) {
  server.tool(
    'portal_get_time_series',
    buildToolDescription('portal_get_time_series'),
    {
      network: z.string().describe("Network name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      metric: z
        .enum([
          'transaction_count',
          'transactions_per_block',
          'avg_gas_price',
          'gas_used',
          'block_utilization',
          'unique_addresses',
          'tps',
          'avg_fee',
          'success_rate',
          'slots_per_hour',
          'fees_btc',
          'block_size_bytes',
          'volume',
          'fill_count',
          'unique_traders',
        ])
        .describe('Metric to aggregate over time'),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval (5m, 15m, 1h, 6h, 1d)'),
      duration: z.enum(['1h', '6h', '24h', '7d', '30d']).describe('Total time period to analyze'),
      address: z
        .string()
        .optional()
        .describe('Optional: Filter to specific contract address for contract-specific trends'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Optional natural start time like "24h ago", ISO datetime, or Unix timestamp'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Optional natural end time like "now", ISO datetime, or Unix timestamp'),
      compare_previous: z.boolean().optional().default(false).describe('Compare the selected window against the immediately previous window'),
      group_by: z.enum(['none', 'contract']).optional().default('none').describe('Optional grouping mode. contract is currently supported only for EVM transaction_count'),
      group_limit: z.number().optional().default(5).describe('Maximum number of contract groups when group_by=contract'),
      mode: z
        .enum(['fast', 'deep'])
        .optional()
        .default('deep')
        .describe('fast = skip extra backfill scans, deep = fill the requested window more aggressively'),
    },
    async ({ network, metric, interval, duration, address, from_timestamp, to_timestamp, compare_previous, group_by, group_limit, mode }) => {
      const queryStartTime = Date.now()
      let dataset = await resolveDataset(network)
      const chainType = detectChainType(dataset)
      const isHyperliquid = chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds'
      const notices: string[] = []

      if (compare_previous && group_by === 'contract') {
        throw new Error('compare_previous and group_by="contract" cannot be used together in v0.7.7.')
      }

      if (chainType === 'substrate') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_time_series',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin', 'hyperliquidFills'],
          suggestions: [
            'Use portal_debug_query_blocks for block-by-block Substrate inspection right now.',
            'Add a Substrate time-series implementation with event, call, or extrinsic metrics before using this chart tool on Substrate networks.',
          ],
        })
      }

      // Gas-related metrics are EVM-only
      const gasMetrics = ['avg_gas_price', 'gas_used', 'block_utilization', 'transactions_per_block']
      if (gasMetrics.includes(metric) && chainType !== 'evm') {
        throw createUnsupportedMetricError({
          toolName: 'portal_get_time_series',
          metric,
          dataset,
          supportedMetrics: ['transaction_count', 'unique_addresses'],
          reason: 'Gas metrics are available only on EVM datasets.',
        })
      }

      if (group_by === 'contract' && (chainType !== 'evm' || metric !== 'transaction_count')) {
        throw createUnsupportedMetricError({
          toolName: 'portal_get_time_series',
          metric: `${metric}:${group_by}`,
          dataset,
          supportedMetrics: ['transaction_count'],
          reason: 'group_by="contract" is currently supported only for EVM transaction_count.',
        })
      }

      if (compare_previous) {
        if (!['transaction_count', 'avg_gas_price', 'gas_used', 'block_utilization', 'unique_addresses'].includes(metric)) {
          throw createUnsupportedMetricError({
            toolName: 'portal_get_time_series',
            metric,
            dataset,
            supportedMetrics: ['transaction_count', 'avg_gas_price', 'gas_used', 'block_utilization', 'unique_addresses'],
            reason: 'compare_previous currently supports the core scalar metrics only.',
          })
        }

        const durationSeconds = parseTimeframeToSeconds(duration)
        const head = await getBlockHead(dataset)
        const anchorTimestamp = to_timestamp !== undefined
          ? parseTimestampInput(to_timestamp).timestamp
          : await getHeadTimestamp(dataset, head.number)
        const currentEndInclusive = anchorTimestamp
        const currentEndExclusive = currentEndInclusive + 1
        const currentStartTimestamp = currentEndExclusive - durationSeconds
        const previousEndExclusive = currentStartTimestamp
        const previousEndInclusive = previousEndExclusive - 1
        const previousStartTimestamp = previousEndExclusive - durationSeconds

        const [currentSeries, previousSeries] = await Promise.all([
          computeWindowSeries({
            dataset,
            metric: metric as 'transaction_count' | 'avg_gas_price' | 'gas_used' | 'block_utilization' | 'unique_addresses',
            interval,
            duration,
            address,
            fromTimestamp: currentStartTimestamp,
            toTimestampInclusive: currentEndInclusive,
          }),
          computeWindowSeries({
            dataset,
            metric: metric as 'transaction_count' | 'avg_gas_price' | 'gas_used' | 'block_utilization' | 'unique_addresses',
            interval,
            duration,
            address,
            fromTimestamp: previousStartTimestamp,
            toTimestampInclusive: previousEndInclusive,
          }),
        ])

        const comparisonSeries = currentSeries.timeSeries.flatMap((point, bucketIndex) => {
          const previousPoint = previousSeries.timeSeries[bucketIndex]
          return [
            {
              period: 'current',
              bucket_index: bucketIndex,
              timestamp: point.timestamp,
              timestamp_human: point.timestamp_human,
              value: point.value,
            },
            {
              period: 'previous',
              bucket_index: bucketIndex,
              timestamp: previousPoint.timestamp,
              timestamp_human: previousPoint.timestamp_human,
              value: previousPoint.value,
            },
          ]
        })
        const bucketDeltas = currentSeries.timeSeries.map((point, bucketIndex) => {
          const previousPoint = previousSeries.timeSeries[bucketIndex]
          const delta = Number((point.value - previousPoint.value).toFixed(2))
          return {
            bucket_index: bucketIndex,
            current_value: point.value,
            previous_value: previousPoint.value,
            delta,
            pct_change: previousPoint.value === 0 ? null : Number((((point.value - previousPoint.value) / previousPoint.value) * 100).toFixed(2)),
          }
        })
        const summaryRows = [
          {
            label: 'Total',
            current_value: Number(currentSeries.timeSeries.reduce((sum, point) => sum + point.value, 0).toFixed(2)),
            previous_value: Number(previousSeries.timeSeries.reduce((sum, point) => sum + point.value, 0).toFixed(2)),
          },
          {
            label: 'Average bucket value',
            current_value: Number(
              (
                currentSeries.timeSeries.reduce((sum, point) => sum + point.value, 0) /
                Math.max(1, currentSeries.timeSeries.length)
              ).toFixed(2),
            ),
            previous_value: Number(
              (
                previousSeries.timeSeries.reduce((sum, point) => sum + point.value, 0) /
                Math.max(1, previousSeries.timeSeries.length)
              ).toFixed(2),
            ),
          },
        ].map((row) => ({
          ...row,
          delta: Number((row.current_value - row.previous_value).toFixed(2)),
          pct_change: row.previous_value === 0 ? null : Number((((row.current_value - row.previous_value) / row.previous_value) * 100).toFixed(2)),
        }))

        return formatResult({
          summary: {
            metric,
            interval,
            duration,
            compare_previous: true,
          },
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: comparisonSeries.length,
            dataKey: 'comparison_series',
            groupedValueField: 'period',
            xField: 'bucket_index',
            recommendedVisual: 'line',
            title: `${getMetricLabel(metric)}: current vs previous`,
            subtitle: 'Aligned bucket comparison for the selected window and the immediately previous one',
            xAxisLabel: 'Bucket',
            yAxisLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
          }),
          tables: [
            buildTableDescriptor({
              id: 'summary_rows',
              dataKey: 'summary_rows',
              rowCount: summaryRows.length,
              title: 'Comparison summary',
              defaultSort: { key: 'label', direction: 'asc' },
              dense: true,
              columns: [
                { key: 'label', label: 'Metric', kind: 'dimension' },
                { key: 'current_value', label: 'Current', kind: 'metric', format: getMetricValueFormat(metric), align: 'right', ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}) },
                { key: 'previous_value', label: 'Previous', kind: 'metric', format: getMetricValueFormat(metric), align: 'right', ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}) },
                { key: 'delta', label: 'Delta', kind: 'metric', format: getMetricValueFormat(metric), align: 'right', ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}) },
                { key: 'pct_change', label: 'Pct change', kind: 'metric', format: 'percent', unit: '%', align: 'right' },
              ],
            }),
            buildTimeSeriesTable({
              id: 'comparison_series',
              dataKey: 'comparison_series',
              rowCount: comparisonSeries.length,
              title: 'Aligned comparison buckets',
              groupedValueField: 'period',
              groupedValueLabel: 'Period',
              valueLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: getMetricUnit(metric),
              timestampField: 'timestamp',
              defaultSort: { key: 'bucket_index', direction: 'asc' },
            }),
            buildTableDescriptor({
              id: 'bucket_deltas',
              dataKey: 'bucket_deltas',
              rowCount: bucketDeltas.length,
              title: 'Bucket deltas',
              defaultSort: { key: 'bucket_index', direction: 'asc' },
              dense: true,
              columns: [
                { key: 'bucket_index', label: 'Bucket', kind: 'dimension', format: 'integer', align: 'right' },
                { key: 'current_value', label: 'Current', kind: 'metric', format: getMetricValueFormat(metric), align: 'right', ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}) },
                { key: 'previous_value', label: 'Previous', kind: 'metric', format: getMetricValueFormat(metric), align: 'right', ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}) },
                { key: 'delta', label: 'Delta', kind: 'metric', format: getMetricValueFormat(metric), align: 'right', ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}) },
                { key: 'pct_change', label: 'Pct change', kind: 'metric', format: 'percent', unit: '%', align: 'right' },
              ],
            }),
          ],
          summary_rows: summaryRows,
          current_series: currentSeries.timeSeries,
          previous_series: previousSeries.timeSeries,
          comparison_series: comparisonSeries,
          bucket_deltas: bucketDeltas,
          gap_diagnostics: currentSeries.gapDiagnostics,
        }, `Compared ${metric} over the current ${duration} window versus the immediately previous ${duration}.`, {
          toolName: 'portal_get_time_series',
          notices: [...currentSeries.notices, ...previousSeries.notices],
          freshness: currentSeries.freshness,
          coverage: currentSeries.coverage,
          execution: buildExecutionMetadata({
            mode,
            metric,
            interval,
            duration,
            compare_previous: true,
            range_kind: 'timeframe',
          }),
          ui: buildComparePreviousUi(metric),
          metadata: {
            network: dataset,
            dataset,
            from_block: currentSeries.metadata.from_block,
            to_block: currentSeries.metadata.to_block,
            query_start_time: queryStartTime,
          },
        })
      }

      if (group_by === 'contract') {
        const resolvedWindow = await resolveTimeframeOrBlocks({
          dataset,
          timeframe: from_timestamp === undefined && to_timestamp === undefined ? duration : undefined,
          from_timestamp,
          to_timestamp,
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

        await portalFetchStreamRangeVisit(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          {
            type: 'evm',
            fromBlock,
            toBlock,
            fields: {
              block: { number: true, timestamp: true },
              transaction: { to: true },
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
        const buckets = Array.from({ length: expectedBuckets }, (_, bucketIndex) => ({
          timestamp: seriesStartTimestamp + bucketIndex * intervalSeconds,
          total_transactions: 0,
          contract_counts: new Map<string, number>(),
        }))

        await portalFetchStreamRangeVisit(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          {
            type: 'evm',
            fromBlock,
            toBlock,
            fields: {
              block: { number: true, timestamp: true },
              transaction: { to: true },
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
              for (const tx of block.transactions || []) {
                if (!tx.to) continue
                const contract = tx.to.toLowerCase()
                buckets[bucketIndex].total_transactions += 1
                totalTransactions += 1
                buckets[bucketIndex].contract_counts.set(contract, (buckets[bucketIndex].contract_counts.get(contract) || 0) + 1)
                contractTotals.set(contract, (contractTotals.get(contract) || 0) + 1)
              }
            },
          },
        )

        const topContracts = Array.from(contractTotals.entries())
          .map(([address, count]) => ({ address, transaction_count: count }))
          .sort((a, b) => b.transaction_count - a.transaction_count)
          .slice(0, group_limit)
          .map((item, index) => ({ rank: index + 1, ...item }))

        const timeSeries = buckets.flatMap((bucket, bucketIndex) =>
          topContracts.map((contract) => ({
            bucket_index: bucketIndex,
            timestamp: bucket.timestamp,
            timestamp_human: formatTimestamp(bucket.timestamp),
            contract_address: contract.address,
            rank: contract.rank,
            transaction_count: bucket.contract_counts.get(contract.address) || 0,
            value: bucket.contract_counts.get(contract.address) || 0,
            blocks_in_bucket: bucket.total_transactions > 0 ? 1 : 0,
          })),
        )
        const filledBuckets = buckets.filter((bucket) => bucket.total_transactions > 0).length
        const gapDiagnostics = buildBucketGapDiagnostics({
          buckets: buckets.map((bucket, bucketIndex) => ({
            bucket_index: bucketIndex,
            timestamp: bucket.timestamp,
            blocks_in_bucket: bucket.total_transactions > 0 ? 1 : 0,
          })),
          intervalSeconds,
          isFilled: (bucket) => bucket.blocks_in_bucket > 0,
          anchor: 'latest_block',
          windowComplete:
            firstObservedTimestamp !== undefined ? firstObservedTimestamp <= seriesStartTimestamp : true,
        })

        return formatResult({
          summary: {
            metric,
            interval,
            duration,
            group_by,
            group_limit,
            tracked_contracts: topContracts.length,
            total_transactions: totalTransactions,
            from_block: fromBlock,
            to_block: toBlock,
          },
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: timeSeries.length,
            groupedValueField: 'contract_address',
            recommendedVisual: 'stacked_area',
            dataKey: 'time_series',
            title: `${getMetricLabel(metric)} by contract`,
            subtitle: 'Top-ranked contracts split into bucketed activity over the requested window',
            yAxisLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
          }),
          tables: [
            buildTableDescriptor({
              id: 'top_contracts',
              dataKey: 'top_contracts',
              rowCount: topContracts.length,
              title: 'Tracked contracts',
              keyField: 'address',
              defaultSort: { key: 'rank', direction: 'asc' },
              dense: true,
              columns: [
                { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
                { key: 'address', label: 'Contract', kind: 'dimension', format: 'address' },
                { key: 'transaction_count', label: 'Transactions', kind: 'metric', format: 'integer', align: 'right' },
              ],
            }),
            buildTimeSeriesTable({
              id: 'contract_series',
              dataKey: 'time_series',
              rowCount: timeSeries.length,
              title: 'Bucketed contract activity',
              groupedValueField: 'contract_address',
              groupedValueLabel: 'Contract',
              valueLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: getMetricUnit(metric),
              timestampField: 'timestamp',
              blocksInBucketField: 'blocks_in_bucket',
              extraColumns: [
                { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
              ],
              keyField: 'contract_address',
              defaultSort: { key: 'timestamp', direction: 'asc' },
            }),
          ],
          top_contracts: topContracts,
          gap_diagnostics: gapDiagnostics,
          time_series: timeSeries,
        }, `Tracked ${topContracts.length} top contracts over ${duration} in ${interval} buckets.`, {
          toolName: 'portal_get_time_series',
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
          }),
          execution: buildExecutionMetadata({
            mode,
            metric,
            interval,
            duration,
            group_by,
            range_kind: resolvedWindow.range_kind,
            from_block: fromBlock,
            to_block: toBlock,
          }),
          ui: buildGroupedContractUi(),
          metadata: {
            network: dataset,
            dataset,
            from_block: fromBlock,
            to_block: toBlock,
            query_start_time: queryStartTime,
          },
        })
      }

      if (chainType === 'solana' && ['transaction_count', 'unique_addresses', 'tps', 'avg_fee', 'success_rate', 'slots_per_hour'].includes(metric)) {
        const head = await getBlockHead(dataset)
        const solanaResult = await computeSolanaTimeSeries({
          dataset,
          metric:
            metric === 'unique_addresses'
              ? 'unique_wallets'
              : metric === 'tps' || metric === 'avg_fee' || metric === 'success_rate' || metric === 'slots_per_hour'
                ? metric
                : 'transaction_count',
          interval,
          duration: duration as '1h' | '6h' | '24h' | '7d',
          trimIncompleteLastBucket: false,
          ...(from_timestamp !== undefined || to_timestamp !== undefined
            ? {
                from_timestamp,
                to_timestamp,
              }
            : {}),
        })

        const filledBuckets = solanaResult.time_series.filter((point) => point.slots_in_bucket > 0).length
        const summary: any = {
          metric,
          interval,
          duration,
          mode,
          total_buckets: solanaResult.time_series.length,
          expected_buckets: solanaResult.expected_buckets,
          filled_buckets: filledBuckets,
          empty_buckets: solanaResult.expected_buckets - filledBuckets,
          total_blocks: solanaResult.total_slots,
          returned_blocks: solanaResult.returned_blocks,
          from_block: solanaResult.from_block,
          to_block: solanaResult.to_block,
          observed_span_seconds: solanaResult.observed_span_seconds,
          observed_span_formatted: solanaResult.observed_span_formatted,
          statistics: {
            avg: solanaResult.statistics.avg,
            min: solanaResult.statistics.min,
            max: solanaResult.statistics.max,
          },
        }

        if (solanaResult.chunks_fetched > 1) {
          summary.chunks_fetched = solanaResult.chunks_fetched
        }
        if (solanaResult.chunk_size_reduced) {
          summary.chunk_size_reduced = true
        }
        if (mode === 'fast') {
          notices.push('Solana native metrics already use the optimized fast path, so fast and deep modes behave the same here.')
        }

        const normalizedTimeSeries = solanaResult.time_series.map((point) => ({
          bucket_index: point.bucket_index,
          timestamp: point.timestamp,
          timestamp_human: point.timestamp_human,
          blocks_in_bucket: point.slots_in_bucket,
          value: point.value,
        }))
        const gapDiagnostics = buildBucketGapDiagnostics({
          buckets: normalizedTimeSeries,
          intervalSeconds: parseTimeframeToSeconds(interval),
          isFilled: (bucket) => bucket.blocks_in_bucket > 0,
          anchor: 'latest_block',
          windowComplete:
            solanaResult.first_observed_timestamp !== undefined
              ? solanaResult.first_observed_timestamp <= normalizedTimeSeries[0]?.timestamp
              : true,
          ...(solanaResult.first_observed_timestamp !== undefined
            ? { firstObservedTimestamp: solanaResult.first_observed_timestamp }
            : {}),
          ...(solanaResult.last_observed_timestamp !== undefined
            ? { lastObservedTimestamp: solanaResult.last_observed_timestamp }
            : {}),
        })

        return formatResult(
          {
            summary,
            chart: buildTimeSeriesChart({
              interval,
              totalPoints: solanaResult.time_series.length,
              title: `Solana ${getMetricLabel(metric)}`,
              subtitle: `Bucketed ${getMetricLabel(metric).toLowerCase()} across the selected Solana window`,
              yAxisLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: solanaResult.unit,
            }),
            tables: [
              buildTimeSeriesTable({
                rowCount: normalizedTimeSeries.length,
                title: 'Time series buckets',
                valueLabel: getMetricLabel(metric),
                valueFormat: getMetricValueFormat(metric),
                unit: solanaResult.unit,
                timestampField: 'timestamp',
                blocksInBucketField: 'blocks_in_bucket',
                blocksInBucketLabel: 'Slots',
                defaultSort: { key: 'bucket_index', direction: 'asc' },
              }),
            ],
            gap_diagnostics: gapDiagnostics,
            time_series: normalizedTimeSeries,
          },
          `Aggregated ${metric} over ${duration} in ${interval} intervals. ${solanaResult.time_series.length} data points (${filledBuckets} with data). Avg: ${solanaResult.statistics.avg.toFixed(2)}, Min: ${solanaResult.statistics.min.toFixed(2)}, Max: ${solanaResult.statistics.max.toFixed(2)}`,
          {
            toolName: 'portal_get_time_series',
            freshness: buildQueryFreshness({
              finality: 'latest',
              headBlockNumber: head.number,
              windowToBlock: solanaResult.to_block,
              resolvedWindow: { range_kind: 'timeframe' },
            }),
            coverage: buildBucketCoverage({
              expectedBuckets: solanaResult.expected_buckets,
              returnedBuckets: solanaResult.time_series.length,
              filledBuckets,
              anchor: 'latest_block',
              windowComplete:
                solanaResult.first_observed_timestamp !== undefined
                  ? solanaResult.first_observed_timestamp <= normalizedTimeSeries[0]?.timestamp
                  : true,
            }),
            execution: buildExecutionMetadata({
              mode,
              metric,
              interval,
              duration,
              from_block: solanaResult.from_block,
              to_block: solanaResult.to_block,
              range_kind: 'timeframe',
            }),
            ui: buildSimpleSeriesUi({
              title: `Solana ${getMetricLabel(metric)}`,
              subtitle: `${interval} buckets over ${duration}`,
              metricLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: solanaResult.unit,
              avgValuePath: 'summary.statistics.avg',
              followUpActions: [
                { label: 'Show raw bucket rows', intent: 'show_raw', target: 'time_series' },
                { label: 'Zoom into the latest buckets', intent: 'zoom_in', target: 'chart' },
                { label: 'Compare against the previous window', intent: 'compare_previous' },
              ],
            }),
            metadata: {
              network: dataset,
              dataset,
              from_block: solanaResult.from_block,
              to_block: solanaResult.to_block,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      if (isHyperliquid && ['volume', 'fill_count', 'unique_traders'].includes(metric)) {
        const resolvedWindow = await resolveTimeframeOrBlocks({
          dataset,
          ...(from_timestamp !== undefined || to_timestamp !== undefined
            ? { from_timestamp, to_timestamp }
            : { timeframe: duration }),
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
        const buckets = new Map<number, { fills: number; volume: number; traders: Set<number> }>()
        let latestTimestamp = 0
        let firstObservedTimestamp: number | undefined

        const getBucket = (bucketTimestamp: number) => {
          let bucket = buckets.get(bucketTimestamp)
          if (!bucket) {
            bucket = { fills: 0, volume: 0, traders: new Set<number>() }
            buckets.set(bucketTimestamp, bucket)
          }
          return bucket
        }

        await visitHyperliquidFillBlocks({
          dataset,
          fromBlock,
          toBlock,
          fillFilter: {},
          fillFields: {
            time: true,
            px: true,
            sz: true,
            user: true,
          },
          maxBytes: 150 * 1024 * 1024,
          concurrency: 3,
          onBlock: (block) => {
            for (const fill of block.fills || []) {
              const ts = Number(fill.time || 0) > 1e12 ? Math.floor(Number(fill.time) / 1000) : Math.floor(Number(fill.time || 0))
              if (!ts) continue
              latestTimestamp = Math.max(latestTimestamp, ts)
              if (firstObservedTimestamp === undefined || ts < firstObservedTimestamp) firstObservedTimestamp = ts
              const bucketTimestamp = Math.floor(ts / intervalSeconds) * intervalSeconds
              const bucket = getBucket(bucketTimestamp)
              bucket.fills += 1
              bucket.volume += Number(fill.px || 0) * Number(fill.sz || 0)
              if (typeof fill.user === 'string') bucket.traders.add(hashString53(fill.user))
            }
          },
        })

        const seriesEndExclusive = Math.floor(latestTimestamp / intervalSeconds) * intervalSeconds + intervalSeconds
        const seriesStartTimestamp = seriesEndExclusive - durationSeconds
        const timeSeries = Array.from({ length: expectedBuckets }, (_, bucketIndex) => {
          const bucketTimestamp = seriesStartTimestamp + bucketIndex * intervalSeconds
          const bucket = buckets.get(bucketTimestamp)
          const value =
            metric === 'volume'
              ? bucket?.volume ?? 0
              : metric === 'unique_traders'
                ? bucket?.traders.size ?? 0
                : bucket?.fills ?? 0
          return {
            bucket_index: bucketIndex,
            timestamp: bucketTimestamp,
            timestamp_human: formatTimestamp(bucketTimestamp),
            blocks_in_bucket: bucket && (bucket.fills > 0 || bucket.traders.size > 0 || bucket.volume > 0) ? 1 : 0,
            value: Number(value.toFixed ? value.toFixed(2) : value),
          }
        })
        const filledBuckets = timeSeries.filter((bucket) => bucket.blocks_in_bucket > 0).length
        return formatResult({
          summary: {
            metric,
            interval,
            duration,
            total_buckets: timeSeries.length,
            filled_buckets: filledBuckets,
            from_block: fromBlock,
            to_block: toBlock,
          },
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: timeSeries.length,
            title: `Hyperliquid ${getMetricLabel(metric)}`,
            subtitle: `Bucketed ${getMetricLabel(metric).toLowerCase()} across the selected Hyperliquid window`,
            yAxisLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
          }),
          tables: [
            buildTimeSeriesTable({
              rowCount: timeSeries.length,
              title: 'Time series buckets',
              valueLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: getMetricUnit(metric),
              timestampField: 'timestamp',
              blocksInBucketField: 'blocks_in_bucket',
              blocksInBucketLabel: 'Buckets with fills',
              defaultSort: { key: 'bucket_index', direction: 'asc' },
            }),
          ],
          gap_diagnostics: buildBucketGapDiagnostics({
            buckets: timeSeries,
            intervalSeconds,
            isFilled: (bucket) => bucket.blocks_in_bucket > 0,
            anchor: 'latest_fill',
            windowComplete: firstObservedTimestamp !== undefined ? firstObservedTimestamp <= seriesStartTimestamp : true,
          }),
          time_series: timeSeries,
        }, `Aggregated Hyperliquid ${metric} over ${duration} in ${interval} intervals.`, {
          toolName: 'portal_get_time_series',
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: toBlock,
            resolvedWindow,
          }),
          coverage: buildBucketCoverage({
            expectedBuckets,
            returnedBuckets: timeSeries.length,
            filledBuckets,
            anchor: 'latest_fill',
          }),
          execution: buildExecutionMetadata({
            mode,
            metric,
            interval,
            duration,
            from_block: fromBlock,
            to_block: toBlock,
            range_kind: resolvedWindow.range_kind,
          }),
          ui: buildSimpleSeriesUi({
            title: `Hyperliquid ${getMetricLabel(metric)}`,
            subtitle: `${interval} buckets over ${duration}`,
            metricLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
            primaryValuePath: 'summary.total_buckets',
            primaryLabel: 'Buckets',
            followUpActions: [
              { label: 'Show raw bucket rows', intent: 'show_raw', target: 'time_series' },
              { label: 'Zoom into the latest buckets', intent: 'zoom_in', target: 'chart' },
              { label: 'Compare against the previous window', intent: 'compare_previous' },
            ],
          }),
          metadata: {
            network: dataset,
            dataset,
            from_block: fromBlock,
            to_block: toBlock,
            query_start_time: queryStartTime,
          },
        })
      }

      if (isHyperliquid) {
        throw createUnsupportedMetricError({
          toolName: 'portal_get_time_series',
          metric,
          dataset,
          supportedMetrics: ['volume', 'fill_count', 'unique_traders'],
          reason: 'These are the currently supported Hyperliquid metrics for the unified time-series tool.',
        })
      }

      if (chainType === 'bitcoin' && ['fees_btc', 'block_size_bytes'].includes(metric)) {
        const resolvedWindow = await resolveTimeframeOrBlocks({
          dataset,
          ...(from_timestamp !== undefined || to_timestamp !== undefined
            ? { from_timestamp, to_timestamp }
            : { timeframe: duration }),
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
        const blockResults = await portalFetchStream(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          {
            type: 'bitcoin',
            fromBlock,
            toBlock,
            includeAllBlocks: true,
            fields: {
              block: { number: true, timestamp: true },
              transaction: { transactionIndex: true, size: true },
            },
            transactions: [{}],
          },
          { maxBytes: 100 * 1024 * 1024 },
        ) as TimeSeriesBlock[]
        if (blockResults.length === 0) throw new Error('No data available for this time period')

        const firstTimestamp = getBlockTimestamp(blockResults[0])!
        const lastTimestamp = getBlockTimestamp(blockResults[blockResults.length - 1])!
        const seriesStartTimestamp = lastTimestamp - durationSeconds
        const buckets = createBucketAccumulators(expectedBuckets, seriesStartTimestamp, intervalSeconds)
        blockResults.forEach((block) => {
          const timestamp = getBlockTimestamp(block)
          const blockNumber = getBlockNumber(block)
          if (timestamp === undefined || blockNumber === undefined) return
          const bucketIndex = Math.floor((timestamp - seriesStartTimestamp) / intervalSeconds)
          if (bucketIndex < 0 || bucketIndex >= expectedBuckets) return
          const bucket = buckets[bucketIndex]
          bucket.blocksInBucket += 1
          bucket.firstBlockNumber = bucket.firstBlockNumber ?? blockNumber
          bucket.lastBlockNumber = blockNumber
          bucket.txCount += block.transactions?.length || 0
          bucket.gasUsedSum += (block.transactions || []).reduce((sum, tx: any) => sum + Number(tx.size || 0), 0)
        })
        const timeSeries = buckets.map((bucket) => ({
          bucket_index: bucket.bucketIndex,
          timestamp: bucket.bucketTimestamp,
          timestamp_human: formatTimestamp(bucket.bucketTimestamp),
          blocks_in_bucket: bucket.blocksInBucket,
          value: metric === 'block_size_bytes' ? bucket.gasUsedSum : 0,
        }))
        const filledBuckets = buckets.filter((bucket) => bucket.blocksInBucket > 0).length
        return formatResult({
          summary: { metric, interval, duration, from_block: fromBlock, to_block: toBlock, total_buckets: timeSeries.length, filled_buckets: filledBuckets },
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: timeSeries.length,
            title: `Bitcoin ${getMetricLabel(metric)}`,
            yAxisLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
          }),
          tables: [
            buildTimeSeriesTable({
              rowCount: timeSeries.length,
              title: 'Time series buckets',
              valueLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: getMetricUnit(metric),
              timestampField: 'timestamp',
              blocksInBucketField: 'blocks_in_bucket',
              defaultSort: { key: 'bucket_index', direction: 'asc' },
            }),
          ],
          gap_diagnostics: buildBucketGapDiagnostics({
            buckets: timeSeries,
            intervalSeconds,
            isFilled: (bucket) => bucket.blocks_in_bucket > 0,
            anchor: 'latest_block',
            windowComplete: firstTimestamp <= seriesStartTimestamp,
          }),
          time_series: timeSeries,
        }, `Aggregated Bitcoin ${metric} over ${duration} in ${interval} intervals.`, {
          toolName: 'portal_get_time_series',
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: toBlock,
            resolvedWindow,
          }),
          coverage: buildBucketCoverage({
            expectedBuckets,
            returnedBuckets: timeSeries.length,
            filledBuckets,
            anchor: 'latest_block',
          }),
          execution: buildExecutionMetadata({
            mode,
            metric,
            interval,
            duration,
            from_block: fromBlock,
            to_block: toBlock,
            range_kind: resolvedWindow.range_kind,
          }),
          metadata: {
            network: dataset,
            dataset,
            from_block: fromBlock,
            to_block: toBlock,
            query_start_time: queryStartTime,
          },
        })
      }

      // Get block range using Portal's /timestamps/ API
      const resolvedWindow = await resolveTimeframeOrBlocks({
        dataset,
        ...(from_timestamp !== undefined || to_timestamp !== undefined
          ? { from_timestamp, to_timestamp }
          : { timeframe: duration }),
      })
      const fromBlock = resolvedWindow.from_block
      const { validatedToBlock: toBlock, head } = await validateBlockRange(
        dataset,
        fromBlock,
        resolvedWindow.to_block ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      // Calculate bucket size based on interval duration
      const intervalSeconds = parseTimeframeToSeconds(interval)
      const durationSeconds = parseTimeframeToSeconds(duration)
      const expectedBuckets = Math.ceil(durationSeconds / intervalSeconds)

      // Build chain-specific query
      const queryType = chainType === 'solana' ? 'solana' : chainType === 'bitcoin' ? 'bitcoin' : 'evm'
      const blockFieldKey = 'block'

      const baseFields: any = {
        [blockFieldKey]: { number: true, timestamp: true },
      }
      const queryExtras: any = {}

      if (metric === 'transaction_count' || metric === 'transactions_per_block' || metric === 'unique_addresses') {
        baseFields.transaction = chainType === 'solana' && metric === 'unique_addresses'
          ? { feePayer: true }
          : { transactionIndex: true }
        if (metric === 'unique_addresses') {
          if (chainType === 'solana') {
            baseFields.transaction.feePayer = true
          } else {
            baseFields.transaction.from = true
            baseFields.transaction.to = true
          }
        }
        if (address && chainType === 'evm') {
          queryExtras.transactions = [{ to: [address.toLowerCase()] }]
        } else {
          queryExtras.transactions = [{}]
        }
      } else if (metric === 'avg_gas_price') {
        baseFields[blockFieldKey].baseFeePerGas = true
      } else if (metric === 'gas_used' || metric === 'block_utilization') {
        baseFields[blockFieldKey].gasUsed = true
        baseFields[blockFieldKey].gasLimit = true
      }

      // Chunk large ranges to avoid Portal API size limits
      const totalBlocks = toBlock - fromBlock
      const hasTxData = metric === 'transaction_count' || metric === 'transactions_per_block' || metric === 'unique_addresses'
      const initialChunkSize =
        chainType === 'solana' && hasTxData
          ? (SOLANA_GENERIC_TIME_SERIES_CHUNK_SIZE[metric] ?? 1000)
          : hasTxData
            ? 5000
            : 10000
      const sortResults = (items: TimeSeriesBlock[]) =>
        items.sort((left, right) => (getBlockNumber(left) || 0) - (getBlockNumber(right) || 0))

      async function fetchBlocks(rangeFrom: number, rangeTo: number): Promise<TimeSeriesBlock[]> {
        if (rangeFrom > rangeTo) {
          return []
        }

        const results: TimeSeriesBlock[] = []
        let currentFrom = rangeFrom
        let chunkSize = initialChunkSize

        while (currentFrom <= rangeTo) {
          const plannedTo = Math.min(currentFrom + chunkSize - 1, rangeTo)
          const query = {
            type: queryType,
            fromBlock: currentFrom,
            toBlock: plannedTo,
            includeAllBlocks: true,
            fields: baseFields,
            ...queryExtras,
          }

          let chunk: TimeSeriesBlock[]
          try {
            chunk = await portalFetchStream(
              `${PORTAL_URL}/datasets/${dataset}/stream`,
              query,
              {
                maxBytes: chainType === 'solana' && hasTxData ? SOLANA_GENERIC_MAX_BYTES : 100 * 1024 * 1024,
              },
            ) as TimeSeriesBlock[]
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)

            if (
              chainType === 'solana' &&
              hasTxData &&
              message.includes('Response too large') &&
              chunkSize > MIN_SOLANA_GENERIC_CHUNK_SIZE
            ) {
              chunkSize = Math.max(MIN_SOLANA_GENERIC_CHUNK_SIZE, Math.floor(chunkSize / 2))
              continue
            }

            throw err
          }

          if (chunk.length === 0) {
            break
          }

          sortResults(chunk)
          results.push(...chunk)

          const lastReturnedBlock = getBlockNumber(chunk[chunk.length - 1])
          if (lastReturnedBlock === undefined || lastReturnedBlock < currentFrom) {
            break
          }

          currentFrom = lastReturnedBlock + 1
        }

        return results
      }

      let effectiveFromBlock = fromBlock
      let backfillAttempts = 0
      let results = await fetchBlocks(effectiveFromBlock, toBlock)

      if (results.length === 0) {
        throw new Error('No data available for this time period')
      }

      sortResults(results)

      if (mode === 'fast' && !address) {
        notices.push('Fast mode skips extra backfill scans. Switch to mode="deep" if you want the tool to fill leading buckets more aggressively.')
      }

      while (mode === 'deep' && !address && backfillAttempts < 2) {
        const firstBlock = results[0]
        const lastBlock = results[results.length - 1]
        const firstResultBlockNumber = getBlockNumber(firstBlock)
        const firstResultTimestamp = getBlockTimestamp(firstBlock)
        const lastResultBlockNumber = getBlockNumber(lastBlock)
        const endTimestamp = getBlockTimestamp(lastBlock)

        if (
          firstResultBlockNumber === undefined ||
          lastResultBlockNumber === undefined ||
          firstResultTimestamp === undefined ||
          endTimestamp === undefined
        ) {
          break
        }

        const observedSpanSeconds = Math.max(0, endTimestamp - firstResultTimestamp)
        if (observedSpanSeconds >= durationSeconds * 0.98) {
          break
        }

        if (firstResultBlockNumber <= 0 || lastResultBlockNumber <= firstResultBlockNumber || observedSpanSeconds <= 0) {
          break
        }

        const secondsPerBlock = observedSpanSeconds / (lastResultBlockNumber - firstResultBlockNumber)
        if (!Number.isFinite(secondsPerBlock) || secondsPerBlock <= 0) {
          break
        }

        const missingSeconds = durationSeconds - observedSpanSeconds
        const missingBlocksEstimate = Math.ceil((missingSeconds + intervalSeconds) / secondsPerBlock)
        const bufferBlocks = Math.max(100, Math.ceil(missingBlocksEstimate * 0.1))
        const backfillToBlock = firstResultBlockNumber - 1
        const backfillFromBlock = Math.max(0, backfillToBlock - missingBlocksEstimate - bufferBlocks)

        if (backfillFromBlock >= effectiveFromBlock || backfillToBlock < backfillFromBlock) {
          break
        }

        const extraResults = await fetchBlocks(backfillFromBlock, backfillToBlock)
        if (extraResults.length === 0) {
          break
        }

        effectiveFromBlock = backfillFromBlock
        results = [...extraResults, ...results]
        sortResults(results)
        backfillAttempts++
      }

      const firstBlock = results[0] as TimeSeriesBlock
      const lastBlock = results[results.length - 1] as TimeSeriesBlock
      const firstResultTimestamp = getBlockTimestamp(firstBlock)
      const endTimestamp = getBlockTimestamp(lastBlock)

      if (!firstResultTimestamp || !endTimestamp) {
        throw new Error('Could not extract timestamps from block data')
      }

      // Anchor buckets to the latest indexed block so the series always covers the requested duration.
      // This avoids dropping leading/trailing intervals when the first returned block is slightly misaligned.
      const seriesStartTimestamp = endTimestamp - durationSeconds
      const buckets = createBucketAccumulators(expectedBuckets, seriesStartTimestamp, intervalSeconds)

      results.forEach((block) => {
        const typedBlock = block as TimeSeriesBlock
        const blockNumber = getBlockNumber(typedBlock)
        const timestamp = getBlockTimestamp(typedBlock)

        if (blockNumber === undefined || timestamp === undefined) {
          return
        }

        const bucketIndex = Math.floor((timestamp - seriesStartTimestamp) / intervalSeconds)
        if (bucketIndex < 0 || bucketIndex >= expectedBuckets) {
          return
        }

        const bucket = buckets[bucketIndex]
        bucket.blocksInBucket++
        bucket.firstBlockNumber = bucket.firstBlockNumber ?? blockNumber
        bucket.lastBlockNumber = blockNumber

        if (metric === 'transaction_count' || metric === 'transactions_per_block') {
          bucket.txCount += typedBlock.transactions?.length || 0
          return
        }

        if (metric === 'avg_gas_price') {
          const baseFeePerGas = getBlockBigIntString(typedBlock, 'baseFeePerGas')
          if (baseFeePerGas) {
            bucket.gasPriceSum += parseInt(baseFeePerGas)
            bucket.gasPriceCount++
          }
          return
        }

        if (metric === 'gas_used') {
          bucket.gasUsedSum += parseInt(getBlockBigIntString(typedBlock, 'gasUsed') || '0')
          return
        }

        if (metric === 'block_utilization') {
          const gasUsed = parseInt(getBlockBigIntString(typedBlock, 'gasUsed') || '0')
          const gasLimit = parseInt(getBlockBigIntString(typedBlock, 'gasLimit') || '0')
          if (gasLimit > 0) {
            bucket.utilizationSum += (gasUsed / gasLimit) * 100
            bucket.utilizationCount++
          }
          return
        }

        if (metric === 'unique_addresses') {
          typedBlock.transactions?.forEach((tx) => {
            if (tx.feePayer) bucket.addresses.add(tx.feePayer)
            if (tx.from) bucket.addresses.add(tx.from.toLowerCase())
            if (tx.to) bucket.addresses.add(tx.to.toLowerCase())
          })
        }
      })

      const timeSeries = buckets.map((bucket) => {
        let value = 0

        if (metric === 'transaction_count') {
          value = bucket.txCount
        } else if (metric === 'transactions_per_block') {
          value = bucket.blocksInBucket > 0 ? bucket.txCount / bucket.blocksInBucket : 0
        } else if (metric === 'avg_gas_price') {
          value = bucket.gasPriceCount > 0 ? bucket.gasPriceSum / bucket.gasPriceCount / 1e9 : 0
        } else if (metric === 'gas_used') {
          value = bucket.gasUsedSum
        } else if (metric === 'block_utilization') {
          value = bucket.utilizationCount > 0 ? bucket.utilizationSum / bucket.utilizationCount : 0
        } else if (metric === 'unique_addresses') {
          value = bucket.addresses.size
        }

        const entry: Record<string, unknown> = {
          bucket_index: bucket.bucketIndex,
          timestamp: bucket.bucketTimestamp,
          timestamp_human: formatTimestamp(bucket.bucketTimestamp),
          blocks_in_bucket: bucket.blocksInBucket,
          value: parseFloat(value.toFixed(2)),
        }

        if (bucket.firstBlockNumber !== undefined && bucket.lastBlockNumber !== undefined) {
          entry.block_range = `${bucket.firstBlockNumber}-${bucket.lastBlockNumber}`
        }

        return entry
      })

      // Calculate summary statistics
      const values = timeSeries.map((t) => t.value as number)
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length
      const min = Math.min(...values)
      const max = Math.max(...values)
      const filledBuckets = buckets.filter((bucket) => bucket.blocksInBucket > 0).length
      const observedSpanSeconds = Math.max(0, endTimestamp - firstResultTimestamp)
      const observedCoveragePct = durationSeconds > 0 ? (observedSpanSeconds / durationSeconds) * 100 : 100
      const hasCoverageGap = !address && observedCoveragePct < 80

      // Detect chain head staleness (most relevant for Bitcoin/slow chains)
      const nowUnix = Math.floor(Date.now() / 1000)
      const headAgeSec = nowUnix - endTimestamp
      const headAgeWarning =
        headAgeSec > 1800
          ? `Chain head is ${formatDuration(headAgeSec)} behind wall-clock time (last block: ${formatTimestamp(endTimestamp)}, now: ${formatTimestamp(nowUnix)}). Empty buckets near the end mean no blocks were produced yet, not missing data.`
          : undefined

      const summary: any = {
        metric,
        interval,
        duration,
        mode,
        total_buckets: timeSeries.length,
        expected_buckets: expectedBuckets,
        filled_buckets: filledBuckets,
        empty_buckets: expectedBuckets - filledBuckets,
        total_blocks: results.length,
        from_block: effectiveFromBlock,
        to_block: toBlock,
        observed_span_seconds: observedSpanSeconds,
        observed_span_formatted: formatDuration(observedSpanSeconds),
        statistics: {
          avg: parseFloat(avg.toFixed(2)),
          min: parseFloat(min.toFixed(2)),
          max: parseFloat(max.toFixed(2)),
        },
      }

      if (headAgeWarning) {
        notices.push(headAgeWarning)
      } else if (hasCoverageGap) {
        notices.push(
          `Available data spans only ${formatDuration(observedSpanSeconds)} of the requested ${duration}. The estimated block range may be too small for ${dataset}.`,
        )
      }

      if (address) {
        ;(summary as any).filtered_by_address = address
      }
      if (backfillAttempts > 0) {
        summary.backfill_attempts = backfillAttempts
      }

      const resultMessage = hasCoverageGap
        ? `Aggregated ${metric} over ${duration} in ${interval} intervals with limited coverage. Observed ${formatDuration(observedSpanSeconds)} of on-chain data. Avg: ${avg.toFixed(2)}, Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}`
        : `Aggregated ${metric} over ${duration} in ${interval} intervals. ${timeSeries.length} data points (${filledBuckets} with data). Avg: ${avg.toFixed(2)}, Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}`
      const gapDiagnostics = buildBucketGapDiagnostics({
        buckets: timeSeries as Array<{ bucket_index: number; timestamp: number; timestamp_human?: string; blocks_in_bucket: number }>,
        intervalSeconds,
        isFilled: (bucket) => bucket.blocks_in_bucket > 0,
        anchor: 'latest_block',
        windowComplete: !hasCoverageGap,
        ...(firstResultTimestamp > 0 ? { firstObservedTimestamp: firstResultTimestamp } : {}),
        ...(endTimestamp > 0 ? { lastObservedTimestamp: endTimestamp } : {}),
      })

      return formatResult(
        {
          summary,
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: timeSeries.length,
            title: getMetricLabel(metric),
            subtitle: `Bucketed ${getMetricLabel(metric).toLowerCase()} across the selected window`,
            yAxisLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
          }),
          tables: [
            buildTimeSeriesTable({
              rowCount: timeSeries.length,
              title: 'Time series buckets',
              valueLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: getMetricUnit(metric),
              timestampField: 'timestamp',
              blocksInBucketField: 'blocks_in_bucket',
              defaultSort: { key: 'bucket_index', direction: 'asc' },
            }),
          ],
          gap_diagnostics: gapDiagnostics,
          time_series: timeSeries,
        },
        resultMessage,
        {
          toolName: 'portal_get_time_series',
          notices,
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: toBlock,
            resolvedWindow,
          }),
          coverage: buildBucketCoverage({
            expectedBuckets,
            returnedBuckets: timeSeries.length,
            filledBuckets,
            anchor: 'latest_block',
          }),
          execution: buildExecutionMetadata({
            mode,
            metric,
            interval,
            duration,
            from_block: effectiveFromBlock,
            to_block: toBlock,
            range_kind: resolvedWindow.range_kind,
          }),
          ui: buildSimpleSeriesUi({
            title: getMetricLabel(metric),
            subtitle: `${interval} buckets over ${duration}`,
            metricLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
            avgValuePath: 'summary.statistics.avg',
            followUpActions: [
              { label: 'Show raw bucket rows', intent: 'show_raw', target: 'time_series' },
              { label: 'Zoom into the latest buckets', intent: 'zoom_in', target: 'chart' },
              { label: 'Compare against the previous window', intent: 'compare_previous' },
            ],
          }),
          metadata: {
            network: dataset,
            dataset,
            from_block: effectiveFromBlock,
            to_block: toBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
