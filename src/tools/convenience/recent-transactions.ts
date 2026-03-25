import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { TRANSACTION_FIELD_PRESETS } from '../../helpers/field-presets.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTransactionFields } from '../../helpers/formatting.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { getQueryExamples, normalizeAddresses, validateQuerySize } from '../../helpers/validation.js'

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
      limit: z.number().max(200).optional().default(10).describe('Max transactions to return (max: 200)'),
    },
    async ({ dataset, timeframe, from_addresses, to_addresses, limit }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_recent_transactions is only for EVM chains')
      }

      // Resolve block range — numeric values are exact block counts,
      // time-based values (1h, 6h, etc.) use Portal's /timestamps/ API
      let fromBlock: number
      let toBlock: number
      const isBlockCount = /^\d+$/.test(timeframe)

      if (isBlockCount) {
        const head = await getBlockHead(dataset)
        const blockRange = parseInt(timeframe)
        toBlock = head.number
        fromBlock = Math.max(0, toBlock - blockRange)
      } else {
        const resolved = await resolveTimeframeOrBlocks({ dataset, timeframe })
        fromBlock = resolved.from_block
        toBlock = resolved.to_block
      }

      const blockRange = toBlock - fromBlock

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

      // Use standard preset (no 'input' field) to prevent response size explosions.
      // The 'input' field contains arbitrary-length hex data that dominates response size.
      const fields = {
        block: { number: true, timestamp: true, hash: true },
        transaction: { ...TRANSACTION_FIELD_PRESETS.standard.transaction, gasUsed: true, status: true, sighash: true },
      }

      const query: Record<string, unknown> = {
        type: 'evm',
        fromBlock,
        toBlock,
        fields,
        // ALWAYS include transactions field - empty array means "return all transactions"
        transactions: txFilters.length > 0 ? txFilters : [{}],
      }

      // Use maxBlocks to stop streaming early — on dense chains like Base,
      // even 100 blocks can have 16K+ txs, so we only need enough blocks to fill the limit
      const maxBlocksNeeded = Math.min(blockRange, Math.max(limit * 2, 100))
      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
        undefined,
        hasFilters ? 0 : maxBlocksNeeded,
      )

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
