import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { portalFetch, portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTransactionFields } from '../../helpers/formatting.js'
import { getQueryExamples, normalizeAddresses, validateQuerySize } from '../../helpers/validation.js'
import type { BlockHead } from '../../types/index.js'

// ============================================================================
// Tool: Get Recent Transactions (Convenience Wrapper)
// ============================================================================

/**
 * Convenience wrapper that auto-calculates block ranges for recent activity.
 * Eliminates the need to:
 * 1. Query HEAD block
 * 2. Calculate block range based on time
 * 3. Handle block-per-second conversions
 */
export function registerGetRecentTransactionsTool(server: McpServer) {
  server.tool(
    'portal_get_recent_transactions',
    `Get recent transactions without manual block calculation. Automatically queries the last N blocks or timeframe. Supports address filtering.`,
    {
      dataset: z
        .string()
        .describe("Dataset name (supports short names: 'polygon', 'base', 'ethereum', 'arbitrum', etc.)"),
      timeframe: z
        .enum(['1h', '6h', '24h', '7d', '100', '500', '1000', '5000'])
        .optional()
        .default('100')
        .describe(
          "Time period or block count. Quick options: '100' (default, ~3 mins), '1h' (~1 hour), '24h' (1 day), '7d' (1 week). Use 100-500 for unfiltered queries to stay fast (<2s).",
        ),
      from_addresses: z.array(z.string()).optional().describe('Filter by sender addresses'),
      to_addresses: z.array(z.string()).optional().describe('Filter by recipient addresses'),
      limit: z
        .number()
        .max(200)
        .optional()
        .default(10)
        .describe('Max transactions to return (max: 200)'),
    },
    async ({ dataset, timeframe, from_addresses, to_addresses, limit }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_recent_transactions is only for EVM chains')
      }

      // Get latest block (cached for 30s)
      const head = await getBlockHead(dataset)
      const latestBlock = head.number

      // Calculate block range based on timeframe
      let blockRange: number
      switch (timeframe) {
        case '1h':
          blockRange = 1800 // ~1 hour (2s per block)
          break
        case '6h':
          blockRange = 10800 // ~6 hours
          break
        case '24h':
          blockRange = 43200 // ~24 hours
          break
        case '7d':
          blockRange = 302400 // ~7 days
          break
        default:
          blockRange = parseInt(timeframe) // Exact block count
      }

      const fromBlock = Math.max(0, latestBlock - blockRange)
      const toBlock = latestBlock

      const includeL2 = isL2Chain(dataset)
      const normalizedFrom = normalizeAddresses(from_addresses, chainType)
      const normalizedTo = normalizeAddresses(to_addresses, chainType)

      const txFilters: Record<string, unknown>[] = []
      if (normalizedFrom || normalizedTo) {
        if (normalizedFrom) {
          txFilters.push({ from: normalizedFrom })
        }
        if (normalizedTo) {
          txFilters.push({ to: normalizedTo })
        }
      }

      // Validate query size to prevent memory crashes
      const hasFilters = txFilters.length > 0
      const validation = validateQuerySize({
        blockRange: blockRange,
        hasFilters,
        queryType: 'transactions',
        limit,
      })

      if (!validation.valid) {
        const examples = !hasFilters ? getQueryExamples('transactions') : ''
        throw new Error(validation.error + examples)
      }

      const query: Record<string, unknown> = {
        type: 'evm',
        fromBlock,
        toBlock,
        fields: {
          block: { number: true, timestamp: true, hash: true },
          transaction: buildEvmTransactionFields(includeL2),
        },
        // ALWAYS include transactions field - empty array means "return all transactions"
        transactions: txFilters.length > 0 ? txFilters : [{}],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allTxs = results.flatMap((block: unknown) => (block as { transactions?: unknown[] }).transactions || [])
      const limitedTxs = allTxs.slice(0, limit).map((tx) => formatTransactionFields(tx as Record<string, unknown>))

      return formatResult(
        limitedTxs,
        `Retrieved ${limitedTxs.length} recent transactions${
          allTxs.length > limit ? ` (total found: ${allTxs.length})` : ''
        } from last ${timeframe}`,
        {
          maxItems: limit,
          warnOnTruncation: false,
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
