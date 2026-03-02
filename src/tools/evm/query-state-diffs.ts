import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmStateDiffFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeAddresses, validateQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Query State Diffs (EVM)
// ============================================================================

export function registerQueryStateDiffsTool(server: McpServer) {
  server.tool(
    'portal_query_state_diffs',
    'Query state changes from an EVM dataset. Wrapper for Portal API POST /datasets/{dataset}/stream. Keep block ranges reasonable for performance.',
    {
      dataset: z.string().describe('Dataset name or alias'),
      from_block: z.number().describe('Starting block number'),
      to_block: z
        .number()
        .optional()
        .describe('Ending block number. State diffs can be large - keep ranges reasonable.'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      addresses: z.array(z.string()).optional().describe('Contract addresses'),
      key: z.array(z.string()).optional().describe('Storage keys'),
      kind: z
        .array(z.enum(['=', '+', '*', '-']))
        .optional()
        .describe('Diff kinds: = (exists/no change), + (created), * (modified), - (deleted)'),
      limit: z.number().optional().default(1000).describe('Max state diffs'),
    },
    async ({ dataset, from_block, to_block, finalized_only, addresses, key, kind, limit }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_query_state_diffs is only for EVM chains')
      }

      const normalizedAddresses = normalizeAddresses(addresses, chainType)
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      // Validate query size to prevent memory crashes
      const blockRange = endBlock - from_block
      const hasFilters = !!(addresses || key || kind)
      const validation = validateQuerySize({
        blockRange,
        hasFilters,
        queryType: 'state_diffs',
        limit,
      })

      if (!validation.valid && validation.error) {
        throw new Error(validation.error)
      }

      const diffFilter: Record<string, unknown> = {}
      if (normalizedAddresses) diffFilter.address = normalizedAddresses
      if (key) diffFilter.key = key
      if (kind) diffFilter.kind = kind

      const query = {
        type: 'evm',
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true, hash: true },
          stateDiff: buildEvmStateDiffFields(),
        },
        stateDiffs: [diffFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allDiffs = results
        .flatMap((block: unknown) => (block as { stateDiffs?: unknown[] }).stateDiffs || [])
        .slice(0, limit)
      return formatResult(allDiffs, `Retrieved ${allDiffs.length} state diffs`, {
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
