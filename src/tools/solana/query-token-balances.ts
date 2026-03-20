import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildSolanaTokenBalanceFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { validateSolanaQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Solana Token Balances
// ============================================================================

export function registerQuerySolanaTokenBalancesTool(server: McpServer) {
  server.tool(
    'portal_query_solana_token_balances',
    'Query SPL token balance changes from a Solana dataset',
    {
      dataset: z.string().describe('Dataset name or alias'),
      timeframe: z.string().optional().describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting slot number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending slot number'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized slots'),
      account: z.array(z.string()).optional().describe('Token account addresses'),
      pre_mint: z.array(z.string()).optional().describe('Token mint before tx'),
      post_mint: z.array(z.string()).optional().describe('Token mint after tx'),
      pre_owner: z.array(z.string()).optional().describe('Owner before tx'),
      post_owner: z.array(z.string()).optional().describe('Owner after tx'),
      limit: z.number().optional().default(50).describe('Max token balance changes'),
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      finalized_only,
      account,
      pre_mint,
      post_mint,
      pre_owner,
      post_owner,
      limit,
    }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw new Error('portal_query_solana_token_balances is only for Solana chains')
      }

      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset, timeframe, from_block, to_block,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      const hasFilters = !!(account || pre_mint || post_mint || pre_owner || post_owner)
      const validation = validateSolanaQuerySize({
        slotRange: endBlock - resolvedFromBlock,
        hasFilters,
        queryType: 'token_balances',
        limit,
      })
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      const tokenBalanceFilter: Record<string, unknown> = {}
      if (account) tokenBalanceFilter.account = account
      if (pre_mint) tokenBalanceFilter.preMint = pre_mint
      if (post_mint) tokenBalanceFilter.postMint = post_mint
      if (pre_owner) tokenBalanceFilter.preOwner = pre_owner
      if (post_owner) tokenBalanceFilter.postOwner = post_owner

      const query = {
        type: 'solana',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          tokenBalance: buildSolanaTokenBalanceFields(),
        },
        tokenBalances: [tokenBalanceFilter],
      }

      // Solana slots are extremely dense — cap maxBlocks to prevent OOM.
      const maxBlocks = hasFilters ? 0 : Math.max(5, Math.ceil(limit / 50))

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query, undefined, maxBlocks)

      const allTokenBalances = results
        .flatMap((block: unknown) => (block as { tokenBalances?: unknown[] }).tokenBalances || [])
        .slice(0, limit)

      return formatResult(allTokenBalances, `Retrieved ${allTokenBalances.length} token balance changes`)
    },
  )
}
