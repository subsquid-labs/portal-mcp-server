import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, weiToGwei } from '../../helpers/formatting.js'
import { getBlockRangeForDuration, getDurationSeconds } from '../../helpers/timestamp-to-block.js'

// ============================================================================
// Tool: Get Time Series Data
// ============================================================================

/**
 * Aggregate blockchain metrics over time intervals.
 * Perfect for "show me activity trends over the past week" questions.
 */
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
    },
    async ({ dataset, metric, interval, duration, address }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_time_series is only for EVM chains')
      }

      // Get block range using Portal's timestamp-to-block API (no guessing needed!)
      const { fromBlock, toBlock } = await getBlockRangeForDuration(dataset, duration)

      // Calculate bucket size based on interval duration
      const intervalSeconds = getDurationSeconds(interval)
      const durationSeconds = getDurationSeconds(duration)
      const numBuckets = Math.ceil(durationSeconds / intervalSeconds)
      const bucketSize = Math.ceil((toBlock - fromBlock + 1) / numBuckets)

      // Build base query fields based on metric
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
        queryExtras.transactions = address ? [{ to: [address.toLowerCase()] }] : [{}]
      } else if (metric === 'avg_gas_price') {
        baseFields.block.baseFeePerGas = true
      } else if (metric === 'gas_used' || metric === 'block_utilization') {
        baseFields.block.gasUsed = true
        baseFields.block.gasLimit = true
      }

      // Chunk large ranges to avoid Portal API size limits
      const totalBlocks = toBlock - fromBlock
      const hasTxData = metric === 'transaction_count' || metric === 'unique_addresses'
      const chunkSize = hasTxData ? 5000 : 10000
      const results: any[] = []

      if (totalBlocks <= chunkSize) {
        // Single query
        const query = {
          type: 'evm',
          fromBlock,
          toBlock,
          includeAllBlocks: true,
          fields: baseFields,
          ...queryExtras,
        }
        results.push(...await portalFetchStream(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          query,
          undefined,
          0,
          100 * 1024 * 1024,
        ))
      } else {
        // Chunked queries
        for (let start = fromBlock; start < toBlock; start += chunkSize) {
          const end = Math.min(start + chunkSize, toBlock)
          const query = {
            type: 'evm',
            fromBlock: start,
            toBlock: end,
            includeAllBlocks: true,
            fields: baseFields,
            ...queryExtras,
          }
          const chunk = await portalFetchStream(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            query,
            undefined,
            0,
            100 * 1024 * 1024,
          )
          results.push(...chunk)
        }
      }

      if (results.length === 0) {
        throw new Error('No data available for this time period')
      }

      // Get the start and end timestamps from actual blocks
      const firstBlock = results[0] as any
      const lastBlock = results[results.length - 1] as any
      const startTimestamp = firstBlock.timestamp || firstBlock.header?.timestamp
      const endTimestamp = lastBlock.timestamp || lastBlock.header?.timestamp

      if (!startTimestamp || !endTimestamp) {
        throw new Error('Could not extract timestamps from block data')
      }

      // Calculate expected number of buckets based on time intervals
      const expectedBuckets = Math.ceil(durationSeconds / intervalSeconds)

      // Group blocks into timestamp-based buckets
      const buckets: Map<number, any[]> = new Map()

      results.forEach((block: any) => {
        const blockNumber = block.number || block.header?.number
        const timestamp = block.timestamp || block.header?.timestamp

        if (!blockNumber || !timestamp) {
          return // Skip blocks without required data
        }

        // Calculate which bucket this block belongs to based on timestamp
        const elapsedSeconds = timestamp - startTimestamp
        const bucketIndex = Math.floor(elapsedSeconds / intervalSeconds)

        // Skip blocks beyond expected range (shouldn't happen but be safe)
        if (bucketIndex >= expectedBuckets) {
          return
        }

        if (!buckets.has(bucketIndex)) {
          buckets.set(bucketIndex, [])
        }
        buckets.get(bucketIndex)!.push(block)
      })

      // Calculate aggregates for each bucket
      let timeSeries = Array.from(buckets.entries())
        .map(([bucketIndex, blocks]) => {
          const firstBlock = blocks[0]
          const lastBlock = blocks[blocks.length - 1]
          const firstBlockNumber = firstBlock.number || firstBlock.header?.number
          const lastBlockNumber = lastBlock.number || lastBlock.header?.number
          const timestamp = firstBlock.timestamp || firstBlock.header?.timestamp

          // Calculate bucket timestamp (start of interval)
          const bucketTimestamp = startTimestamp + bucketIndex * intervalSeconds

          let value: number

          if (metric === 'transaction_count') {
            value = blocks.reduce((sum, b) => sum + (b.transactions?.length || 0), 0)
          } else if (metric === 'avg_gas_price') {
            const gasPrices = blocks
              .map((b) => (b.baseFeePerGas ? parseInt(b.baseFeePerGas) : null))
              .filter((g) => g !== null) as number[]
            value = gasPrices.length > 0 ? gasPrices.reduce((sum, g) => sum + g, 0) / gasPrices.length / 1e9 : 0 // Convert to Gwei
          } else if (metric === 'gas_used') {
            value = blocks.reduce((sum, b) => sum + parseInt(b.gasUsed || '0'), 0)
          } else if (metric === 'block_utilization') {
            const utilizations = blocks.map((b) =>
              b.gasLimit ? (parseInt(b.gasUsed || '0') / parseInt(b.gasLimit)) * 100 : 0,
            )
            value = utilizations.reduce((sum, u) => sum + u, 0) / utilizations.length
          } else if (metric === 'unique_addresses') {
            const addresses = new Set<string>()
            blocks.forEach((block) => {
              block.transactions?.forEach((tx: any) => {
                if (tx.from) addresses.add(tx.from.toLowerCase())
                if (tx.to) addresses.add(tx.to.toLowerCase())
              })
            })
            value = addresses.size
          } else {
            value = 0
          }

          return {
            bucket_index: bucketIndex,
            timestamp: bucketTimestamp,
            timestamp_human: formatTimestamp(bucketTimestamp),
            block_range: `${firstBlockNumber}-${lastBlockNumber}`,
            blocks_in_bucket: blocks.length,
            value: parseFloat(value.toFixed(2)),
          }
        })
        .sort((a, b) => a.bucket_index - b.bucket_index)

      // Check if the last bucket is incomplete (has significantly fewer blocks than median)
      if (timeSeries.length > 2) {
        const blockCounts = timeSeries.slice(0, -1).map((t) => t.blocks_in_bucket)
        const medianBlockCount = blockCounts.sort((a, b) => a - b)[Math.floor(blockCounts.length / 2)]
        const lastBucket = timeSeries[timeSeries.length - 1]

        // If last bucket has less than 50% of median block count, exclude it
        if (lastBucket.blocks_in_bucket < medianBlockCount * 0.5) {
          timeSeries = timeSeries.slice(0, -1)
        }
      }

      // Calculate summary statistics
      const values = timeSeries.map((t) => t.value)
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length
      const min = Math.min(...values)
      const max = Math.max(...values)

      // Check if we got significantly less data than expected (expectedBuckets already calculated above)
      const dataCompleteness = (timeSeries.length / expectedBuckets) * 100
      const hasPartialData = dataCompleteness < 80 // Less than 80% of expected buckets

      const summary: any = {
        metric,
        interval,
        duration,
        total_buckets: timeSeries.length,
        expected_buckets: expectedBuckets,
        total_blocks: results.length,
        from_block: fromBlock,
        to_block: toBlock,
        statistics: {
          avg: parseFloat(avg.toFixed(2)),
          min: parseFloat(min.toFixed(2)),
          max: parseFloat(max.toFixed(2)),
        },
      }

      // Add warning if data is incomplete
      if (hasPartialData) {
        summary.warning = `Partial data returned: Got ${timeSeries.length}/${expectedBuckets} expected buckets (${dataCompleteness.toFixed(0)}%). Portal API may have hit size limits. Results may be incomplete.`
      }

      if (address) {
        ;(summary as any).filtered_by_address = address
      }

      const resultMessage = hasPartialData
        ? `WARNING: Partial data! Aggregated ${metric} over ${duration} in ${interval} intervals. Got ${timeSeries.length}/${expectedBuckets} expected data points. Avg: ${avg.toFixed(2)}, Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}`
        : `Aggregated ${metric} over ${duration} in ${interval} intervals. ${timeSeries.length} data points. Avg: ${avg.toFixed(2)}, Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}`

      return formatResult(
        {
          summary,
          time_series: timeSeries,
        },
        resultMessage,
        {
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
