import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getDatasets } from '../../cache/datasets.js'
import { detectChainType } from '../../helpers/chain.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: List Datasets
// ============================================================================

export function registerListDatasetsTool(server: McpServer) {
  server.tool(
    'portal_list_datasets',
    'List all available datasets, optionally filtered by chain type or name pattern',
    {
      chain_type: z.enum(['evm', 'solana']).optional().describe('Filter by chain type'),
      pattern: z.string().optional().describe('Filter by name pattern (regex)'),
      real_time_only: z.boolean().optional().describe('Only show real-time datasets'),
    },
    async ({ chain_type, pattern, real_time_only }) => {
      let datasets = await getDatasets()

      if (chain_type) {
        datasets = datasets.filter((d) => detectChainType(d.dataset) === chain_type)
      }

      if (pattern) {
        const regex = new RegExp(pattern, 'i')
        datasets = datasets.filter((d) => regex.test(d.dataset) || d.aliases.some((a) => regex.test(a)))
      }

      if (real_time_only) {
        datasets = datasets.filter((d) => d.real_time)
      }

      return formatResult(datasets, `Found ${datasets.length} datasets`)
    },
  )
}
