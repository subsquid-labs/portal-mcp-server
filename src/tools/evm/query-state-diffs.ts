import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmStateDiffFields, buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
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
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
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
      include_transaction: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include parent transaction data for each state diff'),
      limit: z.number().optional().default(50).describe('Max state diffs'),
    },
    async ({ dataset, timeframe, from_block, to_block, finalized_only, addresses, key, kind, include_transaction, limit }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_query_state_diffs is only for EVM chains')
      }

      // Resolve timeframe or use explicit blocks
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const normalizedAddresses = normalizeAddresses(addresses, chainType)
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      // Validate query size to prevent memory crashes
      const blockRange = endBlock - resolvedFromBlock
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
      if (include_transaction) diffFilter.transaction = true

      const fields: Record<string, unknown> = {
        block: { number: true, timestamp: true, hash: true },
        stateDiff: buildEvmStateDiffFields(),
      }
      if (include_transaction) {
        fields.transaction = buildEvmTransactionFields(isL2Chain(dataset))
      }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields,
        stateDiffs: [diffFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allDiffs = results
        .flatMap((block: unknown) => (block as { stateDiffs?: unknown[] }).stateDiffs || [])
        .slice(0, limit)
      return formatResult(allDiffs, `Retrieved ${allDiffs.length} state diffs`, {
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
