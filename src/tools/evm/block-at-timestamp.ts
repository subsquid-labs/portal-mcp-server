import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetch, portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import type { BlockHead } from '../../types/index.js'

// ============================================================================
// Tool: Block at Timestamp
// ============================================================================

export function registerBlockAtTimestampTool(server: McpServer) {
  server.tool(
    'portal_block_at_timestamp',
    'Find the block number at a specific timestamp (EVM only)',
    {
      dataset: z.string().describe('Dataset name or alias'),
      timestamp: z.number().describe('Unix timestamp in seconds'),
    },
    async ({ dataset, timestamp }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('Block at timestamp is only supported for EVM chains')
      }

      // Binary search for block at timestamp
      const head = await portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/head`)
      let low = 0
      let high = head.number
      let result = 0

      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const query = {
          type: 'evm',
          fromBlock: mid,
          toBlock: mid + 1,
          fields: { block: { timestamp: true, number: true } },
          includeAllBlocks: true,
        }

        const response = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

        if (response.length > 0) {
          const block = response[0] as { header: { timestamp: number } }
          if (block.header.timestamp <= timestamp) {
            result = mid
            low = mid + 1
          } else {
            high = mid - 1
          }
        } else {
          high = mid - 1
        }
      }

      return formatResult({
        block_number: result,
        timestamp,
        dataset,
      })
    },
  )
}
