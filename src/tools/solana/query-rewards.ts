import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildSolanaRewardFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Query Solana Rewards
// ============================================================================

export function registerQuerySolanaRewardsTool(server: McpServer) {
  server.tool(
    'portal_query_solana_rewards',
    'Query block rewards from a Solana dataset',
    {
      dataset: z.string().describe('Dataset name or alias'),
      from_block: z.number().describe('Starting slot number'),
      to_block: z.number().optional().describe('Ending slot number'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized slots'),
      pubkey: z.array(z.string()).optional().describe('Reward recipient pubkeys'),
      limit: z.number().optional().default(1000).describe('Max rewards'),
    },
    async ({ dataset, from_block, to_block, finalized_only, pubkey, limit }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw new Error('portal_query_solana_rewards is only for Solana chains')
      }

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      const rewardFilter: Record<string, unknown> = {}
      if (pubkey) rewardFilter.pubkey = pubkey

      const query = {
        type: 'solana',
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          reward: buildSolanaRewardFields(),
        },
        rewards: [rewardFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allRewards = results
        .flatMap((block: unknown) => (block as { rewards?: unknown[] }).rewards || [])
        .slice(0, limit)
      return formatResult(allRewards, `Retrieved ${allRewards.length} rewards`)
    },
  )
}
