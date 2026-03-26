import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetch } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import type { BlockHead } from '../../types/index.js'

// ============================================================================
// Tool: Get Block Number
// ============================================================================

export function registerGetBlockNumberTool(server: McpServer) {
  server.tool(
    'portal_get_block_number',
    'Get the current/latest block number for a dataset',
    {
      dataset: z.string().describe('Dataset name or alias'),
      type: z.enum(['latest', 'finalized']).optional().default('latest').describe('Block type'),
    },
    async ({ dataset, type }) => {
      dataset = await resolveDataset(dataset)
      const endpoint =
        type === 'finalized'
          ? `${PORTAL_URL}/datasets/${dataset}/finalized-head`
          : `${PORTAL_URL}/datasets/${dataset}/head`
      const head = await portalFetch<BlockHead>(endpoint)
      if (!head || typeof head !== 'object' || !('number' in head) || head.number == null) {
        throw new Error(
          `No head block available for dataset '${dataset}'. The dataset may be temporarily unavailable or syncing. ` +
          `Try again in a moment, or use portal_list_datasets to verify the dataset exists.`,
        )
      }
      return formatResult({ ...head, type })
    },
  )
}
