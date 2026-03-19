import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Stream Query
// ============================================================================

export function registerStreamTool(server: McpServer) {
  server.tool(
    'portal_stream',
    `Execute raw Portal API streaming queries. Use specialized tools (portal_query_logs, etc.) for common queries. Chain type is auto-detected.`,
    {
      dataset: z.string().describe('Dataset name or alias'),
      query: z
        .object({
          fromBlock: z.number().describe('Starting block number (REQUIRED)'),
          toBlock: z.number().optional().describe('Ending block number'),
          fields: z.record(z.unknown()).optional().describe('Fields to return'),
          includeAllBlocks: z.boolean().optional().describe('Include empty blocks'),
          logs: z.array(z.record(z.unknown())).optional().describe('Log filters (EVM only)'),
          transactions: z.array(z.record(z.unknown())).optional().describe('Transaction filters'),
          traces: z.array(z.record(z.unknown())).optional().describe('Trace filters (EVM only)'),
          stateDiffs: z.array(z.record(z.unknown())).optional().describe('State diff filters (EVM only)'),
          instructions: z.array(z.record(z.unknown())).optional().describe('Instruction filters (Solana only)'),
          balances: z.array(z.record(z.unknown())).optional().describe('Balance filters (Solana only)'),
          tokenBalances: z.array(z.record(z.unknown())).optional().describe('Token balance filters (Solana only)'),
          rewards: z.array(z.record(z.unknown())).optional().describe('Reward filters (Solana only)'),
        })
        .passthrough() // Allow additional properties like 'type'
        .describe("Query object. NOTE: 'type' field is automatically added - do not include it"),
      timeout_ms: z.number().optional().default(60000).describe('Request timeout in milliseconds'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Max blocks to return (default: 20). Caps the NDJSON stream to prevent context overflow.'),
    },
    async ({ dataset, query, timeout_ms, limit }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      // Automatically add the type field based on dataset
      const queryWithType = {
        ...query,
        type: chainType,
      }

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        queryWithType,
        timeout_ms,
        limit,
      )

      const truncated = results.length >= limit
      const message = truncated
        ? `Retrieved ${results.length} blocks of data (capped at limit=${limit})`
        : `Retrieved ${results.length} blocks of data`

      return formatResult(results, message)
    },
  )
}
