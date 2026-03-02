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
    `LOW-LEVEL TOOL: Execute raw Portal API queries. Most users should use specialized tools instead.

WHEN TO USE:
- Custom queries not covered by other tools
- Advanced filtering combinations
- Experimental queries

BETTER ALTERNATIVES:
- For logs: use portal_query_logs
- For transactions: use portal_query_transactions
- For traces: use portal_query_traces
- For wallet analysis: use portal_get_wallet_summary
- For transaction density: use portal_get_transaction_density

IMPORTANT: The 'type' field is automatically added based on the dataset (evm/solana).`,
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
    },
    async ({ dataset, query, timeout_ms }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      // Automatically add the type field based on dataset
      const queryWithType = {
        ...query,
        type: chainType,
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, queryWithType, timeout_ms)

      return formatResult(results, `Retrieved ${results.length} blocks of data`)
    },
  )
}
