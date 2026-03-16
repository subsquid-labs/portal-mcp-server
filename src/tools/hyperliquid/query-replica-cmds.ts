import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Query Hyperliquid Replica Commands
// ============================================================================

export function registerQueryHyperliquidReplicaCmdsTool(server: McpServer) {
  server.tool(
    'portal_query_hyperliquid_replica_cmds',
    'Query Hyperliquid order actions — orders, cancels, transfers, leverage updates. Filter by user, action type, vault, or status.',
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-replica-cmds')
        .describe("Dataset name (default: 'hyperliquid-replica-cmds')"),
      from_block: z.number().describe('Starting block number'),
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

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
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
        fromBlock: from_block,
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

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

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
            from_block,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
