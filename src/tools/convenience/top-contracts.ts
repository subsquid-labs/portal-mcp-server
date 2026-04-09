import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'

import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Get Top Contracts
// ============================================================================

/**
 * Find the most active contracts on a chain by transaction volume.
 * Perfect for "which contracts are trending?" questions.
 */
export function registerGetTopContractsTool(server: McpServer) {
  server.tool(
    'portal_get_top_contracts',
    `Find the most active contracts on a chain by transaction count. Returns ranked list with transaction volumes.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      num_blocks: z
        .number()
        .max(10000)
        .optional()
        .default(50)
        .describe('Number of recent blocks to analyze (default: 1000, max: 10000 for performance)'),
      limit: z
        .number()
        .max(100)
        .optional()
        .default(10)
        .describe('Number of top contracts to return (default: 10, max: 100)'),
      include_details: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include sample transaction hashes for each contract'),
    },
    async ({ dataset, num_blocks, limit, include_details }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_top_contracts',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_get_transaction_density for a quick non-EVM activity overview.',
            'Use portal_get_recent_transactions for wallet-style previews on Solana or Bitcoin.',
          ],
        })
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
            to: true,
            hash: true,
          },
        },
        transactions: [{}], // Get all transactions
      }

      // Count transactions per contract
      const contractCounts: Map<string, { count: number; samples: string[] }> = new Map()
      let totalTxs = 0
      await portalFetchStreamRangeVisit(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        onRecord: (record) => {
          const transactions = (record as {
            transactions?: Array<{ to?: string; hash?: string }>
          }).transactions || []

          transactions.forEach((tx) => {
            if (!tx.to) {
              return
            }

            const address = tx.to.toLowerCase()
            totalTxs++

            if (!contractCounts.has(address)) {
              contractCounts.set(address, { count: 0, samples: [] })
            }

            const entry = contractCounts.get(address)!
            entry.count++

            if (include_details && tx.hash && entry.samples.length < 5) {
              entry.samples.push(tx.hash)
            }
          })
        },
      })

      // Convert to array and sort by transaction count
      const sortedContracts = Array.from(contractCounts.entries())
        .map(([address, data]) => {
          return {
            address,
            transaction_count: data.count,
            percentage: ((data.count / totalTxs) * 100).toFixed(2),
            sample_transactions: include_details ? data.samples : undefined,
          }
        })
        .sort((a, b) => b.transaction_count - a.transaction_count)
        .slice(0, limit)

      // Add rank
      sortedContracts.forEach((contract, index) => {
        ;(contract as any).rank = index + 1
      })

      const summary = {
        total_transactions: totalTxs,
        unique_contracts: contractCounts.size,
        blocks_analyzed: latestBlock - fromBlock + 1,
        from_block: fromBlock,
        to_block: latestBlock,
        top_contract: sortedContracts[0]?.address,
        top_contract_txs: sortedContracts[0]?.transaction_count,
      }

      return formatResult(
        {
          summary,
          top_contracts: sortedContracts,
        },
        `Analyzed ${totalTxs.toLocaleString()} transactions across ${latestBlock - fromBlock + 1} blocks. Top contract: ${sortedContracts[0]?.address} (${sortedContracts[0]?.transaction_count} txs, ${sortedContracts[0]?.percentage}%)`,
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
