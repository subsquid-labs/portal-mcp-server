import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Get Transaction Density
// ============================================================================

/**
 * Get transaction density (tx count per block) for analysis and charts.
 * Much faster than fetching full transaction data.
 */
export function registerGetTransactionDensityTool(server: McpServer) {
  server.tool(
    'portal_get_transaction_density',
    `Get transaction density (tx count per block) for creating charts and analysis. FAST: Only fetches minimal transaction data.

WHEN TO USE:
- "Compare transaction activity across chains"
- "Create a density chart of txs per block"
- "Show network activity over last N blocks"
- "Which chain has more transactions?"

PERFECT FOR: Charts, comparisons, network health monitoring.

EXAMPLES:
- Last 50 blocks: { dataset: "polygon", num_blocks: 50 }
- Compare chains: Run for each chain with same num_blocks
- Activity chart: { dataset: "ethereum", num_blocks: 100 }

FAST: Returns block numbers + tx counts only. No full transaction data.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'polygon', 'base', 'ethereum', etc.)"),
      num_blocks: z
        .number()
        .max(1000)
        .default(50)
        .describe('Number of recent blocks to analyze (default: 50, max: 1000)'),
    },
    async ({ dataset, num_blocks }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_transaction_density is only for EVM chains')
      }

      // Get latest block
      const head = await getBlockHead(dataset)
      const latestBlock = head.number
      const fromBlock = Math.max(0, latestBlock - num_blocks + 1)

      // Query with minimal transaction data - just need to count them
      const query = {
        type: 'evm',
        fromBlock,
        toBlock: latestBlock,
        fields: {
          block: { number: true, timestamp: true },
          transaction: { transactionIndex: true }, // Minimal field
        },
        transactions: [{}], // Get all transactions
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      // Calculate tx density per block
      const densityData = results.map((block: any) => ({
        block_number: block.number,
        timestamp: block.timestamp,
        transaction_count: block.transactions?.length || 0,
      }))

      const totalTxs = densityData.reduce((sum, b) => sum + b.transaction_count, 0)
      const avgTxsPerBlock = densityData.length > 0 ? (totalTxs / densityData.length).toFixed(2) : 0

      return formatResult(
        densityData,
        `Analyzed ${densityData.length} blocks: ${totalTxs} total transactions, ${avgTxsPerBlock} avg txs/block`,
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
