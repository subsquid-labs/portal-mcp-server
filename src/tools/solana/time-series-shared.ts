import { validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchStream, portalFetchStreamVisit } from '../../helpers/fetch.js'
import { formatDuration, formatNumber, formatTimestamp } from '../../helpers/formatting.js'
import { hashString53 } from '../../helpers/hash.js'
import { parseTimeframeToSeconds, resolveTimeframeOrBlocks, type ResolvedBlockWindow, type TimestampInput } from '../../helpers/timeframe.js'

export type SolanaTimeSeriesMetric =
  | 'tps'
  | 'transaction_count'
  | 'unique_wallets'
  | 'avg_fee'
  | 'success_rate'
  | 'slots_per_hour'

export interface SolanaTimeSeriesPoint {
  bucket_index: number
  timestamp: number
  timestamp_human: string
  slots_in_bucket: number
  txs_in_bucket: number
  value: number
  value_formatted: string
}

export interface SolanaTimeSeriesResult {
  metric: SolanaTimeSeriesMetric
  unit: string
  interval: string
  duration: string
  total_slots: number
  returned_blocks: number
  expected_buckets: number
  from_block: number
  to_block: number
  observed_span_seconds: number
  observed_span_formatted: string
  first_observed_timestamp?: number
  last_observed_timestamp?: number
  chunks_fetched: number
  chunk_size_reduced: boolean
  statistics: {
    avg: number
    avg_formatted: string
    min: number
    max: number
  }
  time_series: SolanaTimeSeriesPoint[]
}

interface ComputeSolanaTimeSeriesOptions {
  dataset: string
  metric: SolanaTimeSeriesMetric
  interval: '5m' | '15m' | '1h' | '6h' | '1d'
  duration: '1h' | '6h' | '24h' | '7d'
  trimIncompleteLastBucket?: boolean
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  resolved_window?: ResolvedBlockWindow
}

type SolanaSlotRange = {
  from: number
  to: number
}

type BucketData = {
  slots: number
  txCount: number
  errorCount: number
  totalFees: number
  wallets: Set<number>
  minTimestamp: number
  maxTimestamp: number
}

const CHUNK_SIZE_BY_METRIC: Record<SolanaTimeSeriesMetric, number> = {
  tps: 5000,
  transaction_count: 20000,
  unique_wallets: 4000,
  avg_fee: 2500,
  success_rate: 2500,
  slots_per_hour: 5000,
}

const CONCURRENCY_BY_METRIC: Record<SolanaTimeSeriesMetric, number> = {
  tps: 2,
  transaction_count: 3,
  unique_wallets: 3,
  avg_fee: 2,
  success_rate: 2,
  slots_per_hour: 2,
}

const UNIT_BY_METRIC: Record<SolanaTimeSeriesMetric, string> = {
  tps: 'tx/s',
  transaction_count: 'txs',
  unique_wallets: 'wallets',
  avg_fee: 'lamports',
  success_rate: '%',
  slots_per_hour: 'slots/h',
}

const MIN_SOLANA_CHUNK_SIZE = 250
const SOLANA_CHUNK_MAX_BYTES = 150 * 1024 * 1024

function buildSlotRanges(from: number, to: number, chunkSize: number): SolanaSlotRange[] {
  const ranges: SolanaSlotRange[] = []
  for (let current = from; current <= to; current += chunkSize) {
    ranges.push({
      from: current,
      to: Math.min(current + chunkSize - 1, to),
    })
  }
  return ranges
}

function buildTransactionFields(metric: SolanaTimeSeriesMetric) {
  const fields: Record<string, boolean> = {}

  if (metric === 'avg_fee') fields.fee = true
  if (metric === 'unique_wallets') fields.feePayer = true
  if (metric === 'success_rate') fields.err = true

  return fields
}

function createBucket(): BucketData {
  return {
    slots: 0,
    txCount: 0,
    errorCount: 0,
    totalFees: 0,
    wallets: new Set<number>(),
    minTimestamp: Infinity,
    maxTimestamp: 0,
  }
}

async function fetchSolanaBlockTimestamp(dataset: string, blockNumber: number): Promise<number | undefined> {
  const result = await portalFetchStream(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    {
      type: 'solana',
      fromBlock: blockNumber,
      toBlock: blockNumber,
      includeAllBlocks: true,
      fields: {
        block: {
          timestamp: true,
        },
      },
    },
    {
      maxBlocks: 1,
      maxBytes: 2 * 1024 * 1024,
    },
  )

  const firstBlock = result[0] as { header?: { timestamp?: number }; timestamp?: number } | undefined
  return firstBlock?.header?.timestamp ?? firstBlock?.timestamp
}

function aggregateBucketTransactions(
  metric: SolanaTimeSeriesMetric,
  bucket: BucketData,
  txs: Array<{ fee?: string; feePayer?: string; err?: unknown }>,
) {
  bucket.txCount += txs.length

  switch (metric) {
    case 'unique_wallets':
      txs.forEach((tx) => {
        if (tx.feePayer) bucket.wallets.add(hashString53(tx.feePayer))
      })
      break
    case 'avg_fee':
      txs.forEach((tx) => {
        bucket.totalFees += parseInt(tx.fee || '0', 10) || 0
      })
      break
    case 'success_rate':
      txs.forEach((tx) => {
        if (tx.err) bucket.errorCount++
      })
      break
    default:
      break
  }
}

export async function computeSolanaTimeSeries({
  dataset,
  metric,
  interval,
  duration,
  trimIncompleteLastBucket = true,
  from_timestamp,
  to_timestamp,
  resolved_window,
}: ComputeSolanaTimeSeriesOptions): Promise<SolanaTimeSeriesResult> {
  const resolvedWindow = resolved_window ?? await resolveTimeframeOrBlocks({
    dataset,
    ...(from_timestamp !== undefined || to_timestamp !== undefined
      ? {
          from_timestamp,
          to_timestamp,
        }
      : {
          timeframe: duration,
        }),
  })

  const { from_block: fromBlock, to_block: toBlock } = resolvedWindow

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
      `Use a shorter duration (e.g., '1h', '6h', or '24h') or a larger interval.`,
    )
  }

  const effectiveFrom = fromBlock
  const slotSpan = endBlock - effectiveFrom + 1
  const endTimestamp = await fetchSolanaBlockTimestamp(dataset, endBlock)
  if (endTimestamp === undefined) {
    throw new Error('Could not resolve the ending Solana block timestamp for time series bucketing')
  }
  const seriesStartTimestamp = endTimestamp - durationSeconds
  const buckets = Array.from({ length: expectedBuckets }, () => createBucket())
  const includeAllBlocks = metric === 'tps' || metric === 'slots_per_hour'

  const transactionFields = buildTransactionFields(metric)
  const initialChunkSize = Math.min(
    CHUNK_SIZE_BY_METRIC[metric],
    Math.max(1, slotRange + 1),
  )
  const initialRanges = buildInitialRanges(effectiveFrom, endBlock, initialChunkSize)
  const concurrency = CONCURRENCY_BY_METRIC[metric]

  let firstObservedTimestamp: number | undefined
  let lastObservedTimestamp: number | undefined
  let returnedBlocks = 0
  let chunksFetched = 0
  let chunkSizeReduced = false

  for (let index = 0; index < initialRanges.length; index += concurrency) {
    const rangeBatch = initialRanges.slice(index, index + concurrency)
    const batchResults = await Promise.all(
      rangeBatch.map((range) =>
        visitSolanaTimeSeriesRange({
          dataset,
          rangeFrom: range.from,
          rangeTo: range.to,
          includeAllBlocks,
          transactionFields,
          initialChunkSize: Math.min(initialChunkSize, range.to - range.from + 1),
          onRecord: (record) => {
            const block = record as {
              header?: { timestamp?: number }
              timestamp?: number
              transactions?: Array<{ fee?: string; feePayer?: string; err?: unknown }>
            }

            const ts = block.header?.timestamp ?? block.timestamp
            if (!ts) return

            returnedBlocks++
            if (firstObservedTimestamp === undefined || ts < firstObservedTimestamp) firstObservedTimestamp = ts
            if (lastObservedTimestamp === undefined || ts > lastObservedTimestamp) lastObservedTimestamp = ts

            const bucketIndex = Math.floor((ts - seriesStartTimestamp) / intervalSeconds)
            if (bucketIndex >= expectedBuckets || bucketIndex < 0) return

            const bucket = buckets[bucketIndex]
            bucket.slots++
            if (ts < bucket.minTimestamp) bucket.minTimestamp = ts
            if (ts > bucket.maxTimestamp) bucket.maxTimestamp = ts

            const txs = block.transactions || []
            aggregateBucketTransactions(metric, bucket, txs)
          },
        }),
      ),
    )

    for (const result of batchResults) {
      chunksFetched += result.chunksFetched
      chunkSizeReduced = chunkSizeReduced || result.chunkSizeReduced
    }
  }

  if (returnedBlocks === 0 && includeAllBlocks) {
    throw new Error('No data available for this time period')
  }

  const unit = UNIT_BY_METRIC[metric]
  let timeSeries = buckets
    .map((data, bucketIndex) => {
      const bucketTimestamp = seriesStartTimestamp + bucketIndex * intervalSeconds
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
        value_formatted: `${formatNumber(value)} ${unit}`.trim(),
      }
    })
    .sort((left, right) => left.bucket_index - right.bucket_index)

  if (trimIncompleteLastBucket && includeAllBlocks && timeSeries.length > 2) {
    const slotCounts = timeSeries.slice(0, -1).map((point) => point.slots_in_bucket)
    const sorted = [...slotCounts].sort((left, right) => left - right)
    const median = sorted[Math.floor(sorted.length / 2)]
    const last = timeSeries[timeSeries.length - 1]
    if (last.slots_in_bucket < median * 0.3) {
      timeSeries = timeSeries.slice(0, -1)
    }
  }

  const values = timeSeries.map((point) => point.value)
  const avg = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  let min = Infinity
  let max = -Infinity
  values.forEach((value) => {
    if (value < min) min = value
    if (value > max) max = value
  })
  if (!isFinite(min)) min = 0
  if (!isFinite(max)) max = 0

  const observedSpanSeconds =
    firstObservedTimestamp !== undefined && lastObservedTimestamp !== undefined
      ? Math.max(0, lastObservedTimestamp - firstObservedTimestamp)
      : 0

  return {
    metric,
    unit,
    interval,
    duration,
    total_slots: slotSpan,
    returned_blocks: returnedBlocks,
    expected_buckets: expectedBuckets,
    from_block: effectiveFrom,
    to_block: endBlock,
    observed_span_seconds: observedSpanSeconds,
    observed_span_formatted: formatDuration(observedSpanSeconds),
    ...(firstObservedTimestamp !== undefined ? { first_observed_timestamp: firstObservedTimestamp } : {}),
    ...(lastObservedTimestamp !== undefined ? { last_observed_timestamp: lastObservedTimestamp } : {}),
    chunks_fetched: chunksFetched,
    chunk_size_reduced: chunkSizeReduced,
    statistics: {
      avg: parseFloat(avg.toFixed(2)),
      avg_formatted: `${formatNumber(avg)} ${unit}`.trim(),
      min: parseFloat(min.toFixed(2)),
      max: parseFloat(max.toFixed(2)),
    },
    time_series: timeSeries,
  }
}

function buildInitialRanges(from: number, to: number, chunkSize: number): SolanaSlotRange[] {
  return buildSlotRanges(from, to, Math.max(chunkSize, MIN_SOLANA_CHUNK_SIZE))
}

async function visitSolanaTimeSeriesRange({
  dataset,
  rangeFrom,
  rangeTo,
  includeAllBlocks,
  transactionFields,
  initialChunkSize,
  onRecord,
}: {
  dataset: string
  rangeFrom: number
  rangeTo: number
  includeAllBlocks: boolean
  transactionFields: Record<string, boolean>
  initialChunkSize: number
  onRecord: (record: unknown) => void | Promise<void>
}): Promise<{ chunksFetched: number; chunkSizeReduced: boolean }> {
  let currentFrom = rangeFrom
  let chunkSize = initialChunkSize
  let chunksFetched = 0
  let chunkSizeReduced = false

  while (currentFrom <= rangeTo) {
    const chunkTo = Math.min(currentFrom + chunkSize - 1, rangeTo)
    let lastReturnedBlock: number | undefined

    try {
      const processedBlocks = await portalFetchStreamVisit(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        {
          type: 'solana',
          fromBlock: currentFrom,
          toBlock: chunkTo,
          includeAllBlocks,
          fields: {
            block: { timestamp: true },
            transaction: transactionFields,
          },
          transactions: [{}],
        },
        {
          maxBytes: SOLANA_CHUNK_MAX_BYTES,
          onRecord: async (record) => {
            const block = record as { number?: number; header?: { number?: number } }
            const blockNumber = block.number ?? block.header?.number
            if (typeof blockNumber === 'number') {
              lastReturnedBlock = blockNumber
            }
            await onRecord(record)
          },
        },
      )

      if (processedBlocks === 0) {
        break
      }

      chunksFetched++

      if (lastReturnedBlock !== undefined && lastReturnedBlock >= currentFrom && lastReturnedBlock < chunkTo) {
        currentFrom = lastReturnedBlock + 1
        continue
      }

      currentFrom = chunkTo + 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      if (message.includes('Response too large') && chunkSize > MIN_SOLANA_CHUNK_SIZE) {
        chunkSize = Math.max(MIN_SOLANA_CHUNK_SIZE, Math.floor(chunkSize / 2))
        chunkSizeReduced = true
        continue
      }

      throw new Error(`Failed to fetch Solana time-series chunk: ${message}`)
    }
  }

  return { chunksFetched, chunkSizeReduced }
}
