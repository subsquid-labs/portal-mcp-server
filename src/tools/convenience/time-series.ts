import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError, createUnsupportedMetricError } from '../../helpers/errors.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatDuration, formatTimestamp } from '../../helpers/formatting.js'
import { parseTimeframeToSeconds, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { computeSolanaTimeSeries } from '../solana/time-series-shared.js'

// ============================================================================
// Tool: Get Time Series Data
// ============================================================================

/**
 * Aggregate blockchain metrics over time intervals.
 * Perfect for "show me activity trends over the past week" questions.
 */

type TimeSeriesMetric =
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

export function registerGetTimeSeriesDataTool(server: McpServer) {
  server.tool(
    'portal_get_time_series',
    `Aggregate blockchain metrics (tx count, gas price, utilization, unique addresses) over time intervals. Returns bucketed data for charting.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      metric: z
        .enum(['transaction_count', 'avg_gas_price', 'gas_used', 'block_utilization', 'unique_addresses'])
        .describe('Metric to aggregate over time'),
      interval: z.enum(['5m', '15m', '1h', '6h', '1d']).describe('Time bucket interval (5m, 15m, 1h, 6h, 1d)'),
      duration: z.enum(['1h', '6h', '24h', '7d', '30d']).describe('Total time period to analyze'),
      address: z
        .string()
        .optional()
        .describe('Optional: Filter to specific contract address for contract-specific trends'),
      mode: z
        .enum(['fast', 'deep'])
        .optional()
        .default('deep')
        .describe('fast = skip extra backfill scans, deep = fill the requested window more aggressively'),
    },
    async ({ dataset, metric, interval, duration, address, mode }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)
      const isHyperliquid = chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds'
      const notices: string[] = []

      if (isHyperliquid) {
        throw createUnsupportedChainError({
          toolName: 'portal_get_time_series',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin'],
          suggestions: [
            'Use portal_query_hyperliquid_fills for raw Hyperliquid activity.',
            'Use portal_hyperliquid_time_series for fills-based charts.',
          ],
        })
      }

      // Gas-related metrics are EVM-only
      const gasMetrics = ['avg_gas_price', 'gas_used', 'block_utilization']
      if (gasMetrics.includes(metric) && chainType !== 'evm') {
        throw createUnsupportedMetricError({
          toolName: 'portal_get_time_series',
          metric,
          dataset,
          supportedMetrics: ['transaction_count', 'unique_addresses'],
          reason: 'Gas metrics are available only on EVM datasets.',
        })
      }

      // unique_addresses requires from/to fields — not available on Bitcoin
      if (metric === 'unique_addresses' && chainType === 'bitcoin') {
        throw createUnsupportedMetricError({
          toolName: 'portal_get_time_series',
          metric,
          dataset,
          supportedMetrics: ['transaction_count'],
          reason: 'Bitcoin uses a UTXO model, so there is no simple from/to address set for this metric.',
        })
      }

      if (chainType === 'solana' && (metric === 'transaction_count' || metric === 'unique_addresses')) {
        const solanaResult = await computeSolanaTimeSeries({
          dataset,
          metric: metric === 'unique_addresses' ? 'unique_wallets' : 'transaction_count',
          interval,
          duration: duration as '1h' | '6h' | '24h' | '7d',
          trimIncompleteLastBucket: false,
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

        return formatResult(
          {
            summary,
            time_series: solanaResult.time_series.map((point) => ({
              bucket_index: point.bucket_index,
              timestamp: point.timestamp,
              timestamp_human: point.timestamp_human,
              blocks_in_bucket: point.slots_in_bucket,
              value: point.value,
            })),
          },
          `Aggregated ${metric} over ${duration} in ${interval} intervals. ${solanaResult.time_series.length} data points (${filledBuckets} with data). Avg: ${solanaResult.statistics.avg.toFixed(2)}, Min: ${solanaResult.statistics.min.toFixed(2)}, Max: ${solanaResult.statistics.max.toFixed(2)}`,
          {
            metadata: {
              dataset,
              from_block: solanaResult.from_block,
              to_block: solanaResult.to_block,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      // Get block range using Portal's /timestamps/ API
      const { from_block: fromBlock, to_block: toBlock } = await resolveTimeframeOrBlocks({ dataset, timeframe: duration })

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

      if (metric === 'transaction_count' || metric === 'unique_addresses') {
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
      const hasTxData = metric === 'transaction_count' || metric === 'unique_addresses'
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
              undefined,
              0,
              chainType === 'solana' && hasTxData ? SOLANA_GENERIC_MAX_BYTES : 100 * 1024 * 1024,
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

        if (metric === 'transaction_count') {
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

      return formatResult(
        {
          summary,
          time_series: timeSeries,
        },
        resultMessage,
        {
          notices,
          metadata: {
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
