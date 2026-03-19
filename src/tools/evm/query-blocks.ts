import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { getBlockFields } from '../../helpers/field-presets.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmBlockFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Query Blocks (EVM)
// ============================================================================

export function registerQueryBlocksTool(server: McpServer) {
  server.tool(
    'portal_query_blocks',
    'Query block data from an EVM dataset',
    {
      dataset: z.string().describe('Dataset name or alias'),
      from_block: z.number().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Max blocks to return (default: 20). Note: Lower default for MCP to reduce context usage.'),
      include_l2_fields: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include L2-specific fields (auto-detected for L2 chains)'),
      field_preset: z
        .enum(['minimal', 'standard', 'full'])
        .optional()
        .default('standard')
        .describe(
          "Field preset: 'minimal' (number+timestamp+gas, smallest), 'standard' (+hash+miner+size), 'full' (all fields including parentHash, stateRoot, mixHash, etc.)",
        ),
    },
    async ({ dataset, from_block, to_block, limit, include_l2_fields, finalized_only, field_preset }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_query_blocks is only for EVM chains. Use portal_query_solana_instructions for Solana.')
      }

      const { validatedToBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const endBlock = Math.min(from_block + limit!, validatedToBlock)
      const includeL2 = include_l2_fields || isL2Chain(dataset)

      // Use field preset for compact responses, fall back to full builder for 'full'
      const blockFields =
        field_preset === 'full'
          ? buildEvmBlockFields(includeL2)
          : { ...getBlockFields(field_preset), ...(includeL2 ? { l1BlockNumber: true } : {}) }

      const query = {
        type: 'evm',
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: blockFields,
        },
        includeAllBlocks: true,
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      return formatResult(results, `Retrieved ${results.length} blocks`, {
        metadata: {
          dataset,
          from_block,
          to_block: endBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
