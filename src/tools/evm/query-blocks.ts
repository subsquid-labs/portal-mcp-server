import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { getBlockFields } from '../../helpers/field-presets.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmBlockFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { hexToNumber, weiToGwei } from '../../helpers/formatting.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Query Blocks (EVM)
// ============================================================================

export function registerQueryBlocksTool(server: McpServer) {
  server.tool(
    'portal_query_blocks',
    'Query block data from an EVM dataset',
    {
      dataset: z.string().describe('Dataset name or alias'),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
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
    async ({ dataset, timeframe, from_block, to_block, limit, include_l2_fields, finalized_only, field_preset }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_query_blocks is only for EVM chains. Use portal_query_solana_instructions for Solana.')
      }

      // Resolve timeframe or use explicit blocks
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const { validatedToBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const endBlock = Math.min(resolvedFromBlock + limit!, validatedToBlock)
      const includeL2 = include_l2_fields || isL2Chain(dataset)

      // Use field preset for compact responses, fall back to full builder for 'full'
      const blockFields =
        field_preset === 'full'
          ? buildEvmBlockFields(includeL2)
          : { ...getBlockFields(field_preset), ...(includeL2 ? { l1BlockNumber: true } : {}) }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields: {
          block: blockFields,
        },
        includeAllBlocks: true,
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      // Convert hex values to human-readable numbers
      const formatted = results.map((block: any) => {
        const header = block.header || block
        if (header.gasUsed && typeof header.gasUsed === 'string') {
          header.gasUsed = hexToNumber(header.gasUsed)
        }
        if (header.gasLimit && typeof header.gasLimit === 'string') {
          header.gasLimit = hexToNumber(header.gasLimit)
        }
        if (header.baseFeePerGas && typeof header.baseFeePerGas === 'string') {
          header.baseFeePerGas_gwei = weiToGwei(header.baseFeePerGas)
          delete header.baseFeePerGas
        }
        if (header.size && typeof header.size === 'string') {
          header.size = hexToNumber(header.size)
        }
        if (header.difficulty && typeof header.difficulty === 'string') {
          header.difficulty = hexToNumber(header.difficulty)
        }
        if (header.totalDifficulty && typeof header.totalDifficulty === 'string') {
          header.totalDifficulty = hexToNumber(header.totalDifficulty)
        }
        return block
      })

      return formatResult(formatted, `Retrieved ${formatted.length} blocks`, {
        metadata: {
          dataset,
          from_block: resolvedFromBlock,
          to_block: endBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
