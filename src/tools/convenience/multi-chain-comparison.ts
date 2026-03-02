import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Compare Chains
// ============================================================================

/**
 * Compare metrics across multiple chains in a single call.
 * Perfect for "which chain should I use?" decisions.
 */
export function registerCompareChainsTool(server: McpServer) {
  server.tool(
    'portal_compare_chains',
    `Compare metrics across multiple chains in ONE call. Perfect for decision-making.

WHEN TO USE:
- "Which chain has more activity: Polygon or Base?"
- "Compare gas prices across Ethereum, Arbitrum, and Optimism"
- "Which L2 is fastest right now?"
- "Transaction density comparison across 5 chains"
- "Where should I deploy my dApp?"

ONE CALL = ALL COMPARISONS: No need to call multiple tools manually.

EXAMPLES:
- Activity comparison: { chains: ["ethereum", "polygon", "base"], metric: "transaction_density" }
- Gas comparison: { chains: ["ethereum", "arbitrum", "optimism"], metric: "gas_prices" }
- Custom metric: { chains: ["base", "polygon"], metric: "active_addresses", num_blocks: 100 }

FAST: Runs queries in parallel, returns ranked results.`,
    {
      chains: z
        .array(z.string())
        .min(2)
        .max(10)
        .describe("Chain names to compare (2-10 chains). Supports short names like 'polygon', 'base', 'ethereum'"),
      metric: z
        .enum(['transaction_density', 'gas_prices', 'active_addresses'])
        .describe('Metric to compare across chains'),
      num_blocks: z
        .number()
        .max(1000)
        .optional()
        .default(50)
        .describe('Number of recent blocks to analyze (default: 50, used for transaction_density)'),
      timeframe: z
        .enum(['1h', '6h', '24h', '7d'])
        .optional()
        .default('24h')
        .describe('Timeframe for gas_prices analysis (default: 24h)'),
    },
    async ({ chains, metric, num_blocks, timeframe }) => {
      const queryStartTime = Date.now()

      // Resolve all chain names
      const resolvedChains = await Promise.all(
        chains.map(async (chain) => {
          try {
            const resolved = await resolveDataset(chain)
            return { original: chain, resolved, valid: true }
          } catch (e) {
            return { original: chain, resolved: null, valid: false, error: (e as Error).message }
          }
        }),
      )

      const validChains = resolvedChains.filter((c) => c.valid)
      const invalidChains = resolvedChains.filter((c) => !c.valid)

      if (validChains.length === 0) {
        throw new Error(
          `No valid chains found. Errors: ${invalidChains.map((c) => `${c.original}: ${c.error}`).join(', ')}`,
        )
      }

      // Run metric queries in parallel
      const results: Record<string, any> = {}

      if (metric === 'transaction_density') {
        // Get transaction density for each chain
        const densityPromises = validChains.map(async (chainInfo) => {
          try {
            const dataset = chainInfo.resolved!
            const chainType = detectChainType(dataset)

            if (chainType !== 'evm') {
              return { chain: chainInfo.original, error: 'Not an EVM chain', value: null }
            }

            const head = await getBlockHead(dataset)
            const latestBlock = head.number
            const fromBlock = Math.max(0, latestBlock - num_blocks + 1)

            const query = {
              type: 'evm',
              fromBlock,
              toBlock: latestBlock,
              fields: {
                block: { number: true },
                transaction: { transactionIndex: true },
              },
              transactions: [{}],
            }

            const blocks = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

            const totalTxs = blocks.reduce((sum: number, block: any) => sum + (block.transactions?.length || 0), 0)
            const avgTxsPerBlock = blocks.length > 0 ? totalTxs / blocks.length : 0

            return {
              chain: chainInfo.original,
              resolved_name: dataset,
              value: parseFloat(avgTxsPerBlock.toFixed(2)),
              total_transactions: totalTxs,
              blocks_analyzed: blocks.length,
              unit: 'txs/block',
            }
          } catch (error) {
            return {
              chain: chainInfo.original,
              error: (error as Error).message,
              value: null,
            }
          }
        })

        const densityResults = await Promise.all(densityPromises)

        densityResults.forEach((result) => {
          results[result.chain] = result
        })
      } else if (metric === 'gas_prices') {
        // Get gas analytics for each chain
        const gasPromises = validChains.map(async (chainInfo) => {
          try {
            const dataset = chainInfo.resolved!
            const chainType = detectChainType(dataset)

            if (chainType !== 'evm') {
              return { chain: chainInfo.original, error: 'Not an EVM chain', value: null }
            }

            const head = await getBlockHead(dataset)
            const latestBlock = head.number

            let blockRange: number
            switch (timeframe) {
              case '1h':
                blockRange = 300
                break
              case '6h':
                blockRange = 1800
                break
              case '24h':
                blockRange = 7200
                break
              case '7d':
                blockRange = 50400
                break
            }

            const fromBlock = Math.max(0, latestBlock - blockRange + 1)

            const query = {
              type: 'evm',
              fromBlock,
              toBlock: latestBlock,
              fields: {
                block: { baseFeePerGas: true },
              },
              transactions: [],
            }

            const blocks = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

            const baseFees = blocks
              .map((b: any) => (b.baseFeePerGas ? parseInt(b.baseFeePerGas) : null))
              .filter((f: number | null) => f !== null) as number[]

            if (baseFees.length === 0) {
              return { chain: chainInfo.original, error: 'No gas data available', value: null }
            }

            const avg = baseFees.reduce((sum, v) => sum + v, 0) / baseFees.length
            const current = baseFees[baseFees.length - 1]
            const toGwei = (wei: number) => (wei / 1e9).toFixed(2)

            return {
              chain: chainInfo.original,
              resolved_name: dataset,
              value: parseFloat(toGwei(current)),
              avg_gwei: parseFloat(toGwei(avg)),
              min_gwei: parseFloat(toGwei(Math.min(...baseFees))),
              max_gwei: parseFloat(toGwei(Math.max(...baseFees))),
              unit: 'Gwei',
            }
          } catch (error) {
            return {
              chain: chainInfo.original,
              error: (error as Error).message,
              value: null,
            }
          }
        })

        const gasResults = await Promise.all(gasPromises)

        gasResults.forEach((result) => {
          results[result.chain] = result
        })
      } else if (metric === 'active_addresses') {
        // Get active addresses (unique from/to addresses in recent blocks)
        const addressPromises = validChains.map(async (chainInfo) => {
          try {
            const dataset = chainInfo.resolved!
            const chainType = detectChainType(dataset)

            if (chainType !== 'evm') {
              return { chain: chainInfo.original, error: 'Not an EVM chain', value: null }
            }

            const head = await getBlockHead(dataset)
            const latestBlock = head.number
            const fromBlock = Math.max(0, latestBlock - num_blocks + 1)

            const query = {
              type: 'evm',
              fromBlock,
              toBlock: latestBlock,
              fields: {
                block: { number: true },
                transaction: { from: true, to: true },
              },
              transactions: [{}],
            }

            const blocks = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

            const uniqueAddresses = new Set<string>()
            blocks.forEach((block: any) => {
              block.transactions?.forEach((tx: any) => {
                if (tx.from) uniqueAddresses.add(tx.from.toLowerCase())
                if (tx.to) uniqueAddresses.add(tx.to.toLowerCase())
              })
            })

            return {
              chain: chainInfo.original,
              resolved_name: dataset,
              value: uniqueAddresses.size,
              blocks_analyzed: blocks.length,
              unit: 'unique addresses',
            }
          } catch (error) {
            return {
              chain: chainInfo.original,
              error: (error as Error).message,
              value: null,
            }
          }
        })

        const addressResults = await Promise.all(addressPromises)

        addressResults.forEach((result) => {
          results[result.chain] = result
        })
      }

      // Rank results
      const successfulResults = Object.values(results).filter((r: any) => r.value !== null)
      const failedResults = Object.values(results).filter((r: any) => r.value === null)

      successfulResults.sort((a: any, b: any) => b.value - a.value)

      // Add rankings
      successfulResults.forEach((result: any, index: number) => {
        result.rank = index + 1
      })

      const summary = {
        metric,
        compared_chains: chains.length,
        successful: successfulResults.length,
        failed: failedResults.length,
        winner: successfulResults[0]?.chain,
        rankings: successfulResults.map((r: any) => ({
          rank: r.rank,
          chain: r.chain,
          value: r.value,
          unit: r.unit,
        })),
      }

      return formatResult(
        { summary, details: results },
        `Compared ${chains.length} chains on ${metric}. Winner: ${summary.winner} (${successfulResults[0]?.value} ${successfulResults[0]?.unit})`,
        {
          metadata: {
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
