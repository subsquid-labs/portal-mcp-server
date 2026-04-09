import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStreamRange } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatNumber } from '../../helpers/formatting.js'

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
    `Get transaction density (tx count per block) for recent blocks. Returns block-level counts for charting and analysis.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'polygon', 'base', 'ethereum', etc.)"),
      num_blocks: z
        .number()
        .max(200)
        .default(50)
        .describe('Number of recent blocks to analyze (default: 50, max: 1000)'),
    },
    async ({ dataset, num_blocks }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        throw new Error(
          'portal_get_transaction_density does not support Hyperliquid. Use portal_query_hyperliquid_fills instead.',
        )
      }

      // Get latest block
      const head = await getBlockHead(dataset)
      const latestBlock = head.number
      const fromBlock = Math.max(0, latestBlock - num_blocks + 1)

      // Build chain-specific query — only need block metadata + tx count
      const blockFieldKey = 'block'
      const query = {
        type: chainType === 'solana' ? 'solana' : chainType === 'bitcoin' ? 'bitcoin' : 'evm',
        fromBlock,
        toBlock: latestBlock,
        fields: {
          [blockFieldKey]: { number: true, timestamp: true },
          transaction: { transactionIndex: true },
        },
        transactions: [{}],
      }

      const results = await portalFetchStreamRange(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      // Calculate tx density per block
      const densityData = results.map((block: any) => {
        const ts = block.header?.timestamp ?? block.timestamp
        return {
          block_number: block.header?.number ?? block.number,
          timestamp: ts,
          timestamp_human: ts ? formatTimestamp(ts) : undefined,
          transaction_count: block.transactions?.length || 0,
        }
      })

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
