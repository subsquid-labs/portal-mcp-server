import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { createQueryCache, stableCacheKey } from '../../cache/query-cache.js'
import { PORTAL_URL } from '../../constants/index.js'
import { buildTableDescriptor, buildTimeSeriesChart, buildTimeSeriesTable } from '../../helpers/chart-metadata.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError, createUnsupportedMetricError } from '../../helpers/errors.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatDuration, formatTimestamp } from '../../helpers/formatting.js'
import { buildBucketCoverage, buildBucketGapDiagnostics, buildQueryFreshness } from '../../helpers/result-metadata.js'
import {
  getHeadTimestamp,
  getTimestampWindowNotices,
  parseTimeframeToSeconds,
  parseTimestampInput,
  resolveTimeframeOrBlocks,
} from '../../helpers/timeframe.js'
import { computeSolanaTimeSeries } from '../solana/time-series-shared.js'

type CompareMetric =
  | 'transaction_count'
  | 'avg_gas_price'
  | 'gas_used'
  | 'block_utilization'
  | 'unique_addresses'

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

type SeriesPoint = {
  bucket_index: number
  timestamp: number
  timestamp_human: string
  blocks_in_bucket: number
  value: number
  block_range?: string
}

type WindowSeriesResult = {
  summary: Record<string, unknown>
  timeSeries: SeriesPoint[]
  gapDiagnostics: unknown
  freshness: ReturnType<typeof buildQueryFreshness>
  coverage: ReturnType<typeof buildBucketCoverage>
  notices: string[]
  metadata: {
    dataset: string
    from_block: number
    to_block: number
  }
}

const WINDOW_SERIES_CACHE_TTL_MS = 30_000
const WINDOW_SERIES_CACHE_MAX_ENTRIES = 24

const windowSeriesCache = createQueryCache<WindowSeriesResult>({
  ttl: WINDOW_SERIES_CACHE_TTL_MS,
  maxEntries: WINDOW_SERIES_CACHE_MAX_ENTRIES,
})

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

function computePctChange(current: number, previous: number): number | null {
  if (previous === 0) {
    return current === 0 ? 0 : null
  }

  return Number((((current - previous) / previous) * 100).toFixed(2))
}

export async function computeWindowSeries(params: {
  dataset: string
  metric: CompareMetric
  interval: '5m' | '15m' | '1h' | '6h' | '1d'
  duration: '1h' | '6h' | '24h' | '7d' | '30d'
  address?: string
  fromTimestamp: number
  toTimestampInclusive: number
}): Promise<WindowSeriesResult> {
  const cacheKey = stableCacheKey('window-series', params)
  const { value } = await windowSeriesCache.getOrLoad(cacheKey, async () => {
    const { dataset, metric, interval, duration, address, fromTimestamp, toTimestampInclusive } = params
    const chainType = detectChainType(dataset)
    const resolvedWindow = await resolveTimeframeOrBlocks({
      dataset,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestampInclusive,
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
    const expectedBuckets = Math.max(1, Math.ceil(durationSeconds / intervalSeconds))
    const seriesStartTimestamp = fromTimestamp

    if (chainType === 'solana') {
      const solanaResult = await computeSolanaTimeSeries({
        dataset,
        metric: metric === 'unique_addresses' ? 'unique_wallets' : 'transaction_count',
        interval,
        duration: duration as '1h' | '6h' | '24h' | '7d',
        trimIncompleteLastBucket: false,
        resolved_window: resolvedWindow,
      })

      const timeSeries: SeriesPoint[] = solanaResult.time_series.map((point) => ({
        bucket_index: point.bucket_index,
        timestamp: point.timestamp,
        timestamp_human: point.timestamp_human,
        blocks_in_bucket: point.slots_in_bucket,
        value: point.value,
      }))
      const filledBuckets = timeSeries.filter((point) => point.blocks_in_bucket > 0).length
      const windowComplete =
        solanaResult.first_observed_timestamp !== undefined
          ? solanaResult.first_observed_timestamp <= fromTimestamp
          : true

      return {
        summary: {
          metric,
          interval,
          duration,
          total_buckets: timeSeries.length,
          expected_buckets: solanaResult.expected_buckets,
          filled_buckets: filledBuckets,
          empty_buckets: solanaResult.expected_buckets - filledBuckets,
          total_blocks: solanaResult.total_slots,
          returned_blocks: solanaResult.returned_blocks,
          from_block: solanaResult.from_block,
          to_block: solanaResult.to_block,
          window_start_timestamp: fromTimestamp,
          window_start_timestamp_human: formatTimestamp(fromTimestamp),
          window_end_timestamp: toTimestampInclusive,
          window_end_timestamp_human: formatTimestamp(toTimestampInclusive),
          observed_span_seconds: solanaResult.observed_span_seconds,
          observed_span_formatted: solanaResult.observed_span_formatted,
          statistics: {
            avg: solanaResult.statistics.avg,
            min: solanaResult.statistics.min,
            max: solanaResult.statistics.max,
          },
        },
        timeSeries,
        gapDiagnostics: buildBucketGapDiagnostics({
          buckets: timeSeries,
          intervalSeconds,
          isFilled: (bucket) => bucket.blocks_in_bucket > 0,
          anchor: 'timestamp_window',
          windowComplete,
          ...(solanaResult.first_observed_timestamp !== undefined
            ? { firstObservedTimestamp: solanaResult.first_observed_timestamp }
            : {}),
          ...(solanaResult.last_observed_timestamp !== undefined
            ? { lastObservedTimestamp: solanaResult.last_observed_timestamp }
            : {}),
        }),
        freshness: buildQueryFreshness({
          finality: 'latest',
          headBlockNumber: head.number,
          windowToBlock: solanaResult.to_block,
          resolvedWindow,
        }),
        coverage: buildBucketCoverage({
          expectedBuckets: solanaResult.expected_buckets,
          returnedBuckets: timeSeries.length,
          filledBuckets,
          anchor: 'timestamp_window',
          windowComplete,
        }),
        notices: getTimestampWindowNotices(resolvedWindow),
        metadata: {
          dataset,
          from_block: solanaResult.from_block,
          to_block: solanaResult.to_block,
        },
      }
    }

    const queryType = chainType === 'bitcoin' ? 'bitcoin' : 'evm'
    const baseFields: any = {
      block: { number: true, timestamp: true },
    }
    const queryExtras: any = {}

    if (metric === 'transaction_count' || metric === 'unique_addresses') {
      baseFields.transaction = { transactionIndex: true }
      if (metric === 'unique_addresses') {
        baseFields.transaction.from = true
        baseFields.transaction.to = true
      }
      if (address && chainType === 'evm') {
        queryExtras.transactions = [{ to: [address.toLowerCase()] }]
      } else {
        queryExtras.transactions = [{}]
      }
    } else if (metric === 'avg_gas_price') {
      baseFields.block.baseFeePerGas = true
    } else if (metric === 'gas_used' || metric === 'block_utilization') {
      baseFields.block.gasUsed = true
      baseFields.block.gasLimit = true
    }

    const hasTxData = metric === 'transaction_count' || metric === 'unique_addresses'
    const initialChunkSize = hasTxData ? 5000 : 10000
    const sortResults = (items: TimeSeriesBlock[]) =>
      items.sort((left, right) => (getBlockNumber(left) || 0) - (getBlockNumber(right) || 0))

    async function fetchBlocks(rangeFrom: number, rangeTo: number): Promise<TimeSeriesBlock[]> {
      if (rangeFrom > rangeTo) {
        return []
      }

      const results: TimeSeriesBlock[] = []
      let currentFrom = rangeFrom

      while (currentFrom <= rangeTo) {
        const plannedTo = Math.min(currentFrom + initialChunkSize - 1, rangeTo)
        const chunk = await portalFetchStream(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          {
            type: queryType,
            fromBlock: currentFrom,
            toBlock: plannedTo,
            includeAllBlocks: true,
            fields: baseFields,
            ...queryExtras,
          },
          {
            maxBytes: 100 * 1024 * 1024,
          },
        ) as TimeSeriesBlock[]

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

    const results = await fetchBlocks(fromBlock, toBlock)
    if (results.length === 0) {
      throw new Error('No data available for this comparison window')
    }

    sortResults(results)

    const buckets = createBucketAccumulators(expectedBuckets, seriesStartTimestamp, intervalSeconds)
    let firstObservedTimestamp: number | undefined
    let lastObservedTimestamp: number | undefined

    results.forEach((block) => {
      const blockNumber = getBlockNumber(block)
      const timestamp = getBlockTimestamp(block)

      if (blockNumber === undefined || timestamp === undefined) {
        return
      }

      if (firstObservedTimestamp === undefined || timestamp < firstObservedTimestamp) firstObservedTimestamp = timestamp
      if (lastObservedTimestamp === undefined || timestamp > lastObservedTimestamp) lastObservedTimestamp = timestamp

      const bucketIndex = Math.floor((timestamp - seriesStartTimestamp) / intervalSeconds)
      if (bucketIndex < 0 || bucketIndex >= expectedBuckets) {
        return
      }

      const bucket = buckets[bucketIndex]
      bucket.blocksInBucket++
      bucket.firstBlockNumber = bucket.firstBlockNumber ?? blockNumber
      bucket.lastBlockNumber = blockNumber

      if (metric === 'transaction_count') {
        bucket.txCount += block.transactions?.length || 0
        return
      }

      if (metric === 'avg_gas_price') {
        const baseFeePerGas = getBlockBigIntString(block, 'baseFeePerGas')
        if (baseFeePerGas) {
          bucket.gasPriceSum += parseInt(baseFeePerGas)
          bucket.gasPriceCount++
        }
        return
      }

      if (metric === 'gas_used') {
        bucket.gasUsedSum += parseInt(getBlockBigIntString(block, 'gasUsed') || '0')
        return
      }

      if (metric === 'block_utilization') {
        const gasUsed = parseInt(getBlockBigIntString(block, 'gasUsed') || '0')
        const gasLimit = parseInt(getBlockBigIntString(block, 'gasLimit') || '0')
        if (gasLimit > 0) {
          bucket.utilizationSum += (gasUsed / gasLimit) * 100
          bucket.utilizationCount++
        }
        return
      }

      if (metric === 'unique_addresses') {
        block.transactions?.forEach((tx) => {
          if (tx.feePayer) bucket.addresses.add(tx.feePayer)
          if (tx.from) bucket.addresses.add(tx.from.toLowerCase())
          if (tx.to) bucket.addresses.add(tx.to.toLowerCase())
        })
      }
    })

    const timeSeries: SeriesPoint[] = buckets.map((bucket) => {
      let value = 0

      if (metric === 'transaction_count') {
        value = bucket.txCount
      } else if (metric === 'avg_gas_price') {
        value = bucket.gasPriceCount > 0 ? bucket.gasPriceSum / bucket.gasPriceCount / 1e9 : 0
      } else if (metric === 'gas_used') {
        value = bucket.gasUsedSum
      } else if (metric === 'block_utilization') {
        value = bucket.utilizationCount > 0 ? bucket.utilizationSum / bucket.utilizationCount : 0
      } else if (metric === 'unique_addresses') {
        value = bucket.addresses.size
      }

      return {
        bucket_index: bucket.bucketIndex,
        timestamp: bucket.bucketTimestamp,
        timestamp_human: formatTimestamp(bucket.bucketTimestamp),
        blocks_in_bucket: bucket.blocksInBucket,
        value: Number(value.toFixed(2)),
        ...(bucket.firstBlockNumber !== undefined && bucket.lastBlockNumber !== undefined
          ? { block_range: `${bucket.firstBlockNumber}-${bucket.lastBlockNumber}` }
          : {}),
      }
    })

    const values = timeSeries.map((point) => point.value)
    const avg = values.reduce((sum, pointValue) => sum + pointValue, 0) / values.length
    const min = Math.min(...values)
    const max = Math.max(...values)
    const filledBuckets = buckets.filter((bucket) => bucket.blocksInBucket > 0).length
    const windowComplete =
      (firstObservedTimestamp === undefined || firstObservedTimestamp <= fromTimestamp) &&
      (lastObservedTimestamp === undefined || lastObservedTimestamp >= toTimestampInclusive - intervalSeconds + 1)

    return {
      summary: {
        metric,
        interval,
        duration,
        total_buckets: timeSeries.length,
        expected_buckets: expectedBuckets,
        filled_buckets: filledBuckets,
        empty_buckets: expectedBuckets - filledBuckets,
        total_blocks: results.length,
        from_block: fromBlock,
        to_block: toBlock,
        window_start_timestamp: fromTimestamp,
        window_start_timestamp_human: formatTimestamp(fromTimestamp),
        window_end_timestamp: toTimestampInclusive,
        window_end_timestamp_human: formatTimestamp(toTimestampInclusive),
        observed_span_seconds:
          firstObservedTimestamp !== undefined && lastObservedTimestamp !== undefined
            ? Math.max(0, lastObservedTimestamp - firstObservedTimestamp)
            : 0,
        observed_span_formatted:
          firstObservedTimestamp !== undefined && lastObservedTimestamp !== undefined
            ? formatDuration(Math.max(0, lastObservedTimestamp - firstObservedTimestamp))
            : formatDuration(0),
        statistics: {
          avg: Number(avg.toFixed(2)),
          min: Number(min.toFixed(2)),
          max: Number(max.toFixed(2)),
        },
        ...(address ? { filtered_by_address: address } : {}),
      },
      timeSeries,
      gapDiagnostics: buildBucketGapDiagnostics({
        buckets: timeSeries,
        intervalSeconds,
        isFilled: (bucket) => bucket.blocks_in_bucket > 0,
        anchor: 'timestamp_window',
        windowComplete,
        ...(firstObservedTimestamp !== undefined ? { firstObservedTimestamp } : {}),
        ...(lastObservedTimestamp !== undefined ? { lastObservedTimestamp } : {}),
      }),
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
        anchor: 'timestamp_window',
        windowComplete,
      }),
      notices: getTimestampWindowNotices(resolvedWindow),
      metadata: {
        dataset,
        from_block: fromBlock,
        to_block: toBlock,
      },
    }
  })

  return value
}

export function registerComparePeriodsTool(server: McpServer) {
  server.tool(
    'portal_compare_periods',
    `Compare the current period against the immediately previous period for chartable blockchain metrics. Returns current and previous series plus delta summaries.`,
    {
      dataset: z.string().describe("Dataset name (supports short names like 'base', 'ethereum', 'solana', 'bitcoin')"),
      metric: z
        .enum(['transaction_count', 'avg_gas_price', 'gas_used', 'block_utilization', 'unique_addresses'])
        .describe('Metric to compare across adjacent time windows'),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval'),
      duration: z.enum(['1h', '6h', '24h', '7d', '30d']).describe('Duration for each period window'),
      address: z.string().optional().describe('Optional EVM contract address filter for contract-specific comparisons'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Optional period end time. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
    },
    async ({ dataset, metric, interval, duration, address, to_timestamp }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        throw createUnsupportedChainError({
          toolName: 'portal_compare_periods',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin'],
          suggestions: [
            'Use portal_hyperliquid_time_series for Hyperliquid trend charts.',
            'Use portal_hyperliquid_get_analytics for period snapshots on Hyperliquid fills.',
          ],
        })
      }

      const gasMetrics = ['avg_gas_price', 'gas_used', 'block_utilization']
      if (gasMetrics.includes(metric) && chainType !== 'evm') {
        throw createUnsupportedMetricError({
          toolName: 'portal_compare_periods',
          metric,
          dataset,
          supportedMetrics: ['transaction_count', 'unique_addresses'],
          reason: 'Gas metrics are available only on EVM datasets.',
        })
      }

      if (metric === 'unique_addresses' && chainType === 'bitcoin') {
        throw createUnsupportedMetricError({
          toolName: 'portal_compare_periods',
          metric,
          dataset,
          supportedMetrics: ['transaction_count'],
          reason: 'Bitcoin uses a UTXO model, so there is no simple address set for this metric.',
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
          metric,
          interval,
          duration,
          address,
          fromTimestamp: currentStartTimestamp,
          toTimestampInclusive: currentEndInclusive,
        }),
        computeWindowSeries({
          dataset,
          metric,
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
          pct_change: computePctChange(point.value, previousPoint.value),
        }
      })

      const currentValues = currentSeries.timeSeries.map((point) => point.value)
      const previousValues = previousSeries.timeSeries.map((point) => point.value)
      const currentTotal = Number(currentValues.reduce((sum, value) => sum + value, 0).toFixed(2))
      const previousTotal = Number(previousValues.reduce((sum, value) => sum + value, 0).toFixed(2))
      const currentAvg = Number((currentTotal / currentValues.length).toFixed(2))
      const previousAvg = Number((previousTotal / previousValues.length).toFixed(2))
      const summaryRows = [
        {
          label: 'Total',
          current_value: currentTotal,
          previous_value: previousTotal,
          delta: Number((currentTotal - previousTotal).toFixed(2)),
          pct_change: computePctChange(currentTotal, previousTotal),
        },
        {
          label: 'Average bucket value',
          current_value: currentAvg,
          previous_value: previousAvg,
          delta: Number((currentAvg - previousAvg).toFixed(2)),
          pct_change: computePctChange(currentAvg, previousAvg),
        },
      ]

      const notices = [
        ...currentSeries.notices,
        ...previousSeries.notices,
      ]

      return formatResult(
        {
          summary: {
            metric,
            interval,
            duration,
            current_window: {
              from_block: currentSeries.metadata.from_block,
              to_block: currentSeries.metadata.to_block,
              start_timestamp: currentStartTimestamp,
              start_timestamp_human: formatTimestamp(currentStartTimestamp),
              end_timestamp: currentEndInclusive,
              end_timestamp_human: formatTimestamp(currentEndInclusive),
            },
            previous_window: {
              from_block: previousSeries.metadata.from_block,
              to_block: previousSeries.metadata.to_block,
              start_timestamp: previousStartTimestamp,
              start_timestamp_human: formatTimestamp(previousStartTimestamp),
              end_timestamp: previousEndInclusive,
              end_timestamp_human: formatTimestamp(previousEndInclusive),
            },
          },
          comparison: {
            current_total: currentTotal,
            previous_total: previousTotal,
            total_delta: Number((currentTotal - previousTotal).toFixed(2)),
            total_pct_change: computePctChange(currentTotal, previousTotal),
            current_avg_bucket_value: currentAvg,
            previous_avg_bucket_value: previousAvg,
            avg_bucket_delta: Number((currentAvg - previousAvg).toFixed(2)),
            avg_bucket_pct_change: computePctChange(currentAvg, previousAvg),
            strongest_bucket_delta: bucketDeltas.reduce((best, item) => (item.delta > best.delta ? item : best), bucketDeltas[0]),
            weakest_bucket_delta: bucketDeltas.reduce((worst, item) => (item.delta < worst.delta ? item : worst), bucketDeltas[0]),
          },
          chart: buildTimeSeriesChart({
            interval,
            totalPoints: comparisonSeries.length,
            groupedValueField: 'period',
            xField: 'bucket_index',
            recommendedVisual: 'line',
            dataKey: 'comparison_series',
            title: `${metric} current vs previous`,
            xAxisLabel: 'Bucket',
            yAxisLabel: metric,
          }),
          tables: [
            buildTableDescriptor({
              id: 'summary_rows',
              dataKey: 'summary_rows',
              rowCount: summaryRows.length,
              title: 'Current vs previous summary',
              defaultSort: { key: 'label', direction: 'asc' },
              dense: true,
              columns: [
                { key: 'label', label: 'Metric', kind: 'dimension' },
                { key: 'current_value', label: 'Current', kind: 'metric', format: 'decimal', align: 'right' },
                { key: 'previous_value', label: 'Previous', kind: 'metric', format: 'decimal', align: 'right' },
                { key: 'delta', label: 'Delta', kind: 'metric', format: 'decimal', align: 'right' },
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
              valueLabel: 'Value',
              valueFormat: 'decimal',
              timestampField: 'timestamp',
              keyField: 'period',
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
                { key: 'current_value', label: 'Current', kind: 'metric', format: 'decimal', align: 'right' },
                { key: 'previous_value', label: 'Previous', kind: 'metric', format: 'decimal', align: 'right' },
                { key: 'delta', label: 'Delta', kind: 'metric', format: 'decimal', align: 'right' },
                { key: 'pct_change', label: 'Pct change', kind: 'metric', format: 'percent', unit: '%', align: 'right' },
              ],
            }),
          ],
          summary_rows: summaryRows,
          current_series: currentSeries.timeSeries,
          previous_series: previousSeries.timeSeries,
          comparison_series: comparisonSeries,
          bucket_deltas: bucketDeltas,
          gap_diagnostics: {
            current: currentSeries.gapDiagnostics,
            previous: previousSeries.gapDiagnostics,
          },
        },
        `Compared ${metric} across the current and previous ${duration} windows. Current total: ${currentTotal.toLocaleString()}, previous total: ${previousTotal.toLocaleString()}.`,
        {
          ...(notices.length > 0 ? { notices } : {}),
          freshness: {
            kind: 'period_compare',
            current: currentSeries.freshness,
            previous: previousSeries.freshness,
            anchor_timestamp: currentEndInclusive,
            anchor_timestamp_human: formatTimestamp(currentEndInclusive),
          },
          coverage: {
            kind: 'period_compare',
            current: currentSeries.coverage,
            previous: previousSeries.coverage,
            aligned_buckets: currentSeries.timeSeries.length,
          },
          metadata: {
            dataset,
            from_block: previousSeries.metadata.from_block,
            to_block: currentSeries.metadata.to_block,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
