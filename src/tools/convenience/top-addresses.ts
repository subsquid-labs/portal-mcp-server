import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Get Top Addresses
// ============================================================================

/**
 * Find the most active wallet addresses by transaction volume.
 * Perfect for "who's transacting the most?" questions.
 */
export function registerGetTopAddressesTool(server: McpServer) {
  server.tool(
    'portal_get_top_addresses',
    `Find the most active wallet addresses by transaction volume. Perfect for whale watching and trend analysis.

WHEN TO USE:
- "Which wallets are most active on this chain?"
- "Show me the top traders on Base"
- "Who's sending the most transactions?"
- "Find whale addresses on Ethereum"
- "Which addresses have the highest activity?"

ONE CALL SOLUTION: Analyzes all transactions and ranks addresses by usage.

EXAMPLES:
- Top 20 addresses: { dataset: "base", num_blocks: 1000, limit: 20 }
- Activity analysis: { dataset: "ethereum", num_blocks: 5000, include_details: true }
- Recent whales: { dataset: "polygon", num_blocks: 2000, limit: 50 }

FAST: Returns ranked list with transaction counts, percentages, and optional details.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      num_blocks: z
        .number()
        .max(10000)
        .optional()
        .default(1000)
        .describe('Number of recent blocks to analyze (default: 1000, max: 10000 for performance)'),
      limit: z
        .number()
        .max(100)
        .optional()
        .default(10)
        .describe('Number of top addresses to return (default: 10, max: 100)'),
      include_details: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include sample transaction hashes for each address'),
    },
    async ({ dataset, num_blocks, limit, include_details }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_top_addresses is only for EVM chains')
      }

      // Get latest block
      const head = await getBlockHead(dataset)
      const latestBlock = head.number
      const fromBlock = Math.max(0, latestBlock - num_blocks + 1)

      // Query transactions
      const query = {
        type: 'evm',
        fromBlock,
        toBlock: latestBlock,
        fields: {
          block: { number: true },
          transaction: {
            from: true,
            hash: true,
          },
        },
        transactions: [{}], // Get all transactions
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      // Count transactions per address
      const addressCounts: Map<string, { count: number; samples: string[] }> = new Map()
      let totalTxs = 0

      results.forEach((block: any) => {
        block.transactions?.forEach((tx: any) => {
          if (tx.from) {
            const address = tx.from.toLowerCase()
            totalTxs++

            if (!addressCounts.has(address)) {
              addressCounts.set(address, { count: 0, samples: [] })
            }

            const entry = addressCounts.get(address)!
            entry.count++

            // Store sample transaction hashes (up to 5)
            if (include_details && entry.samples.length < 5) {
              entry.samples.push(tx.hash)
            }
          }
        })
      })

      // Convert to array and sort by transaction count
      const sortedAddresses = Array.from(addressCounts.entries())
        .map(([address, data]) => ({
          address,
          transaction_count: data.count,
          percentage: ((data.count / totalTxs) * 100).toFixed(2),
          sample_transactions: include_details ? data.samples : undefined,
        }))
        .sort((a, b) => b.transaction_count - a.transaction_count)
        .slice(0, limit)

      // Add rank
      sortedAddresses.forEach((addr, index) => {
        ;(addr as any).rank = index + 1
      })

      const summary = {
        total_transactions: totalTxs,
        unique_addresses: addressCounts.size,
        blocks_analyzed: results.length,
        from_block: fromBlock,
        to_block: latestBlock,
        top_address: sortedAddresses[0]?.address,
        top_address_txs: sortedAddresses[0]?.transaction_count,
      }

      return formatResult(
        {
          summary,
          top_addresses: sortedAddresses,
        },
        `Analyzed ${totalTxs.toLocaleString()} transactions across ${results.length} blocks. Top address: ${sortedAddresses[0]?.address} (${sortedAddresses[0]?.transaction_count} txs, ${sortedAddresses[0]?.percentage}%)`,
        {
          metadata: {
            dataset,
            from_block: fromBlock,
            to_block: latestBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
