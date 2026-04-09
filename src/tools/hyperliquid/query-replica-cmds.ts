import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Query Hyperliquid Replica Commands
// ============================================================================

export function registerQueryHyperliquidReplicaCmdsTool(server: McpServer) {
  server.tool(
    'portal_query_hyperliquid_replica_cmds',
    'Query Hyperliquid order actions — orders, cancels, transfers, leverage updates. Filter by user, action type, vault, or status. NOTE: Requires hyperliquid-replica-cmds dataset (check availability with portal_list_datasets).',
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-replica-cmds')
        .describe("Dataset name (default: 'hyperliquid-replica-cmds')"),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block number'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      action_type: z
        .array(z.enum(['order', 'cancel', 'cancelByCloid', 'batchModify', 'transfer', 'withdraw', 'updateLeverage']))
        .optional()
        .describe('Action types to filter'),
      user: z.array(z.string()).optional().describe('User wallet addresses (0x-prefixed, lowercase)'),
      vault_address: z.array(z.string()).optional().describe('Vault addresses (0x-prefixed, lowercase)'),
      status: z.enum(['ok', 'err']).optional().describe('Filter by action status'),
      limit: z.number().optional().default(50).describe('Max actions to return'),
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      finalized_only,
      action_type,
      user,
      vault_address,
      status,
      limit,
    }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)

      // Resolve timeframe or use explicit blocks
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      // Build action filter
      const actionFilter: Record<string, unknown> = {}
      if (action_type) actionFilter.actionType = action_type
      if (user) actionFilter.user = user.map((u) => u.toLowerCase())
      if (vault_address) actionFilter.vaultAddress = vault_address.map((v) => v.toLowerCase())
      if (status) actionFilter.status = status

      const query = {
        type: 'hyperliquidReplicaCmds',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          action: {
            actionIndex: true,
            user: true,
            action: true,
            nonce: true,
            vaultAddress: true,
            status: true,
            response: true,
          },
        },
        actions: [actionFilter],
      }

      // HL blocks are ~0.083s — cap to prevent OOM
      const hasFilters = !!(action_type || user || vault_address || status)
      const blockRange = endBlock - resolvedFromBlock
      const maxBlocks = hasFilters ? 0 : Math.min(blockRange, 500000)
      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        maxBlocks,
        maxBytes: 100 * 1024 * 1024,
        stopAfterItems: {
          keys: ['actions'],
          limit,
        },
      })

      const allActions = results
        .flatMap((block: unknown) => {
          const b = block as {
            header?: { number: number; timestamp: number }
            actions?: Array<Record<string, unknown>>
          }
          return (b.actions || []).map((action) => ({
            block_number: b.header?.number,
            block_timestamp: b.header?.timestamp,
            ...action,
          }))
        })
        .slice(0, limit)

      return formatResult(
        allActions,
        `Retrieved ${allActions.length} Hyperliquid actions`,
        {
          maxItems: limit,
          warnOnTruncation: false,
          metadata: {
            dataset,
            from_block: resolvedFromBlock,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
