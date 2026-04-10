import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetch } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { buildToolDescription } from '../../helpers/tool-ux.js'
import type { BlockHead } from '../../types/index.js'

// ============================================================================
// Tool: Get Block Number
// ============================================================================

export function registerGetBlockNumberTool(server: McpServer) {
  server.tool(
    'portal_get_head',
    buildToolDescription('portal_get_head'),
    {
      network: z.string().describe('Network name or alias'),
      type: z.enum(['latest', 'finalized']).optional().default('latest').describe('Block type'),
    },
    async ({ network, type }) => {
      const dataset = await resolveDataset(network)
      const endpoint =
        type === 'finalized'
          ? `${PORTAL_URL}/datasets/${dataset}/finalized-head`
          : `${PORTAL_URL}/datasets/${dataset}/head`
      const head = await portalFetch<BlockHead>(endpoint)
      if (!head || typeof head !== 'object' || !('number' in head) || head.number == null) {
        throw new Error(
          `No head block available for network '${dataset}'. The network may be temporarily unavailable or syncing. ` +
          `Try again in a moment, or use portal_list_networks to verify the network exists.`,
        )
      }
      return formatResult({ ...head, type, network: dataset }, undefined, {
        toolName: 'portal_get_head',
      })
    },
  )
}
