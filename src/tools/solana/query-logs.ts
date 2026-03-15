import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildSolanaLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { validateSolanaQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Solana Logs
// ============================================================================

export function registerQuerySolanaLogsTool(server: McpServer) {
  server.tool(
    'portal_query_solana_logs',
    'Query log messages from a Solana dataset',
    {
      dataset: z.string().describe('Dataset name or alias'),
      from_block: z.number().describe('Starting slot number'),
      to_block: z.number().optional().describe('Ending slot number'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized slots'),
      program_id: z.array(z.string()).optional().describe('Program IDs'),
      kind: z
        .array(z.enum(['log', 'data', 'other']))
        .optional()
        .describe('Log kinds'),
      limit: z.number().optional().default(1000).describe('Max logs'),
    },
    async ({ dataset, from_block, to_block, finalized_only, program_id, kind, limit }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw new Error('portal_query_solana_logs is only for Solana chains')
      }

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      const hasFilters = !!(program_id || kind)
      const validation = validateSolanaQuerySize({
        slotRange: endBlock - from_block,
        hasFilters,
        queryType: 'logs',
        limit,
      })
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      const logFilter: Record<string, unknown> = {}
      if (program_id) logFilter.programId = program_id
      if (kind) logFilter.kind = kind

      const query = {
        type: 'solana',
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          log: buildSolanaLogFields(),
        },
        logs: [logFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allLogs = results.flatMap((block: unknown) => (block as { logs?: unknown[] }).logs || []).slice(0, limit)
      return formatResult(allLogs, `Retrieved ${allLogs.length} logs`)
    },
  )
}
