import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatDuration, formatTimestamp } from '../../helpers/formatting.js'
import { parseTimeframeToSeconds, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Bitcoin Time Series
// ============================================================================

/**
 * Bitcoin-specific time series with metrics not available on EVM:
 * avg_block_size, avg_block_time, fee_per_block, output_value, unique_addresses.
 */
export function registerBitcoinTimeSeresTool(server: McpServer) {
  server.tool(
    'portal_bitcoin_time_series',
    `Bitcoin-specific time series for charting. Tracks block size, block time, fees, output value, unique addresses, and transaction count over time intervals.

WHEN TO USE:
- "Show me Bitcoin block size over the past week"
- "Chart Bitcoin fees over 24h"
- "How has taproot adoption changed over the past 30 days?"
- "Bitcoin transaction count trend"

EXAMPLES:
- Block sizes: { metric: "avg_block_size", interval: "1h", duration: "24h" }
- Fee trend: { metric: "fee_per_block", interval: "6h", duration: "7d" }
- Address activity: { metric: "unique_addresses", interval: "1d", duration: "7d" }`,
    {
      dataset: z.string().default('bitcoin-mainnet').describe('Dataset name (default: bitcoin-mainnet)'),
      metric: z
        .enum([
          'transaction_count',
          'avg_block_size',
          'avg_block_time',
          'fee_per_block',
          'output_value',
          'unique_addresses',
        ])
        .describe(
          'Metric to chart. transaction_count/avg_block_size/avg_block_time use only tx data (fast). fee_per_block/output_value/unique_addresses need input/output queries (slower).',
        ),
      interval: z.enum(['1h', '6h', '1d']).describe('Time bucket interval'),
      duration: z.enum(['6h', '24h', '7d', '30d']).describe('Total time period to analyze'),
    },
    async ({ dataset, metric, interval, duration }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'bitcoin') {
        throw new Error('portal_bitcoin_time_series is only for Bitcoin chains. Use portal_get_time_series for EVM.')
      }

      const { from_block: fromBlock, to_block: toBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe: duration,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        fromBlock,
        toBlock ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const intervalSeconds = parseTimeframeToSeconds(interval)
      const durationSeconds = parseTimeframeToSeconds(duration)
      const expectedBuckets = Math.ceil(durationSeconds / intervalSeconds)

      // Determine which queries we need
      const needsTxData = ['transaction_count', 'avg_block_size', 'avg_block_time'].includes(metric)
      const needsOutputData = ['output_value', 'unique_addresses'].includes(metric)
      const needsFeeData = metric === 'fee_per_block'

      // Query transaction data (needed for most metrics)
      const txQuery = {
        type: 'bitcoin',
        fromBlock,
        toBlock: endBlock,
        includeAllBlocks: true,
        fields: {
          block: { number: true, timestamp: true },
          transaction: { transactionIndex: true, size: true, vsize: true },
        },
        transactions: [{}],
      }

      const txResults = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        txQuery,
        undefined,
        0,
        100 * 1024 * 1024,
      )

      if (txResults.length === 0) {
        throw new Error('No data available for this time period')
      }

      // Get start timestamp for bucketing
      const firstBlock = txResults[0] as any
      const startTimestamp = firstBlock.header?.timestamp ?? firstBlock.timestamp

      // Build block-level data indexed by block number
      const blockData = new Map<
        number,
        { timestamp: number; txCount: number; totalSize: number }
      >()

      txResults.forEach((block: any) => {
        const bn = block.header?.number ?? block.number
        const ts = block.header?.timestamp ?? block.timestamp
        const txs = block.transactions || []
        blockData.set(bn, {
          timestamp: ts,
          txCount: txs.length,
          totalSize: txs.reduce((sum: number, tx: any) => sum + (tx.size || 0), 0),
        })
      })

      // Fetch output/input data if needed
      let outputsByBlock: Map<number, { addresses: Set<string>; totalValue: number }> | undefined
      let feesByBlock: Map<number, number> | undefined

      if (needsOutputData) {
        const outputQuery = {
          type: 'bitcoin',
          fromBlock,
          toBlock: endBlock,
          fields: {
            block: { number: true, timestamp: true },
            output: { value: true, scriptPubKeyAddress: true },
          },
          outputs: [{}],
        }

        const outputResults = await portalFetchStream(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          outputQuery,
          undefined,
          0,
          100 * 1024 * 1024,
        )

        outputsByBlock = new Map()
        outputResults.forEach((block: any) => {
          const bn = block.header?.number ?? block.number
          const data = outputsByBlock!.get(bn) || { addresses: new Set<string>(), totalValue: 0 }
          ;(block.outputs || []).forEach((output: any) => {
            if (output.scriptPubKeyAddress) data.addresses.add(output.scriptPubKeyAddress)
            data.totalValue += output.value || 0
          })
          outputsByBlock!.set(bn, data)
        })
      }

      if (needsFeeData) {
        // Need both inputs and outputs to compute fees = sum(non-coinbase inputs) - sum(non-coinbase outputs)
        // Coinbase (transactionIndex 0) has no real inputs and outputs include block reward
        const [inputResults, outputFeeResults] = await Promise.all([
          portalFetchStream(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            {
              type: 'bitcoin',
              fromBlock,
              toBlock: endBlock,
              fields: {
                block: { number: true, timestamp: true },
                input: { prevoutValue: true, transactionIndex: true },
              },
              inputs: [{}],
            },
            undefined,
            0,
            100 * 1024 * 1024,
          ),
          portalFetchStream(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            {
              type: 'bitcoin',
              fromBlock,
              toBlock: endBlock,
              fields: {
                block: { number: true, timestamp: true },
                output: { value: true, transactionIndex: true },
              },
              outputs: [{}],
            },
            undefined,
            0,
            100 * 1024 * 1024,
          ),
        ])

        const inputSums = new Map<number, number>()
        inputResults.forEach((block: any) => {
          const bn = block.header?.number ?? block.number
          const sum = (block.inputs || [])
            .filter((i: any) => i.transactionIndex !== 0)
            .reduce((s: number, i: any) => s + (i.prevoutValue || 0), 0)
          inputSums.set(bn, (inputSums.get(bn) || 0) + sum)
        })

        const outputSums = new Map<number, number>()
        outputFeeResults.forEach((block: any) => {
          const bn = block.header?.number ?? block.number
          const sum = (block.outputs || [])
            .filter((o: any) => o.transactionIndex !== 0)
            .reduce((s: number, o: any) => s + (o.value || 0), 0)
          outputSums.set(bn, (outputSums.get(bn) || 0) + sum)
        })

        feesByBlock = new Map()
        inputSums.forEach((inputVal, bn) => {
          const outputVal = outputSums.get(bn) || 0
          feesByBlock!.set(bn, Math.max(0, inputVal - outputVal))
        })
      }

      // Bucket blocks by time
      const buckets = new Map<number, number[]>() // bucketIndex -> blockNumbers

      blockData.forEach((data, bn) => {
        const elapsed = data.timestamp - startTimestamp
        const bucketIndex = Math.floor(elapsed / intervalSeconds)
        if (bucketIndex >= expectedBuckets || bucketIndex < 0) return
        if (!buckets.has(bucketIndex)) buckets.set(bucketIndex, [])
        buckets.get(bucketIndex)!.push(bn)
      })

      // Fill empty buckets so we always return expectedBuckets entries
      for (let i = 0; i < expectedBuckets; i++) {
        if (!buckets.has(i)) buckets.set(i, [])
      }

      // Compute metric per bucket
      let timeSeries = Array.from(buckets.entries())
        .map(([bucketIndex, blockNumbers]) => {
          const bucketTimestamp = startTimestamp + bucketIndex * intervalSeconds
          const numBlocks = blockNumbers.length

          let value: number

          switch (metric) {
            case 'transaction_count': {
              value = blockNumbers.reduce((sum, bn) => sum + (blockData.get(bn)?.txCount || 0), 0)
              break
            }
            case 'avg_block_size': {
              const totalSize = blockNumbers.reduce((sum, bn) => sum + (blockData.get(bn)?.totalSize || 0), 0)
              value = numBlocks > 0 ? totalSize / numBlocks / 1024 / 1024 : 0 // in MB
              break
            }
            case 'avg_block_time': {
              const sortedBns = blockNumbers.sort((a, b) => a - b)
              if (sortedBns.length < 2) {
                value = 600 // default ~10min
              } else {
                const times: number[] = []
                for (let i = 1; i < sortedBns.length; i++) {
                  const prev = blockData.get(sortedBns[i - 1])
                  const cur = blockData.get(sortedBns[i])
                  if (prev && cur) times.push(cur.timestamp - prev.timestamp)
                }
                value = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 600
              }
              break
            }
            case 'fee_per_block': {
              if (!feesByBlock) {
                value = 0
                break
              }
              const totalFees = blockNumbers.reduce((sum, bn) => sum + (feesByBlock!.get(bn) || 0), 0)
              value = numBlocks > 0 ? totalFees / numBlocks : 0 // already in BTC
              break
            }
            case 'output_value': {
              if (!outputsByBlock) {
                value = 0
                break
              }
              const totalValue = blockNumbers.reduce(
                (sum, bn) => sum + (outputsByBlock!.get(bn)?.totalValue || 0),
                0,
              )
              value = totalValue // already in BTC
              break
            }
            case 'unique_addresses': {
              if (!outputsByBlock) {
                value = 0
                break
              }
              const allAddresses = new Set<string>()
              blockNumbers.forEach((bn) => {
                outputsByBlock!.get(bn)?.addresses.forEach((addr) => allAddresses.add(addr))
              })
              value = allAddresses.size
              break
            }
            default:
              value = 0
          }

          return {
            bucket_index: bucketIndex,
            timestamp: bucketTimestamp,
            timestamp_human: formatTimestamp(bucketTimestamp),
            blocks_in_bucket: numBlocks,
            value: parseFloat(value.toFixed(metric === 'fee_per_block' ? 8 : 2)),
          }
        })
        .sort((a, b) => a.bucket_index - b.bucket_index)

      // Trim incomplete last bucket
      if (timeSeries.length > 2) {
        const blockCounts = timeSeries.slice(0, -1).map((t) => t.blocks_in_bucket)
        const median = blockCounts.sort((a, b) => a - b)[Math.floor(blockCounts.length / 2)]
        const last = timeSeries[timeSeries.length - 1]
        if (last.blocks_in_bucket < median * 0.3) {
          timeSeries = timeSeries.slice(0, -1)
        }
      }

      // Summary stats
      const values = timeSeries.map((t) => t.value)
      const avg = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
      const min = values.length > 0 ? Math.min(...values) : 0
      const max = values.length > 0 ? Math.max(...values) : 0

      const unitMap: Record<string, string> = {
        transaction_count: 'txs',
        avg_block_size: 'MB',
        avg_block_time: 'seconds',
        fee_per_block: 'BTC',
        output_value: 'BTC',
        unique_addresses: 'addresses',
      }
      const unit = unitMap[metric] || ''

      // Detect chain head staleness — Bitcoin blocks are stochastic (~10 min avg)
      // so the head block can be significantly behind wall-clock time
      const lastBlockTimestamp = Math.max(...Array.from(blockData.values()).map((d) => d.timestamp))
      const nowUnix = Math.floor(Date.now() / 1000)
      const headAgeSec = nowUnix - lastBlockTimestamp
      const headAgeWarning =
        headAgeSec > 1800
          ? `Chain head is ${formatDuration(headAgeSec)} behind wall-clock time (last block: ${formatTimestamp(lastBlockTimestamp)}, now: ${formatTimestamp(nowUnix)}). Bitcoin blocks are stochastic — empty buckets near the end mean no blocks were mined yet, not missing data.`
          : undefined

      const summary: any = {
        metric,
        unit,
        interval,
        duration,
        total_buckets: timeSeries.length,
        expected_buckets: expectedBuckets,
        total_blocks: blockData.size,
        from_block: fromBlock,
        to_block: endBlock,
        statistics: {
          avg: parseFloat(avg.toFixed(metric === 'fee_per_block' ? 8 : 2)),
          min: parseFloat(min.toFixed(metric === 'fee_per_block' ? 8 : 2)),
          max: parseFloat(max.toFixed(metric === 'fee_per_block' ? 8 : 2)),
        },
      }

      if (headAgeWarning) {
        summary.warning = headAgeWarning
      }

      return formatResult(
        { summary, time_series: timeSeries },
        `Bitcoin ${metric} over ${duration} in ${interval} intervals. ${timeSeries.length} data points. Avg: ${avg.toFixed(2)} ${unit}, Min: ${min.toFixed(2)} ${unit}, Max: ${max.toFixed(2)} ${unit}`,
        {
          metadata: {
            dataset,
            from_block: fromBlock,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
