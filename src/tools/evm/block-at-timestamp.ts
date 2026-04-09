import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { detectChainType } from '../../helpers/chain.js'
import { formatResult } from '../../helpers/format.js'
import { timestampToBlock } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Block at Timestamp
// ============================================================================

export function registerBlockAtTimestampTool(server: McpServer) {
  server.tool(
    'portal_block_at_timestamp',
    'Find the block or slot number at a specific timestamp',
    {
      dataset: z.string().describe('Dataset name or alias'),
      timestamp: z.number().describe('Unix timestamp in seconds'),
    },
    async ({ dataset, timestamp }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        throw new Error('portal_block_at_timestamp is not supported for Hyperliquid fill or replica datasets')
      }

      const blockNumber = await timestampToBlock(dataset, timestamp)

      return formatResult({
        block_number: blockNumber,
        timestamp,
        dataset,
      })
    },
  )
}
