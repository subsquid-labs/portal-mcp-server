import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { portalFetch } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import type { BlockHead, DatasetMetadata } from '../../types/index.js'

// ============================================================================
// Tool: Get Dataset Info
// ============================================================================

export function registerGetDatasetInfoTool(server: McpServer) {
  server.tool(
    'portal_get_dataset_info',
    'Get detailed information about a specific dataset',
    {
      dataset: z.string().describe('Dataset name or alias'),
    },
    async ({ dataset }) => {
      dataset = await resolveDataset(dataset)
      const metadata = await portalFetch<DatasetMetadata>(`${PORTAL_URL}/datasets/${dataset}/metadata`)
      const head = await portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/head`)
      const chainType = detectChainType(dataset)
      const is_l2 = chainType === 'evm' && isL2Chain(dataset)

      return formatResult({
        ...metadata,
        head,
        chain_type: chainType,
        is_l2,
      })
    },
  )
}
