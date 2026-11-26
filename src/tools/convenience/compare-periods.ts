import { getBlockHead, resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { createQueryCache, stableCacheKey } from '../../cache/query-cache.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatDuration, formatTimestamp } from '../../helpers/format.js'
import { buildBucketCoverage, buildBucketGapDiagnostics, buildQueryFreshness } from '../../helpers/result-metadata.js'
import {
  getTimestampWindowNotices,
  parseTimeframeToSeconds,
  resolveTimeframeOrBlocks,
} from '../../helpers/timeframe.js'
import { normalizeTronAddress } from '../../helpers/tron.js'
import { computeSolanaTimeSeries } from '../solana/time-series-shared.js'
import { toTronInputError } from '../tron/shared.js'
import { assertSeriesWindowScannable } from './time-series-bounds.js'

type CompareMetric = 'transaction_count' | 'avg_gas_price' | 'gas_used' | 'block_utilization' | 'unique_addresses'

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
    parameter?: {
      value?: {
        owner_address?: unknown
        to_address?: unknown
        contract_address?: unknown
        receiver_address?: unknown
      }
    }
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
  const raw = block.timestamp ?? block.header?.timestamp
  if (raw === undefined) return undefined
  return raw > 1e12 ? Math.floor(raw / 1000) : raw
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
  duration: string
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
    if (chainType !== 'solana') {
      assertSeriesWindowScannable({ dataset, chainType, fromBlock, toBlock, duration })
    }

    const intervalSeconds = parseTimeframeToSeconds(interval)
    const durationSeconds = parseTimeframeToSeconds(duration)
    const expectedBuckets = Math.max(1, Math.ceil(durationSeconds / intervalSeconds))
    const seriesStartTimestamp = fromTimestamp

    if (chainType === 'solana') {
      const solanaResult = await computeSolanaTimeSeries({
        dataset,
        metric: metric === 'unique_addresses' ? 'unique_wallets' : 'transaction_count',
        interval,
        duration,
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
      const windowComplete = filledBuckets === solanaResult.expected_buckets

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

    const queryType = chainType === 'bitcoin' ? 'bitcoin' : chainType === 'tron' ? 'tron' : 'evm'
    const baseFields: any = {
      block: { number: true, timestamp: true },
    }
    const queryExtras: any = {}

    if (metric === 'transaction_count' || metric === 'unique_addresses') {
      baseFields.transaction = { transactionIndex: true }
      if (metric === 'unique_addresses') {
        if (chainType === 'tron') {
          baseFields.transaction.parameter = true
        } else {
          baseFields.transaction.from = true
          baseFields.transaction.to = true
        }
      }
      if (address && chainType === 'evm') {
        queryExtras.transactions = [{ to: [address.toLowerCase()] }]
      } else if (address && chainType === 'tron') {
        let hex41: string
        try {
          hex41 = normalizeTronAddress(address, 'transaction')
        } catch (error) {
          throw toTronInputError(error)
        }
        queryExtras.transferTransactions = [{ owner: [hex41] }, { to: [hex41] }]
        queryExtras.transferAssetTransactions = [{ owner: [hex41] }, { to: [hex41] }]
        queryExtras.triggerSmartContractTransactions = [{ owner: [hex41] }, { contract: [hex41] }]
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
    const initialChunkSize =
      chainType === 'tron' && hasTxData ? (metric === 'unique_addresses' ? 200 : 1000) : hasTxData ? 5000 : 10000
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
        let chunk: TimeSeriesBlock[]
        try {
          chunk = (await portalFetchStream(
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
          )) as TimeSeriesBlock[]
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const shouldReduceChunkSize =
            hasTxData &&
            chunkSize > 50 &&
            (message.includes('Response too large') ||
              message.toLowerCase().includes('timed out') ||
              message.toLowerCase().includes('timeout'))
          if (shouldReduceChunkSize) {
            chunkSize = Math.max(50, Math.floor(chunkSize / 2))
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
          const tronValue = tx.parameter?.value
          if (typeof tronValue?.owner_address === 'string') bucket.addresses.add(tronValue.owner_address.toLowerCase())
          if (typeof tronValue?.to_address === 'string') bucket.addresses.add(tronValue.to_address.toLowerCase())
          if (typeof tronValue?.contract_address === 'string') {
            bucket.addresses.add(tronValue.contract_address.toLowerCase())
          }
          if (typeof tronValue?.receiver_address === 'string') {
            bucket.addresses.add(tronValue.receiver_address.toLowerCase())
          }
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
    const windowComplete = filledBuckets === expectedBuckets

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
