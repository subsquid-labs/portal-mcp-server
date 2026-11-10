import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { getBlockHead, resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { createQueryCache, stableCacheKey } from '../../cache/query-cache.js'
import { PORTAL_URL } from '../../constants/index.js'
import { fetchBitcoinBlockFees, satsToBtcString } from '../../helpers/bitcoin-fees.js'
import { detectChainType } from '../../helpers/chain.js'
import {
  type TableValueFormat,
  buildTableDescriptor,
  buildTimeSeriesChart,
  buildTimeSeriesTable,
} from '../../helpers/chart-metadata.js'
import { ActionableError, createUnsupportedChainError, createUnsupportedMetricError } from '../../helpers/errors.js'
import {
  EXACT_DECIMAL_ZERO,
  type ExactDecimal,
  addExactDecimals,
  formatExactDecimal,
  multiplyExactDecimals,
  parseExactDecimal,
} from '../../helpers/exact-decimal.js'
import { portalFetchStream, portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { formatBTC, formatDuration, formatResult, formatTimestamp, formatUSD } from '../../helpers/format.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import { buildTimeSeriesPipesRecipe } from '../../helpers/pipes-recipe.js'
import { buildBucketCoverage, buildBucketGapDiagnostics, buildQueryFreshness } from '../../helpers/result-metadata.js'
import {
  type TimestampInput,
  describeTimeWindowInput,
  estimateBlockTime,
  getHeadTimestamp,
  getTimestampWindowNotices,
  parseTimeframeToSeconds,
  parseTimestampInput,
  resolveTimeframeOrBlocks,
} from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { buildChartPanel, buildMetricCard, buildPortalUi, buildTablePanel } from '../../helpers/ui-metadata.js'
import { visitHyperliquidFillBlocks } from '../hyperliquid/fill-stream.js'
import { computeSolanaTimeSeries } from '../solana/time-series-shared.js'
import { computeWindowSeries } from './compare-periods.js'

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

/*
 * What each chain family actually computes. Kept beside the metric enum
 * because the enum is the union of every family's metrics, and a request is
 * only meaningful against one family at a time.
 */
type SupportedFamily = 'evm' | 'solana' | 'bitcoin' | 'hyperliquid'

const SUPPORTED_METRICS: Record<SupportedFamily, readonly TimeSeriesMetric[]> = {
  evm: [
    'transaction_count',
    'transactions_per_block',
    'avg_gas_price',
    'gas_used',
    'block_utilization',
    'unique_addresses',
  ],
  solana: ['transaction_count', 'unique_addresses', 'tps', 'avg_fee', 'success_rate', 'slots_per_hour'],
  bitcoin: ['transaction_count', 'unique_addresses', 'fees_btc', 'block_size_bytes'],
  hyperliquid: ['volume', 'fill_count', 'unique_traders'],
}

/* The schema enum has to list every metric; which ones a chain family
   computes is stated in the description so a client is not sent after
   success_rate on an EVM network. */
const METRIC_FAMILY_TEXT = (Object.entries(SUPPORTED_METRICS) as [string, readonly string[]][])
  .map(([family, metrics]) => `${family}: ${metrics.join(', ')}`)
  .join('; ')

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

const DEFAULT_TIME_SERIES_DURATION = '6h'
const DEFAULT_BASE_TIME_SERIES_DURATION = '15m'
const INTERACTIVE_TIME_SERIES_WINDOW_SECONDS = 6 * 60 * 60
const SOLANA_GENERIC_TIME_SERIES_CHUNK_SIZE: Partial<Record<TimeSeriesMetric, number>> = {
  transaction_count: 5000,
  unique_addresses: 1000,
}

const EVM_GENERIC_TIME_SERIES_CHUNK_SIZE: Partial<Record<TimeSeriesMetric, number>> = {
  transaction_count: 1500,
  transactions_per_block: 1500,
  unique_addresses: 500,
}

const MIN_EVM_GENERIC_CHUNK_SIZE = 50
const MIN_SOLANA_GENERIC_CHUNK_SIZE = 250
const SOLANA_GENERIC_MAX_BYTES = 150 * 1024 * 1024
const FAST_EVM_TIME_SERIES_BLOCK_CAP = 1500
/* Bitcoin inputs and outputs weigh about a megabyte per block; a fee series
   scans at most this many of the newest requested blocks and says so. */
/*
 * How many blocks one series call may read before it refuses.
 *
 * The cost of this tool is linear in blocks, not in buckets: every block in the
 * window is streamed and folded into its bucket, so a coarser interval reads
 * exactly as much as a fine one. A previous Base benchmark took up to 26.6s
 * for 10,800 blocks and 112s for 43,200. Keep the ceiling just above the scan
 * that finished comfortably within the client's timeout.
 */
export const MAX_SERIES_SCAN_BLOCKS = 12_000

export function assertSeriesWindowScannable(params: {
  dataset: string
  chainType: string
  fromBlock: number
  toBlock: number
  duration: string
}) {
  const blocks = Math.max(0, params.toBlock - params.fromBlock + 1)
  if (blocks <= MAX_SERIES_SCAN_BLOCKS) return
  throw seriesWindowTooLargeError({ ...params, blocks, estimated: false })
}

/*
 * The exact check needs the window's block numbers, and those cost timestamp
 * lookups against the Portal: on Ethereum that was ten seconds spent deciding
 * to refuse. A duration that is far over the bound by the chain's own block
 * time is refused before any lookup. A borderline one waits for the exact
 * count, because a block-time estimate is not a block count.
 */
export function assertSeriesDurationScannable(params: { dataset: string; chainType: string; duration: string }) {
  let seconds: number
  try {
    seconds = parseTimeframeToSeconds(params.duration)
  } catch {
    return
  }
  const secondsPerBlock = estimateBlockTime(params.dataset, params.chainType)
  if (!(secondsPerBlock > 0)) return
  const blocks = Math.ceil(seconds / secondsPerBlock)
  if (blocks <= MAX_SERIES_SCAN_BLOCKS * 1.5) return
  throw seriesWindowTooLargeError({ ...params, blocks, estimated: true })
}

function seriesWindowTooLargeError(params: {
  dataset: string
  chainType: string
  duration: string
  blocks: number
  estimated: boolean
}): ActionableError {
  const { blocks } = params
  const secondsPerBlock = estimateBlockTime(params.dataset, params.chainType)
  const affordableSeconds = MAX_SERIES_SCAN_BLOCKS * secondsPerBlock
  const affordableWindow =
    affordableSeconds >= 3600
      ? `${Math.floor(affordableSeconds / 3600)} hours`
      : `${Math.floor(affordableSeconds / 60)} minutes`
  /* Suggest a real preset rather than a computed number nobody can type. */
  const presets: [string, number][] = [
    ['30d', 2_592_000],
    ['14d', 1_209_600],
    ['7d', 604_800],
    ['3d', 259_200],
    ['24h', 86_400],
    ['12h', 43_200],
    ['6h', 21_600],
    ['1h', 3_600],
    ['30m', 1_800],
    ['15m', 900],
  ]
  const largest = presets.find(([, seconds]) => seconds <= affordableSeconds)

  return new ActionableError(
    `A ${params.duration} window is ${params.estimated ? 'about ' : ''}${blocks.toLocaleString()} blocks on ${params.dataset}${params.estimated ? ' by its typical block time' : ''}, and portal_get_time_series reads every block in the window. It stops at ${MAX_SERIES_SCAN_BLOCKS.toLocaleString()} blocks so a call cannot outlast the client waiting for it.`,
    [
      largest
        ? `Try duration '${largest[0]}' or less on ${params.dataset}. At its typical block rate, the limit covers roughly ${affordableWindow}.`
        : `Ask for a window under ${MAX_SERIES_SCAN_BLOCKS.toLocaleString()} blocks on ${params.dataset}.`,
      'Use from_timestamp and to_timestamp to specify a narrower interval.',
      'The same duration costs less on a slower chain: the limit is blocks, not time.',
      'Use the analytics tool for this chain if you want one aggregate over a wider window instead of a series.',
    ],
    {
      requested_duration: params.duration,
      requested_blocks: blocks,
      ...(params.estimated ? { requested_blocks_estimated: true } : {}),
      max_scan_blocks: MAX_SERIES_SCAN_BLOCKS,
      seconds_per_block: secondsPerBlock,
      ...(largest ? { largest_supported_duration: largest[0] } : {}),
    },
    /* The caller asked for more than the tool serves and can ask for less.
       That is their input, not a server fault, and retrying it unchanged will
       fail exactly the same way. */
    { code: 'unsupported_operation', origin: 'client_input', retryable: false },
  )
}

const BITCOIN_FEE_SERIES_MAX_BLOCKS = 144
const TIME_SERIES_CACHE_TTL_MS = 30_000
const TIME_SERIES_CACHE_MAX_ENTRIES = 16

const timeSeriesCache = createQueryCache<{
  timeSeries: Record<string, unknown>[]
  gapDiagnostics: ReturnType<typeof buildBucketGapDiagnostics>
  summary: Record<string, unknown>
  filledBuckets: number
  expectedBuckets: number
  observedSpanSeconds: number
  observedCoveragePct: number
  hasCoverageGap: boolean
  firstResultTimestamp: number
  endTimestamp: number
  adaptiveChunkReduced: boolean
  effectiveFromBlock: number
  fastNarrowed: boolean
}>({
  ttl: TIME_SERIES_CACHE_TTL_MS,
  maxEntries: TIME_SERIES_CACHE_MAX_ENTRIES,
})

function buildLongWindowNotice(duration: string): string | undefined {
  const durationSeconds = parseTimeframeToSeconds(duration)
  if (durationSeconds <= INTERACTIVE_TIME_SERIES_WINDOW_SECONDS) return undefined

  return `Long-window note: ${describeTimeWindowInput(duration)} reads more blocks than the default ${DEFAULT_TIME_SERIES_DURATION} window, so it takes longer. Windows over ${MAX_SERIES_SCAN_BLOCKS.toLocaleString()} blocks are refused rather than run.`
}

function withWindowNotice(message: string, notice?: string): string {
  return notice ? `${message} ${notice}` : message
}

function getBlockNumber(block: TimeSeriesBlock): number | undefined {
  return block.number ?? block.header?.number
}

function getBlockTimestamp(block: TimeSeriesBlock): number | undefined {
  return block.timestamp ?? block.header?.timestamp
}

function getBlockBigIntString(
  block: TimeSeriesBlock,
  key: 'baseFeePerGas' | 'gasUsed' | 'gasLimit',
): string | undefined {
  return block[key] ?? block.header?.[key]
}

function createBucketAccumulators(
  expectedBuckets: number,
  seriesStartTimestamp: number,
  intervalSeconds: number,
): BucketAccumulator[] {
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

function getNetworkLabel(dataset: string): string {
  switch (dataset) {
    case 'base-mainnet':
      return 'Base'
    case 'ethereum-mainnet':
      return 'Ethereum'
    case 'optimism-mainnet':
      return 'Optimism'
    case 'arbitrum-one':
      return 'Arbitrum'
    case 'polygon-mainnet':
      return 'Polygon'
    case 'solana-mainnet':
      return 'Solana'
    case 'bitcoin-mainnet':
      return 'Bitcoin'
    case 'hyperliquid-fills':
      return 'Hyperliquid'
    default:
      return dataset
        .replace(/-mainnet$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase())
  }
}

function trimFixed(value: number, digits: number): string {
  return value
    .toFixed(digits)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1')
}

function formatCompactNumber(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return `${sign}${trimFixed(abs / 1_000_000_000, abs >= 10_000_000_000 ? 1 : 2)}B`
  if (abs >= 1_000_000) return `${sign}${trimFixed(abs / 1_000_000, abs >= 10_000_000 ? 1 : 2)}M`
  if (abs >= 100_000) return `${sign}${trimFixed(abs / 1_000, 0)}K`
  if (abs >= 10_000) return `${sign}${trimFixed(abs / 1_000, 1)}K`
  if (abs >= 1_000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (abs >= 100) return trimFixed(value, 0)
  if (abs >= 1) return trimFixed(value, 2)
  return trimFixed(value, 4)
}

function formatExactNumber(value: number): string {
  if (Number.isInteger(value) || Math.abs(value) >= 100) {
    return Math.round(value).toLocaleString('en-US')
  }
  return trimFixed(value, Math.abs(value) >= 10 ? 1 : 2)
}

function formatMetricAmount(
  value: number,
  metric: TimeSeriesMetric,
  opts?: { compact?: boolean; unit?: string },
): string {
  if (metric === 'volume') return formatUSD(value)
  if (metric === 'fees_btc') return formatBTC(value)
  if (metric === 'block_utilization' || metric === 'success_rate') return `${trimFixed(value, 1)}%`
  if (metric === 'avg_gas_price') return `${trimFixed(value, value >= 10 ? 1 : 2)} gwei`
  if (metric === 'block_size_bytes') {
    if (Math.abs(value) >= 1_000_000) return `${trimFixed(value / 1_000_000, 2)} MB`
    if (Math.abs(value) >= 1_000) return `${trimFixed(value / 1_000, 1)} KB`
    return `${formatExactNumber(value)} bytes`
  }

  const formatted = opts?.compact ? formatCompactNumber(value) : formatExactNumber(value)
  return opts?.unit && !['transactions', 'txs', 'fills'].includes(opts.unit) ? `${formatted} ${opts.unit}` : formatted
}

function getMetricNoun(metric: TimeSeriesMetric): string {
  switch (metric) {
    case 'transaction_count':
      return 'txs'
    case 'fill_count':
      return 'fills'
    case 'unique_addresses':
      return 'unique addresses'
    case 'unique_traders':
      return 'unique traders'
    default:
      return getMetricLabel(metric).toLowerCase()
  }
}

function isAdditiveMetric(metric: TimeSeriesMetric): boolean {
  return ['transaction_count', 'gas_used', 'fees_btc', 'block_size_bytes', 'volume', 'fill_count'].includes(metric)
}

function formatBucketTime(timestamp: unknown): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
  const date = new Date(timestamp * 1000)
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm} UTC`
}

function buildTimeSeriesAnswer(params: {
  dataset: string
  metric: TimeSeriesMetric
  interval: string
  duration: string
  timeSeries: Record<string, unknown>[]
  fromBlock?: number
  toBlock?: number
  observedSpanSeconds?: number
  unit?: string
  /* mode=fast read a slice of the window on purpose; the missing hours were
     not unindexed, they were not asked for. */
  windowNarrowedByFastMode?: boolean
}): string {
  const values = params.timeSeries
    .map((row) => {
      const value =
        typeof row.value === 'number' ? row.value : typeof row.value === 'string' ? Number(row.value) : Number.NaN
      return Number.isFinite(value) ? value : undefined
    })
    .filter((value): value is number => value !== undefined)
  const bucketCount = Math.max(params.timeSeries.length, values.length, 1)
  const total = values.reduce((sum, value) => sum + value, 0)
  const avg = total / Math.max(values.length, 1)
  const peak = params.timeSeries.reduce<{ value: number; row?: Record<string, unknown> }>(
    (best, row) => {
      const value = typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : Number.NEGATIVE_INFINITY
      return value > best.value ? { value, row } : best
    },
    { value: Number.NEGATIVE_INFINITY },
  )
  const network = getNetworkLabel(params.dataset)
  const metricNoun = getMetricNoun(params.metric)
  const blocks =
    params.fromBlock !== undefined && params.toBlock !== undefined
      ? ` Blocks ${params.fromBlock.toLocaleString('en-US')} -> ${params.toBlock.toLocaleString('en-US')}.`
      : ''
  const coverage =
    params.observedSpanSeconds !== undefined && parseTimeframeToSeconds(params.duration) > 0
      ? params.observedSpanSeconds / parseTimeframeToSeconds(params.duration)
      : 1
  const durationLabel = describeTimeWindowInput(params.duration)
  const spanLabel = params.windowNarrowedByFastMode
    ? `the newest ${formatDuration(params.observedSpanSeconds ?? 0)}`
    : durationLabel
  const coveragePrefix = params.windowNarrowedByFastMode
    ? `mode=fast read only ${spanLabel} of the requested ${durationLabel} window; mode=deep reads all of it. `
    : coverage < 0.9
      ? `Only ${formatDuration(params.observedSpanSeconds ?? 0)} of the requested window (${durationLabel}) had indexed block data. `
      : ''

  const firstSentence = isAdditiveMetric(params.metric)
    ? `${coveragePrefix}~${formatMetricAmount(total, params.metric, { compact: true, unit: params.unit })} ${metricNoun} on ${network} over ${spanLabel} (${bucketCount} x ${params.interval} buckets, avg ${formatMetricAmount(avg, params.metric, { unit: params.unit })}/bucket).`
    : `${coveragePrefix}${network} ${metricNoun} averaged ${formatMetricAmount(avg, params.metric, { unit: params.unit })} over ${spanLabel} (${bucketCount} x ${params.interval} buckets).`

  if (!Number.isFinite(peak.value) || peak.value <= 0 || avg <= 0) {
    return `${firstSentence}${blocks}`.trim()
  }

  const peakTime = formatBucketTime(peak.row?.timestamp)
  const multiplier = peak.value / avg
  const spikeSentence =
    multiplier >= 1.5
      ? ` Notable spike${peakTime ? ` at ${peakTime}` : ''} with ${formatMetricAmount(peak.value, params.metric, { unit: params.unit })} ${metricNoun} in a single ${params.interval} window - roughly ${trimFixed(multiplier, 1)}x the average.`
      : ` Peak bucket${peakTime ? ` at ${peakTime}` : ''}: ${formatMetricAmount(peak.value, params.metric, { unit: params.unit })} ${metricNoun}.`

  return `${firstSentence}${spikeSentence}${blocks}`.trim()
}

function getMetricRecommendedVisual(metric: TimeSeriesMetric): 'line' | 'bar' | 'stacked_area' {
  return metric === 'transaction_count' ? 'bar' : 'line'
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
      ? [
          buildMetricCard({
            id: 'primary-value',
            label: params.primaryLabel ?? params.metricLabel,
            value_path: params.primaryValuePath,
            format: params.valueFormat,
            ...(params.unit ? { unit: params.unit } : {}),
            emphasis: 'primary',
          }),
        ]
      : []),
    ...(params.avgValuePath
      ? [
          buildMetricCard({
            id: 'average-value',
            label: `Average ${params.metricLabel.toLowerCase()}`,
            value_path: params.avgValuePath,
            format: params.valueFormat,
            ...(params.unit ? { unit: params.unit } : {}),
          }),
        ]
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
        chart_key: 'chart',
        emphasis: 'primary',
      }),
    ],
    follow_up_actions: params.followUpActions?.length ? params.followUpActions : undefined,
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
      { label: 'Query a shorter comparison window', intent: 'zoom_in', target: 'chart' },
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
      subtitle:
        'Track the busiest contracts, compare their bucketed activity, and drill into the ranked contract table.',
    },
    metric_cards: [
      buildMetricCard({
        id: 'tracked-contracts',
        label: 'Tracked contracts',
        value_path: 'summary.tracked_contracts',
        format: 'integer',
        emphasis: 'primary',
      }),
      buildMetricCard({
        id: 'total-transactions',
        label: 'Transactions',
        value_path: 'summary.total_transactions',
        format: 'integer',
      }),
      buildMetricCard({
        id: 'group-limit',
        label: 'Group limit',
        value_path: 'summary.group_limit',
        format: 'integer',
        subtitle: 'The grouped chart tracks only the top-ranked contracts.',
      }),
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
      { label: 'Query a shorter recent window', intent: 'zoom_in', target: 'chart' },
    ],
  })
}

export function registerGetTimeSeriesDataTool(server: McpServer) {
  registerPortalTool(
    server,
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
        .describe(`Metric to aggregate over time. Per chain family: ${METRIC_FAMILY_TEXT}. Others are refused.`),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval (5m, 15m, 1h, 6h, 1d)'),
      duration: z
        .string()
        .optional()
        .describe(
          'Total time period to analyze. Defaults to "15m" on Base mainnet and "6h" elsewhere. This tool reads every block and refuses windows over 12,000 blocks. Accepts compact durations like "30m" or natural phrases like "past 30 minutes".',
        ),
      address: z
        .string()
        .optional()
        .describe('Optional: Filter to specific contract address for contract-specific trends'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "24h ago".',
        ),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".',
        ),
      compare_previous: z
        .boolean()
        .optional()
        .default(false)
        .describe('Compare the selected window against the immediately previous window'),
      group_by: z
        .enum(['none', 'contract'])
        .optional()
        .default('none')
        .describe('Optional grouping mode. contract is currently supported only for EVM transaction_count'),
      group_limit: z
        .number()
        .optional()
        .default(5)
        .describe('Maximum number of contract groups when group_by=contract'),
      mode: z
        .enum(['fast', 'deep'])
        .optional()
        .default('deep')
        .describe(
          'Execution depth. Defaults to complete requested-window analysis; the optional fast value is only for explicitly bounded previews.',
        ),
    },
    async ({
      network,
      metric,
      interval,
      duration: requestedDuration,
      address,
      from_timestamp,
      to_timestamp,
      compare_previous,
      group_by,
      group_limit,
      mode,
    }) => {
      const queryStartTime = Date.now()
      let dataset = await resolveDataset(network)
      const chainType = detectChainType(dataset)
      const hasTimestamps = from_timestamp !== undefined || to_timestamp !== undefined
      const duration =
        requestedDuration ??
        (dataset === 'base-mainnet' && !hasTimestamps
          ? DEFAULT_BASE_TIME_SERIES_DURATION
          : DEFAULT_TIME_SERIES_DURATION)
      const isHyperliquid = chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds'
      const notices: string[] = []
      const pipesRecipe = buildTimeSeriesPipesRecipe({
        network: dataset,
        metric,
        interval,
        duration,
        address,
        compare_previous,
        group_by,
      })
      const longWindowNotice = hasTimestamps ? undefined : buildLongWindowNotice(duration)
      if (longWindowNotice) {
        notices.push(longWindowNotice)
      }

      if (chainType === 'tron') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_time_series',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin', 'hyperliquidFills'],
          suggestions: [
            'Use portal_get_network_info for Tron availability and freshness.',
            'Use portal_debug_resolve_time_to_block for Tron timestamp-to-block lookups.',
            'Use portal_tron_query_transactions or portal_tron_query_logs with response_format=summary for bounded Tron counts, or the Stream API examples in the bundled SQD Portal skill for custom time series.',
          ],
        })
      }

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

      /* The reverse direction, which was missing. The shared bucket reducer is
         an if-chain over six metrics starting from `let value = 0`, so a metric
         belonging to another chain family fell through it and shipped the
         initial accumulator as the answer: `tps`, `success_rate`, `avg_fee` and
         `block_size_bytes` all returned an all-zero series on EVM, stamped
         result_complete: true with empty_buckets: 0 and an evidence receipt
         hashing the zeros. On Solana the same gap coerced an unrecognised
         metric to transaction_count and answered a question nobody asked.
         Neither is recoverable by the caller, because nothing in the response
         says the number is not the metric they requested. */
      const supported = SUPPORTED_METRICS[isHyperliquid ? 'hyperliquid' : (chainType as SupportedFamily)]
      if (supported && !supported.includes(metric)) {
        throw createUnsupportedMetricError({
          toolName: 'portal_get_time_series',
          metric,
          dataset,
          supportedMetrics: [...supported],
          reason: `This metric is not computed for ${isHyperliquid ? 'Hyperliquid' : chainType} datasets.`,
          suggestions: [
            `Ask for one of: ${supported.join(', ')}.`,
            'Use portal_get_network_info to see what this network exposes.',
          ],
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
        if (
          !['transaction_count', 'avg_gas_price', 'gas_used', 'block_utilization', 'unique_addresses'].includes(metric)
        ) {
          throw createUnsupportedMetricError({
            toolName: 'portal_get_time_series',
            metric,
            dataset,
            supportedMetrics: [
              'transaction_count',
              'avg_gas_price',
              'gas_used',
              'block_utilization',
              'unique_addresses',
            ],
            reason: 'compare_previous currently supports the core scalar metrics only.',
          })
        }

        const durationSeconds = parseTimeframeToSeconds(duration)
        const head = await getBlockHead(dataset)
        const anchorTimestamp =
          to_timestamp !== undefined
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
            metric: metric as
              | 'transaction_count'
              | 'avg_gas_price'
              | 'gas_used'
              | 'block_utilization'
              | 'unique_addresses',
            interval,
            duration,
            address,
            fromTimestamp: currentStartTimestamp,
            toTimestampInclusive: currentEndInclusive,
          }),
          computeWindowSeries({
            dataset,
            metric: metric as
              | 'transaction_count'
              | 'avg_gas_price'
              | 'gas_used'
              | 'block_utilization'
              | 'unique_addresses',
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
            pct_change:
              previousPoint.value === 0
                ? null
                : Number((((point.value - previousPoint.value) / previousPoint.value) * 100).toFixed(2)),
          }
        })
        const maxDeltaBuckets = mode === 'deep' ? Number.POSITIVE_INFINITY : 160
        const trimmedBucketDeltas =
          bucketDeltas.length > maxDeltaBuckets ? bucketDeltas.slice(-maxDeltaBuckets) : bucketDeltas
        if (bucketDeltas.length > trimmedBucketDeltas.length) {
          notices.push(
            `Bucket deltas trimmed to the most recent ${maxDeltaBuckets} buckets because the caller requested a bounded preview.`,
          )
        }
        const maxSeriesBuckets = mode === 'deep' ? Number.POSITIVE_INFINITY : 160
        const currentSeriesRows =
          currentSeries.timeSeries.length > maxSeriesBuckets
            ? currentSeries.timeSeries.slice(-maxSeriesBuckets)
            : currentSeries.timeSeries
        const previousSeriesRows =
          previousSeries.timeSeries.length > maxSeriesBuckets
            ? previousSeries.timeSeries.slice(-maxSeriesBuckets)
            : previousSeries.timeSeries
        if (currentSeriesRows.length < currentSeries.timeSeries.length) {
          notices.push(
            `Current and previous series trimmed to the most recent ${maxSeriesBuckets} buckets because the caller requested a bounded preview.`,
          )
        }
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
          pct_change:
            row.previous_value === 0
              ? null
              : Number((((row.current_value - row.previous_value) / row.previous_value) * 100).toFixed(2)),
        }))

        const compareCoverage = buildBucketCoverage({
          expectedBuckets: currentSeries.coverage.expected_buckets,
          returnedBuckets: currentSeries.coverage.returned_buckets,
          filledBuckets: currentSeries.coverage.filled_buckets,
          anchor: 'timestamp_window',
          windowComplete:
            currentSeries.coverage.window_complete === true && previousSeries.coverage.window_complete === true,
        })

        const resultMessage = withWindowNotice(
          `Compared ${metric} over the current window (${describeTimeWindowInput(duration)}) versus the immediately previous matching window.`,
          longWindowNotice,
        )

        return formatResult(
          {
            summary: {
              metric,
              interval,
              duration,
              compare_previous: true,
              window_anchor: 'latest_block',
              bucket_alignment: 'anchored_to_latest_block',
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
                  {
                    key: 'current_value',
                    label: 'Current',
                    kind: 'metric',
                    format: getMetricValueFormat(metric),
                    align: 'right',
                    ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}),
                  },
                  {
                    key: 'previous_value',
                    label: 'Previous',
                    kind: 'metric',
                    format: getMetricValueFormat(metric),
                    align: 'right',
                    ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}),
                  },
                  {
                    key: 'delta',
                    label: 'Delta',
                    kind: 'metric',
                    format: getMetricValueFormat(metric),
                    align: 'right',
                    ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}),
                  },
                  {
                    key: 'pct_change',
                    label: 'Pct change',
                    kind: 'metric',
                    format: 'percent',
                    unit: '%',
                    align: 'right',
                  },
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
              ...(trimmedBucketDeltas.length
                ? [
                    buildTableDescriptor({
                      id: 'bucket_deltas',
                      dataKey: 'bucket_deltas',
                      rowCount: trimmedBucketDeltas.length,
                      title: 'Bucket deltas',
                      defaultSort: { key: 'bucket_index', direction: 'asc' },
                      dense: true,
                      columns: [
                        { key: 'bucket_index', label: 'Bucket', kind: 'dimension', format: 'integer', align: 'right' },
                        {
                          key: 'current_value',
                          label: 'Current',
                          kind: 'metric',
                          format: getMetricValueFormat(metric),
                          align: 'right',
                          ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}),
                        },
                        {
                          key: 'previous_value',
                          label: 'Previous',
                          kind: 'metric',
                          format: getMetricValueFormat(metric),
                          align: 'right',
                          ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}),
                        },
                        {
                          key: 'delta',
                          label: 'Delta',
                          kind: 'metric',
                          format: getMetricValueFormat(metric),
                          align: 'right',
                          ...(getMetricUnit(metric) ? { unit: getMetricUnit(metric) } : {}),
                        },
                        {
                          key: 'pct_change',
                          label: 'Pct change',
                          kind: 'metric',
                          format: 'percent',
                          unit: '%',
                          align: 'right',
                        },
                      ],
                    }),
                  ]
                : []),
            ],
            summary_rows: summaryRows,
            comparison_series: comparisonSeries,
            current_series: currentSeriesRows,
            previous_series: previousSeriesRows,
            bucket_deltas: trimmedBucketDeltas,
            gap_diagnostics: currentSeries.gapDiagnostics,
          },
          resultMessage,
          {
            toolName: 'portal_get_time_series',
            notices: [...notices, ...currentSeries.notices, ...previousSeries.notices],
            freshness: currentSeries.freshness,
            coverage: compareCoverage,
            execution: buildExecutionMetadata({
              mode,
              metric,
              interval,
              duration,
              compare_previous: true,
              range_kind: 'timeframe',
              ...(longWindowNotice ? { notes: [longWindowNotice] } : {}),
            }),
            pipes: pipesRecipe,
            ui: buildComparePreviousUi(metric),
            metadata: {
              network: dataset,
              dataset,
              from_block: currentSeries.metadata.from_block,
              to_block: currentSeries.metadata.to_block,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      if (group_by === 'contract') {
        if (from_timestamp === undefined && to_timestamp === undefined) {
          assertSeriesDurationScannable({ dataset, chainType, duration })
        }
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
        assertSeriesWindowScannable({ dataset, chainType, fromBlock, toBlock, duration })
        const intervalSeconds = parseTimeframeToSeconds(interval)
        const durationSeconds = parseTimeframeToSeconds(duration)
        const expectedBuckets = Math.ceil(durationSeconds / intervalSeconds)
        const contractTotals = new Map<string, number>()
        let firstObservedTimestamp: number | undefined
        let lastObservedTimestamp: number | undefined
        let totalTransactions = 0
        let groupedChunkSizeReduced = false

        const visitGroupedContractRange = async (onRecord: (record: unknown) => void | Promise<void>) => {
          let currentFrom = fromBlock
          let chunkSize = EVM_GENERIC_TIME_SERIES_CHUNK_SIZE.transaction_count ?? 1500

          while (currentFrom <= toBlock) {
            const plannedTo = Math.min(currentFrom + chunkSize - 1, toBlock)

            try {
              await portalFetchStreamRangeVisit(
                `${PORTAL_URL}/datasets/${dataset}/stream`,
                {
                  type: 'evm',
                  fromBlock: currentFrom,
                  toBlock: plannedTo,
                  fields: {
                    block: { number: true, timestamp: true },
                    transaction: { to: true },
                  },
                  transactions: [{}],
                },
                {
                  maxBytes: 100 * 1024 * 1024,
                  onRecord,
                },
              )
              currentFrom = plannedTo + 1
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const shouldReduceChunkSize =
                (message.includes('Response too large') ||
                  message.toLowerCase().includes('timed out') ||
                  message.toLowerCase().includes('timeout')) &&
                chunkSize > MIN_EVM_GENERIC_CHUNK_SIZE

              if (shouldReduceChunkSize) {
                chunkSize = Math.max(MIN_EVM_GENERIC_CHUNK_SIZE, Math.floor(chunkSize / 2))
                groupedChunkSizeReduced = true
                continue
              }

              throw err
            }
          }
        }

        await visitGroupedContractRange((record) => {
          const block = record as {
            header?: { timestamp?: number }
            timestamp?: number
            transactions?: Array<{ to?: string }>
          }
          const timestamp = block.header?.timestamp ?? block.timestamp
          if (typeof timestamp !== 'number' || timestamp <= 0) return
          if (firstObservedTimestamp === undefined || timestamp < firstObservedTimestamp)
            firstObservedTimestamp = timestamp
          if (lastObservedTimestamp === undefined || timestamp > lastObservedTimestamp)
            lastObservedTimestamp = timestamp
        })

        if (lastObservedTimestamp === undefined) {
          throw new Error('No transactions available for this time period')
        }

        const seriesStartTimestamp = lastObservedTimestamp - durationSeconds
        const buckets = Array.from({ length: expectedBuckets }, (_, bucketIndex) => ({
          timestamp: seriesStartTimestamp + bucketIndex * intervalSeconds,
          total_transactions: 0,
          contract_counts: new Map<string, number>(),
        }))

        await visitGroupedContractRange((record) => {
          const block = record as {
            header?: { timestamp?: number }
            timestamp?: number
            transactions?: Array<{ to?: string }>
          }
          const timestamp = block.header?.timestamp ?? block.timestamp
          if (typeof timestamp !== 'number' || timestamp <= 0) return
          const bucketIndex = Math.min(
            Math.floor((timestamp - seriesStartTimestamp) / intervalSeconds),
            expectedBuckets - 1,
          )
          if (bucketIndex < 0) return
          for (const tx of block.transactions || []) {
            if (!tx.to) continue
            const contract = tx.to.toLowerCase()
            buckets[bucketIndex].total_transactions += 1
            totalTransactions += 1
            buckets[bucketIndex].contract_counts.set(
              contract,
              (buckets[bucketIndex].contract_counts.get(contract) || 0) + 1,
            )
            contractTotals.set(contract, (contractTotals.get(contract) || 0) + 1)
          }
        })

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
          windowComplete: firstObservedTimestamp !== undefined ? firstObservedTimestamp <= seriesStartTimestamp : true,
        })
        const resultMessage = withWindowNotice(
          `Tracked ${topContracts.length} top contracts over ${describeTimeWindowInput(duration)} in ${interval} buckets.`,
          longWindowNotice,
        )

        return formatResult(
          {
            summary: {
              metric,
              interval,
              duration,
              group_by,
              group_limit,
              window_anchor: 'latest_block',
              bucket_alignment: 'anchored_to_latest_block',
              tracked_contracts: topContracts.length,
              total_transactions: totalTransactions,
              from_block: fromBlock,
              to_block: toBlock,
              ...(groupedChunkSizeReduced ? { chunk_size_reduced: true } : {}),
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
                  {
                    key: 'transaction_count',
                    label: 'Transactions',
                    kind: 'metric',
                    format: 'integer',
                    align: 'right',
                  },
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
                extraColumns: [{ key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' }],
                keyField: 'contract_address',
                defaultSort: { key: 'timestamp', direction: 'asc' },
              }),
            ],
            top_contracts: topContracts,
            gap_diagnostics: gapDiagnostics,
            time_series: timeSeries,
          },
          resultMessage,
          {
            toolName: 'portal_get_time_series',
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
              ...(longWindowNotice ? { notes: [longWindowNotice] } : {}),
            }),
            pipes: pipesRecipe,
            ui: buildGroupedContractUi(),
            metadata: {
              network: dataset,
              dataset,
              from_block: fromBlock,
              to_block: toBlock,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      if (
        chainType === 'solana' &&
        ['transaction_count', 'unique_addresses', 'tps', 'avg_fee', 'success_rate', 'slots_per_hour'].includes(metric)
      ) {
        const head = await getBlockHead(dataset)
        const durationSeconds = parseTimeframeToSeconds(duration)
        const loadSolanaSeries = () =>
          computeSolanaTimeSeries({
            dataset,
            metric:
              metric === 'unique_addresses'
                ? 'unique_wallets'
                : metric === 'tps' || metric === 'avg_fee' || metric === 'success_rate' || metric === 'slots_per_hour'
                  ? metric
                  : 'transaction_count',
            interval,
            duration,
            trimIncompleteLastBucket: false,
            ...(from_timestamp !== undefined || to_timestamp !== undefined
              ? {
                  from_timestamp,
                  to_timestamp,
                }
              : {}),
          })
        const getSolanaCoverage = (result: Awaited<ReturnType<typeof loadSolanaSeries>>) => {
          const filledBuckets = result.time_series.filter((point) => point.slots_in_bucket > 0).length
          const observedCoveragePct = durationSeconds > 0 ? result.observed_span_seconds / durationSeconds : 1
          return {
            filledBuckets,
            observedCoveragePct,
            hasCoverageGap: observedCoveragePct < 0.98 || filledBuckets < result.expected_buckets * 0.8,
          }
        }

        let solanaResult = await loadSolanaSeries()
        let solanaCoverage = getSolanaCoverage(solanaResult)

        // Moving Solana heads can briefly expose sparse stream coverage under bursty MCP traffic.
        // Retry one bounded interactive scan before surfacing an actionable coverage error.
        if (solanaCoverage.hasCoverageGap && durationSeconds <= INTERACTIVE_TIME_SERIES_WINDOW_SECONDS) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          solanaResult = await loadSolanaSeries()
          solanaCoverage = getSolanaCoverage(solanaResult)
        }

        const { filledBuckets, observedCoveragePct, hasCoverageGap } = solanaCoverage
        if (hasCoverageGap) {
          throw new ActionableError(
            'Solana bucket coverage was incomplete, so no time-series chart was returned.',
            [
              'Use a shorter duration, such as "past 1h" or "past 6h".',
              'Use a larger interval, such as "1h", to reduce bucket pressure.',
              'Retry in a moment if the indexed range is moving or Portal returned sparse slot coverage.',
            ],
            {
              requested_window: describeTimeWindowInput(duration),
              observed_coverage_pct: Math.round(observedCoveragePct * 100),
              expected_buckets: solanaResult.expected_buckets,
              filled_buckets: filledBuckets,
              from_block: solanaResult.from_block,
              to_block: solanaResult.to_block,
            },
          )
        }
        const solanaNotices = [...notices]
        const summary: any = {
          window_anchor: 'latest_block',
          bucket_alignment: 'anchored_to_latest_block',
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
            !hasCoverageGap &&
            (solanaResult.first_observed_timestamp !== undefined
              ? solanaResult.first_observed_timestamp <= normalizedTimeSeries[0]?.timestamp
              : true),
          ...(solanaResult.first_observed_timestamp !== undefined
            ? { firstObservedTimestamp: solanaResult.first_observed_timestamp }
            : {}),
          ...(solanaResult.last_observed_timestamp !== undefined
            ? { lastObservedTimestamp: solanaResult.last_observed_timestamp }
            : {}),
        })
        const resultMessage = withWindowNotice(
          buildTimeSeriesAnswer({
            dataset,
            metric,
            interval,
            duration,
            timeSeries: normalizedTimeSeries,
            fromBlock: solanaResult.from_block,
            toBlock: solanaResult.to_block,
            observedSpanSeconds: solanaResult.observed_span_seconds,
            unit: solanaResult.unit,
          }),
          longWindowNotice,
        )

        return formatResult(
          {
            summary,
            chart: buildTimeSeriesChart({
              interval,
              totalPoints: solanaResult.time_series.length,
              recommendedVisual: getMetricRecommendedVisual(metric),
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
          resultMessage,
          {
            toolName: 'portal_get_time_series',
            ...(solanaNotices.length > 0 ? { notices: solanaNotices } : {}),
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
                !hasCoverageGap &&
                (solanaResult.first_observed_timestamp !== undefined
                  ? solanaResult.first_observed_timestamp <= normalizedTimeSeries[0]?.timestamp
                  : true),
            }),
            execution: buildExecutionMetadata({
              mode,
              metric,
              interval,
              duration,
              from_block: solanaResult.from_block,
              to_block: solanaResult.to_block,
              range_kind: 'timeframe',
              ...(longWindowNotice ? { notes: [longWindowNotice] } : {}),
            }),
            pipes: pipesRecipe,
            ui: buildSimpleSeriesUi({
              title: `Solana ${getMetricLabel(metric)}`,
              subtitle: resultMessage,
              metricLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: solanaResult.unit,
              avgValuePath: 'summary.statistics.avg',
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
        const intervalSeconds = parseTimeframeToSeconds(interval)
        const exactTimestampWindowRequested = from_timestamp !== undefined || to_timestamp !== undefined
        if (exactTimestampWindowRequested && (from_timestamp === undefined || to_timestamp === undefined)) {
          throw new ActionableError(
            'Provide both from_timestamp and to_timestamp for an exact Hyperliquid time-series window.',
            [
              'Set from_timestamp to the inclusive window start.',
              'Set to_timestamp to the inclusive window end.',
              'Or omit both and use duration for a recent indexed-head window.',
            ],
          )
        }
        const resolvedWindow = await resolveTimeframeOrBlocks({
          dataset,
          ...(exactTimestampWindowRequested
            ? { from_timestamp: from_timestamp as TimestampInput, to_timestamp: to_timestamp as TimestampInput }
            : { timeframe: duration }),
        })
        const fromBlock = resolvedWindow.from_block
        const { validatedToBlock: toBlock, head } = await validateBlockRange(
          dataset,
          fromBlock,
          resolvedWindow.to_block ?? Number.MAX_SAFE_INTEGER,
          false,
        )
        const indexedHeadTimestamp =
          resolvedWindow.from_lookup?.head_timestamp ??
          resolvedWindow.to_lookup?.head_timestamp ??
          (await getHeadTimestamp(dataset, head.number, 2))
        const requestedWindowStartTimestamp = exactTimestampWindowRequested
          ? resolvedWindow.from_lookup!.timestamp
          : (resolvedWindow.from_lookup?.timestamp ??
            Math.max(0, indexedHeadTimestamp + 1 - parseTimeframeToSeconds(duration)))
        const requestedWindowEndExclusive = exactTimestampWindowRequested
          ? resolvedWindow.to_lookup!.timestamp + 1
          : indexedHeadTimestamp + 1
        const indexedEvidenceEndExclusive = Math.min(requestedWindowEndExclusive, indexedHeadTimestamp + 1)
        const seriesStartTimestamp = Math.floor(requestedWindowStartTimestamp / intervalSeconds) * intervalSeconds
        const seriesEndExclusive = Math.ceil(requestedWindowEndExclusive / intervalSeconds) * intervalSeconds
        const expectedBuckets = Math.max(1, Math.ceil((seriesEndExclusive - seriesStartTimestamp) / intervalSeconds))
        const sourceWindowComplete = resolvedWindow.from_lookup?.resolution === 'verified_boundary'
        const buckets = new Map<number, { fills: number; volume: ExactDecimal; traders: Set<string> }>()
        const fillFields: Record<string, boolean> = { time: true }
        if (metric === 'volume') {
          fillFields.px = true
          fillFields.sz = true
        }
        if (metric === 'unique_traders') {
          fillFields.user = true
        }

        const getBucket = (bucketTimestamp: number) => {
          let bucket = buckets.get(bucketTimestamp)
          if (!bucket) {
            bucket = { fills: 0, volume: EXACT_DECIMAL_ZERO, traders: new Set<string>() }
            buckets.set(bucketTimestamp, bucket)
          }
          return bucket
        }

        await visitHyperliquidFillBlocks({
          dataset,
          fromBlock,
          toBlock,
          fillFilter: {},
          fillFields,
          initialChunkSize: 100_000,
          minChunkSize: 10_000,
          maxBytes: 200 * 1024 * 1024,
          concurrency: 6,
          onBlock: (block) => {
            for (const fill of block.fills || []) {
              const ts =
                Number(fill.time || 0) > 1e12
                  ? Math.floor(Number(fill.time) / 1000)
                  : Math.floor(Number(fill.time || 0))
              if (!ts || ts < requestedWindowStartTimestamp || ts >= requestedWindowEndExclusive) continue
              const bucketTimestamp = Math.floor(ts / intervalSeconds) * intervalSeconds
              const bucket = getBucket(bucketTimestamp)
              bucket.fills += 1
              if (metric === 'volume') {
                const price = parseExactDecimal(fill.px)
                const size = parseExactDecimal(fill.sz)
                if (price && size && price.coefficient > 0n && size.coefficient > 0n) {
                  bucket.volume = addExactDecimals(bucket.volume, multiplyExactDecimals(price, size))
                }
              }
              if (metric === 'unique_traders' && typeof fill.user === 'string') {
                bucket.traders.add(fill.user.toLowerCase())
              }
            }
          },
        })

        const timeSeries = Array.from({ length: expectedBuckets }, (_, bucketIndex) => {
          const bucketTimestamp = seriesStartTimestamp + bucketIndex * intervalSeconds
          const bucket = buckets.get(bucketTimestamp)
          const bucketEnd = bucketTimestamp + intervalSeconds
          const bucketComplete =
            bucketTimestamp >= requestedWindowStartTimestamp &&
            bucketEnd <= requestedWindowEndExclusive &&
            bucketEnd <= indexedEvidenceEndExclusive
          const value =
            metric === 'volume'
              ? formatExactDecimal(bucket?.volume ?? EXACT_DECIMAL_ZERO)
              : metric === 'unique_traders'
                ? (bucket?.traders.size ?? 0)
                : (bucket?.fills ?? 0)
          return {
            bucket_index: bucketIndex,
            timestamp: bucketTimestamp,
            timestamp_human: formatTimestamp(bucketTimestamp),
            bucket_start_inclusive: Math.max(bucketTimestamp, requestedWindowStartTimestamp),
            bucket_end_exclusive: Math.max(
              Math.max(bucketTimestamp, requestedWindowStartTimestamp),
              Math.min(bucketEnd, requestedWindowEndExclusive, indexedEvidenceEndExclusive),
            ),
            bucket_complete: bucketComplete,
            bucket_state: bucketComplete ? 'closed' : 'open_or_partial',
            has_fills: Boolean(bucket && bucket.fills > 0),
            value,
          }
        })
        const filledBuckets = timeSeries.filter((bucket) => bucket.has_fills).length
        const finalBucketComplete = timeSeries.at(-1)?.bucket_complete ?? false
        const allBucketsComplete = timeSeries.every((bucket) => bucket.bucket_complete)
        const resultComplete = sourceWindowComplete && allBucketsComplete
        const metricDefinition = {
          metric,
          unit: getMetricUnit(metric) ?? (metric === 'unique_traders' ? 'traders' : 'count'),
          aggregation:
            metric === 'volume'
              ? 'sum_price_times_size_per_bucket'
              : metric === 'unique_traders'
                ? 'distinct_trader_addresses_per_bucket'
                : 'fill_rows_per_bucket',
          presence_field: 'has_fills',
          presence_semantics: 'true when at least one valid fill row falls inside the bucket and requested time window',
        }
        const resultMessage = withWindowNotice(
          buildTimeSeriesAnswer({
            dataset,
            metric,
            interval,
            duration,
            timeSeries,
            fromBlock,
            toBlock,
            unit: getMetricUnit(metric),
          }),
          longWindowNotice,
        )
        return formatResult(
          {
            summary: {
              metric,
              metric_definition: metricDefinition,
              interval,
              duration,
              bucket_alignment: 'interval_boundary',
              total_buckets: timeSeries.length,
              filled_buckets: filledBuckets,
              empty_buckets: timeSeries.length - filledBuckets,
              from_block: fromBlock,
              to_block: toBlock,
              requested_window_start_timestamp: requestedWindowStartTimestamp,
              requested_window_start_timestamp_human: formatTimestamp(requestedWindowStartTimestamp),
              requested_window_end_exclusive: requestedWindowEndExclusive,
              requested_window_end_exclusive_human: formatTimestamp(requestedWindowEndExclusive - 1),
              indexed_evidence_end_exclusive: indexedEvidenceEndExclusive,
              indexed_evidence_end_exclusive_human: formatTimestamp(indexedEvidenceEndExclusive - 1),
              final_bucket_complete: finalBucketComplete,
              all_buckets_complete: allBucketsComplete,
              result_complete: resultComplete,
            },
            metric_definition: metricDefinition,
            chart: buildTimeSeriesChart({
              interval,
              totalPoints: timeSeries.length,
              recommendedVisual: getMetricRecommendedVisual(metric),
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
                defaultSort: { key: 'bucket_index', direction: 'asc' },
              }),
            ],
            gap_diagnostics: buildBucketGapDiagnostics({
              buckets: timeSeries,
              intervalSeconds,
              isFilled: (bucket) => bucket.has_fills,
              anchor: exactTimestampWindowRequested ? 'requested_timestamp_window' : 'indexed_head',
              windowComplete: sourceWindowComplete,
            }),
            time_series: timeSeries,
          },
          resultMessage,
          {
            toolName: 'portal_get_time_series',
            ...(notices.length + getTimestampWindowNotices(resolvedWindow).length > 0
              ? { notices: [...notices, ...getTimestampWindowNotices(resolvedWindow)] }
              : {}),
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
              anchor: exactTimestampWindowRequested ? 'requested_timestamp_window' : 'indexed_head',
              windowComplete: sourceWindowComplete,
              resultComplete,
              requestedFromTimestamp: requestedWindowStartTimestamp,
              requestedToTimestamp: requestedWindowEndExclusive - 1,
              analyzedFromTimestamp: requestedWindowStartTimestamp,
              analyzedToTimestamp: indexedEvidenceEndExclusive - 1,
              indexedEvidenceEndTimestamp: indexedEvidenceEndExclusive - 1,
              finalBucketComplete,
            }),
            execution: buildExecutionMetadata({
              mode,
              metric,
              interval,
              duration,
              from_block: fromBlock,
              to_block: toBlock,
              range_kind: resolvedWindow.range_kind,
              ...(longWindowNotice ? { notes: [longWindowNotice] } : {}),
            }),
            pipes: pipesRecipe,
            ui: buildSimpleSeriesUi({
              title: `Hyperliquid ${getMetricLabel(metric)}`,
              subtitle: resultMessage,
              metricLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: getMetricUnit(metric),
              primaryValuePath: 'summary.total_buckets',
              primaryLabel: 'Buckets',
            }),
            metadata: {
              network: dataset,
              dataset,
              from_block: fromBlock,
              to_block: toBlock,
              query_start_time: queryStartTime,
            },
          },
        )
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
        if (metric === 'fees_btc') {
          const requestedBlocks = toBlock - fromBlock + 1
          const scanFrom =
            requestedBlocks > BITCOIN_FEE_SERIES_MAX_BLOCKS ? toBlock - BITCOIN_FEE_SERIES_MAX_BLOCKS + 1 : fromBlock
          const fees = await fetchBitcoinBlockFees({ dataset, fromBlock: scanFrom, toBlock })
          if (fees.blocks.length === 0) throw new Error('No data available for this time period')
          const firstTimestamp = fees.blocks[0].timestamp
          const lastTimestamp = fees.blocks[fees.blocks.length - 1].timestamp
          // The series used to span `duration` even when the window came from
          // from_timestamp/to_timestamp, so every scanned block older than
          // lastTimestamp - duration fell outside every bucket and left the fee
          // total, while summary.transactions still counted it. The span now
          // always covers the blocks actually scanned.
          const scannedSpanSeconds = Math.max(0, lastTimestamp - firstTimestamp)
          const usedTimestampWindow = from_timestamp !== undefined || to_timestamp !== undefined
          const feeSpanSeconds = Math.max(
            intervalSeconds,
            usedTimestampWindow ? scannedSpanSeconds : Math.max(durationSeconds, scannedSpanSeconds),
          )
          const feeBucketCount = Math.max(1, Math.ceil(feeSpanSeconds / intervalSeconds))
          const seriesStartTimestamp = lastTimestamp - feeSpanSeconds
          const feeBuckets = Array.from({ length: feeBucketCount }, (_, bucketIndex) => ({
            bucketIndex,
            bucketTimestamp: seriesStartTimestamp + bucketIndex * intervalSeconds,
            blocksInBucket: 0,
            transactions: 0,
            feeSats: 0n,
            firstBlockNumber: undefined as number | undefined,
            lastBlockNumber: undefined as number | undefined,
          }))
          for (const block of fees.blocks) {
            const bucketIndex = Math.floor((block.timestamp - seriesStartTimestamp) / intervalSeconds)
            /* Every scanned block lands in a bucket: the newest sits exactly at
               the series end and belongs to the last one, and nothing is
               dropped, so the window total and the bucket sum agree. */
            const bucket = feeBuckets[Math.min(Math.max(bucketIndex, 0), feeBucketCount - 1)]
            bucket.blocksInBucket += 1
            bucket.transactions += block.transaction_count
            bucket.feeSats += block.fee_sats
            bucket.firstBlockNumber = bucket.firstBlockNumber ?? block.block_number
            bucket.lastBlockNumber = block.block_number
          }
          const totalFeeSats = feeBuckets.reduce((sum, bucket) => sum + bucket.feeSats, 0n)
          const timeSeries = feeBuckets.map((bucket) => ({
            bucket_index: bucket.bucketIndex,
            timestamp: bucket.bucketTimestamp,
            timestamp_human: formatTimestamp(bucket.bucketTimestamp),
            blocks_in_bucket: bucket.blocksInBucket,
            transactions: bucket.transactions,
            /* value is the BTC amount for charts; value_sats and value_btc are exact. */
            value: Number(satsToBtcString(bucket.feeSats)),
            value_btc: satsToBtcString(bucket.feeSats),
            value_sats: bucket.feeSats.toString(),
            ...(bucket.firstBlockNumber !== undefined ? { from_block: bucket.firstBlockNumber } : {}),
            ...(bucket.lastBlockNumber !== undefined ? { to_block: bucket.lastBlockNumber } : {}),
          }))
          const filledBuckets = feeBuckets.filter((bucket) => bucket.blocksInBucket > 0).length
          const scanCapped = scanFrom > fromBlock
          /* A verified from-boundary proves there is no earlier block inside
             the window, so a bucket before the first block is a real gap in
             block production, not missing coverage. */
          const windowComplete =
            !scanCapped &&
            fees.excluded_blocks.length === 0 &&
            (resolvedWindow.from_lookup?.resolution === 'verified_boundary' || firstTimestamp <= seriesStartTimestamp)
          if (scanCapped) {
            notices.push(
              `Partial fee coverage: fees were scanned for the latest ${toBlock - scanFrom + 1} of ${requestedBlocks} requested blocks (${scanFrom}-${toBlock}). Earlier buckets are empty because they were not scanned, not because fees were zero.`,
            )
          }
          if (fees.excluded_blocks.length > 0) {
            notices.push(
              `Partial fee coverage: ${fees.excluded_blocks.length} block(s) were excluded because their inputs or outputs were incomplete (${fees.excluded_blocks.slice(0, 10).join(', ')}${fees.excluded_blocks.length > 10 ? ', ...' : ''}).`,
            )
          }
          const resultMessage = withWindowNotice(
            buildTimeSeriesAnswer({ dataset, metric, interval, duration, timeSeries, fromBlock: scanFrom, toBlock }),
            longWindowNotice,
          )
          return formatResult(
            {
              summary: {
                metric,
                metric_definition:
                  'Sum of non-coinbase input value minus non-coinbase output value per block, in satoshis, converted to BTC for display.',
                interval,
                duration,
                from_block: scanFrom,
                to_block: toBlock,
                requested_from_block: fromBlock,
                requested_blocks: requestedBlocks,
                scanned_blocks: fees.blocks.length,
                transactions: fees.blocks.reduce((sum, block) => sum + block.transaction_count, 0),
                total_fees_sats: totalFeeSats.toString(),
                total_fees_btc: satsToBtcString(totalFeeSats),
                total_buckets: timeSeries.length,
                filled_buckets: filledBuckets,
                window_anchor: 'latest_block',
                bucket_alignment: 'anchored_to_latest_block',
                ...(fees.excluded_blocks.length > 0 ? { excluded_blocks: fees.excluded_blocks } : {}),
              },
              chart: buildTimeSeriesChart({
                interval,
                totalPoints: timeSeries.length,
                recommendedVisual: getMetricRecommendedVisual(metric),
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
                windowComplete,
                firstObservedTimestamp: firstTimestamp,
                lastObservedTimestamp: lastTimestamp,
              }),
              time_series: timeSeries,
            },
            resultMessage,
            {
              toolName: 'portal_get_time_series',
              ...(notices.length > 0 ? { notices } : {}),
              freshness: buildQueryFreshness({
                finality: 'latest',
                headBlockNumber: head.number,
                windowToBlock: toBlock,
                resolvedWindow,
              }),
              coverage: buildBucketCoverage({
                /* The fee series spans the blocks that were scanned, not
                   exactly `duration`, because dropping a scanned block would
                   take its fees out of the buckets while leaving them in the
                   window total. Bitcoin block times are irregular, so a 2h
                   request routinely resolves to a block range spanning longer
                   than 2h and the series is a bucket or two longer. Reporting
                   the duration-derived count here made the response contradict
                   itself: expected_buckets 8 beside returned_buckets 10. */
                expectedBuckets: feeBucketCount,
                returnedBuckets: timeSeries.length,
                filledBuckets,
                anchor: 'latest_block',
                windowComplete,
              }),
              execution: buildExecutionMetadata({
                mode,
                metric,
                interval,
                duration,
                from_block: scanFrom,
                to_block: toBlock,
                range_kind: resolvedWindow.range_kind,
                notes: [
                  `Fees were computed from Bitcoin inputs and outputs for blocks ${scanFrom}-${toBlock} in exact satoshis.`,
                  ...(scanCapped
                    ? [
                        `The requested window had ${requestedBlocks} blocks; the fee series is capped at ${BITCOIN_FEE_SERIES_MAX_BLOCKS}.`,
                      ]
                    : []),
                  ...(longWindowNotice ? [longWindowNotice] : []),
                ],
              }),
              metadata: {
                network: dataset,
                dataset,
                from_block: scanFrom,
                to_block: toBlock,
                query_start_time: queryStartTime,
              },
            },
          )
        }
        const blockResults = (await portalFetchStream(
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
        )) as TimeSeriesBlock[]
        if (blockResults.length === 0) throw new Error('No data available for this time period')

        const firstTimestamp = getBlockTimestamp(blockResults[0])!
        const lastTimestamp = getBlockTimestamp(blockResults[blockResults.length - 1])!
        const seriesStartTimestamp = lastTimestamp - durationSeconds
        const buckets = createBucketAccumulators(expectedBuckets, seriesStartTimestamp, intervalSeconds)
        blockResults.forEach((block) => {
          const timestamp = getBlockTimestamp(block)
          const blockNumber = getBlockNumber(block)
          if (timestamp === undefined || blockNumber === undefined) return
          /* The newest block sits exactly at the series end and belongs to the
             last bucket. */
          const bucketIndex = Math.min(
            Math.floor((timestamp - seriesStartTimestamp) / intervalSeconds),
            expectedBuckets - 1,
          )
          if (bucketIndex < 0) return
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
          value: bucket.gasUsedSum,
        }))
        const filledBuckets = buckets.filter((bucket) => bucket.blocksInBucket > 0).length
        const resultMessage = withWindowNotice(
          buildTimeSeriesAnswer({
            dataset,
            metric,
            interval,
            duration,
            timeSeries,
            fromBlock,
            toBlock,
          }),
          longWindowNotice,
        )
        return formatResult(
          {
            summary: {
              metric,
              interval,
              duration,
              from_block: fromBlock,
              to_block: toBlock,
              total_buckets: timeSeries.length,
              filled_buckets: filledBuckets,
              window_anchor: 'latest_block',
              bucket_alignment: 'anchored_to_latest_block',
            },
            chart: buildTimeSeriesChart({
              interval,
              totalPoints: timeSeries.length,
              recommendedVisual: getMetricRecommendedVisual(metric),
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
          },
          resultMessage,
          {
            toolName: 'portal_get_time_series',
            ...(notices.length > 0 ? { notices } : {}),
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
              ...(longWindowNotice ? { notes: [longWindowNotice] } : {}),
            }),
            pipes: pipesRecipe,
            metadata: {
              network: dataset,
              dataset,
              from_block: fromBlock,
              to_block: toBlock,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      if (from_timestamp === undefined && to_timestamp === undefined) {
        assertSeriesDurationScannable({ dataset, chainType, duration })
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
      assertSeriesWindowScannable({ dataset, chainType, fromBlock, toBlock, duration })

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
        baseFields.transaction =
          chainType === 'solana' && metric === 'unique_addresses' ? { feePayer: true } : { transactionIndex: true }
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
      const hasTxData =
        metric === 'transaction_count' || metric === 'transactions_per_block' || metric === 'unique_addresses'
      const initialChunkSize =
        chainType === 'solana' && hasTxData
          ? (SOLANA_GENERIC_TIME_SERIES_CHUNK_SIZE[metric] ?? 1000)
          : chainType === 'evm' && hasTxData
            ? address
              ? 750
              : (EVM_GENERIC_TIME_SERIES_CHUNK_SIZE[metric] ?? 250)
            : hasTxData
              ? 5000
              : 10000
      let adaptiveChunkReduced = false
      const sortResults = (items: TimeSeriesBlock[]) =>
        items.sort((left, right) => (getBlockNumber(left) || 0) - (getBlockNumber(right) || 0))

      async function fetchBlocks(rangeFrom: number, rangeTo: number): Promise<TimeSeriesBlock[]> {
        if (rangeFrom > rangeTo) {
          return []
        }

        const results: TimeSeriesBlock[] = []
        let currentFrom = rangeFrom
        let chunkSize = initialChunkSize
        let chunkSizeReduced = false

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
            chunk = (await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
              maxBytes: chainType === 'solana' && hasTxData ? SOLANA_GENERIC_MAX_BYTES : 100 * 1024 * 1024,
            })) as TimeSeriesBlock[]
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const shouldReduceChunkSize =
              hasTxData &&
              (message.includes('Response too large') ||
                message.toLowerCase().includes('timed out') ||
                message.toLowerCase().includes('timeout'))

            if (chainType === 'solana' && shouldReduceChunkSize && chunkSize > MIN_SOLANA_GENERIC_CHUNK_SIZE) {
              chunkSize = Math.max(MIN_SOLANA_GENERIC_CHUNK_SIZE, Math.floor(chunkSize / 2))
              chunkSizeReduced = true
              adaptiveChunkReduced = true
              continue
            }

            if (chainType === 'evm' && shouldReduceChunkSize && chunkSize > MIN_EVM_GENERIC_CHUNK_SIZE) {
              chunkSize = Math.max(MIN_EVM_GENERIC_CHUNK_SIZE, Math.floor(chunkSize / 2))
              chunkSizeReduced = true
              adaptiveChunkReduced = true
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

      const requestedFromBlock = fromBlock
      let effectiveFromBlock = fromBlock
      if (mode === 'fast' && chainType === 'evm' && !address && hasTxData) {
        const requestedWindowSize = toBlock - fromBlock + 1
        if (requestedWindowSize > FAST_EVM_TIME_SERIES_BLOCK_CAP) {
          effectiveFromBlock = Math.max(0, toBlock - FAST_EVM_TIME_SERIES_BLOCK_CAP + 1)
        }
      }

      const cacheKey = stableCacheKey('time-series-generic', {
        dataset,
        metric,
        interval,
        duration,
        address,
        mode,
        from_block: effectiveFromBlock,
        to_block: toBlock,
        chain_type: chainType,
      })
      const { value: cachedSeries } = await timeSeriesCache.getOrLoad(cacheKey, async () => {
        let backfillAttempts = 0
        let results = await fetchBlocks(effectiveFromBlock, toBlock)

        if (results.length === 0) {
          throw new Error('No data available for this time period')
        }

        sortResults(results)

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

          if (
            firstResultBlockNumber <= 0 ||
            lastResultBlockNumber <= firstResultBlockNumber ||
            observedSpanSeconds <= 0
          ) {
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

        /* mode=fast reads the newest FAST_EVM_TIME_SERIES_BLOCK_CAP blocks of a
           longer window on purpose. Bucketing that slice against the requested
           duration produced empty buckets for hours the tool never read, and
           the coverage check then failed the whole call. The slice is bucketed
           over the span it covers and reported as an incomplete window. */
        const fastNarrowed = effectiveFromBlock > requestedFromBlock
        const seriesDurationSeconds = fastNarrowed
          ? Math.max(intervalSeconds, endTimestamp - firstResultTimestamp)
          : durationSeconds
        const seriesBuckets = fastNarrowed
          ? Math.max(1, Math.ceil(seriesDurationSeconds / intervalSeconds))
          : expectedBuckets
        const seriesStartTimestamp = endTimestamp - seriesDurationSeconds
        const buckets = createBucketAccumulators(seriesBuckets, seriesStartTimestamp, intervalSeconds)

        results.forEach((block) => {
          const typedBlock = block as TimeSeriesBlock
          const blockNumber = getBlockNumber(typedBlock)
          const timestamp = getBlockTimestamp(typedBlock)

          if (blockNumber === undefined || timestamp === undefined) {
            return
          }

          /* The newest block sits exactly at the series end and belongs to the
             last bucket. */
          const bucketIndex = Math.min(
            Math.floor((timestamp - seriesStartTimestamp) / intervalSeconds),
            seriesBuckets - 1,
          )
          if (bucketIndex < 0) {
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

        const values = timeSeries.map((t) => t.value as number)
        const avg = values.reduce((sum, v) => sum + v, 0) / values.length
        const min = Math.min(...values)
        const max = Math.max(...values)
        const filledBuckets = buckets.filter((bucket) => bucket.blocksInBucket > 0).length
        const observedSpanSeconds = Math.max(0, endTimestamp - firstResultTimestamp)
        const observedCoveragePct =
          seriesDurationSeconds > 0 ? (observedSpanSeconds / seriesDurationSeconds) * 100 : 100
        const hasCoverageGap = !address && !fastNarrowed && observedCoveragePct < 80

        const summary: Record<string, unknown> = {
          window_anchor: 'latest_block',
          bucket_alignment: 'anchored_to_latest_block',
          metric,
          interval,
          duration,
          mode,
          total_buckets: timeSeries.length,
          expected_buckets: seriesBuckets,
          filled_buckets: filledBuckets,
          empty_buckets: seriesBuckets - filledBuckets,
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
          ...(effectiveFromBlock !== requestedFromBlock ? { requested_from_block: requestedFromBlock } : {}),
        }

        if (address) {
          summary.filtered_by_address = address
        }
        if (backfillAttempts > 0) {
          summary.backfill_attempts = backfillAttempts
        }

        return {
          timeSeries,
          gapDiagnostics: buildBucketGapDiagnostics({
            buckets: timeSeries as Array<{
              bucket_index: number
              timestamp: number
              timestamp_human?: string
              blocks_in_bucket: number
            }>,
            intervalSeconds,
            isFilled: (bucket) => bucket.blocks_in_bucket > 0,
            anchor: 'latest_block',
            windowComplete: !hasCoverageGap && !fastNarrowed,
            ...(firstResultTimestamp > 0 ? { firstObservedTimestamp: firstResultTimestamp } : {}),
            ...(endTimestamp > 0 ? { lastObservedTimestamp: endTimestamp } : {}),
          }),
          summary,
          filledBuckets,
          expectedBuckets: seriesBuckets,
          observedSpanSeconds,
          observedCoveragePct,
          hasCoverageGap,
          fastNarrowed,
          firstResultTimestamp,
          endTimestamp,
          adaptiveChunkReduced,
          effectiveFromBlock,
        }
      })

      // Detect chain head staleness (most relevant for Bitcoin/slow chains)
      const summary = cachedSeries.summary as any
      if (cachedSeries.hasCoverageGap) {
        throw new ActionableError(
          'Bucket coverage was incomplete, so no time-series chart was returned.',
          [
            'Use a shorter duration or a larger interval.',
            'Retry with filters if you only need one address or contract.',
          ],
          {
            requested_window: describeTimeWindowInput(duration),
            observed_span_seconds: cachedSeries.observedSpanSeconds,
            observed_span_formatted: formatDuration(cachedSeries.observedSpanSeconds),
            expected_buckets: cachedSeries.expectedBuckets,
            filled_buckets: cachedSeries.filledBuckets,
            from_block: cachedSeries.effectiveFromBlock,
            to_block: toBlock,
          },
        )
      }
      const genericNotices = [
        ...notices,
        ...(cachedSeries.adaptiveChunkReduced
          ? ['Chunk size was reduced automatically to keep Portal responses within MCP limits.']
          : []),
        ...(cachedSeries.fastNarrowed
          ? [
              `mode=fast read only the newest ${FAST_EVM_TIME_SERIES_BLOCK_CAP.toLocaleString()} blocks (${formatDuration(cachedSeries.observedSpanSeconds)}) of the requested ${describeTimeWindowInput(duration)} window, so the window is incomplete; use mode=deep to read all of it.`,
            ]
          : []),
      ]
      const resultMessage = withWindowNotice(
        buildTimeSeriesAnswer({
          dataset,
          metric,
          interval,
          duration,
          timeSeries: cachedSeries.timeSeries,
          fromBlock: cachedSeries.effectiveFromBlock,
          toBlock,
          observedSpanSeconds: cachedSeries.observedSpanSeconds,
          unit: getMetricUnit(metric),
          windowNarrowedByFastMode: cachedSeries.fastNarrowed,
        }),
        longWindowNotice,
      )

      return formatResult(
        {
          summary,
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: cachedSeries.timeSeries.length,
            recommendedVisual: getMetricRecommendedVisual(metric),
            title: getMetricLabel(metric),
            subtitle: `Bucketed ${getMetricLabel(metric).toLowerCase()} across the selected window`,
            yAxisLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
          }),
          tables: [
            buildTimeSeriesTable({
              rowCount: cachedSeries.timeSeries.length,
              title: 'Time series buckets',
              valueLabel: getMetricLabel(metric),
              valueFormat: getMetricValueFormat(metric),
              unit: getMetricUnit(metric),
              timestampField: 'timestamp',
              blocksInBucketField: 'blocks_in_bucket',
              defaultSort: { key: 'bucket_index', direction: 'asc' },
            }),
          ],
          gap_diagnostics: cachedSeries.gapDiagnostics,
          time_series: cachedSeries.timeSeries,
        },
        resultMessage,
        {
          toolName: 'portal_get_time_series',
          ...(genericNotices.length > 0 ? { notices: genericNotices } : {}),
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: toBlock,
            resolvedWindow,
          }),
          coverage: buildBucketCoverage({
            expectedBuckets: cachedSeries.expectedBuckets,
            returnedBuckets: cachedSeries.timeSeries.length,
            filledBuckets: cachedSeries.filledBuckets,
            anchor: 'latest_block',
            windowComplete: !cachedSeries.hasCoverageGap && !cachedSeries.fastNarrowed,
            resultComplete: !cachedSeries.fastNarrowed,
          }),
          execution: buildExecutionMetadata({
            mode,
            metric,
            interval,
            duration,
            from_block: cachedSeries.effectiveFromBlock,
            to_block: toBlock,
            range_kind: resolvedWindow.range_kind,
            ...(longWindowNotice ? { notes: [longWindowNotice] } : {}),
          }),
          pipes: pipesRecipe,
          ui: buildSimpleSeriesUi({
            title: getMetricLabel(metric),
            subtitle: resultMessage,
            metricLabel: getMetricLabel(metric),
            valueFormat: getMetricValueFormat(metric),
            unit: getMetricUnit(metric),
            avgValuePath: 'summary.statistics.avg',
          }),
          metadata: {
            network: dataset,
            dataset,
            from_block: cachedSeries.effectiveFromBlock,
            to_block: toBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
