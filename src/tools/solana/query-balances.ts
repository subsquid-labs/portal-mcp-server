import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildSolanaBalanceFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { validateSolanaQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Solana Balances
// ============================================================================

export function registerQuerySolanaBalancesTool(server: McpServer) {
  server.tool(
    'portal_query_solana_balances',
    'Query SOL balance changes from a Solana dataset',
    {
      dataset: z.string().describe('Dataset name or alias'),
      from_block: z.number().describe('Starting slot number'),
      to_block: z.number().optional().describe('Ending slot number'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized slots'),
      account: z.array(z.string()).optional().describe('Account addresses to filter'),
      limit: z.number().optional().default(50).describe('Max balance changes'),
    },
    async ({ dataset, from_block, to_block, finalized_only, account, limit }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw new Error('portal_query_solana_balances is only for Solana chains')
      }

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      const hasFilters = !!account
      const validation = validateSolanaQuerySize({
        slotRange: endBlock - from_block,
        hasFilters,
        queryType: 'balances',
        limit,
      })
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      const balanceFilter: Record<string, unknown> = {}
      if (account) balanceFilter.account = account

      const query = {
        type: 'solana',
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          balance: buildSolanaBalanceFields(),
        },
        balances: [balanceFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allBalances = results
        .flatMap((block: unknown) => (block as { balances?: unknown[] }).balances || [])
        .slice(0, limit)
      return formatResult(allBalances, `Retrieved ${allBalances.length} balance changes`)
    },
  )
}
