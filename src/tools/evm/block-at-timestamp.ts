import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { formatResult } from '../../helpers/format.js'
import { resolveBlockAtTimestamp } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Block at Timestamp
// ============================================================================

export function registerBlockAtTimestampTool(server: McpServer) {
  server.tool(
    'portal_block_at_timestamp',
    'Find the block or slot number at a specific timestamp',
    {
      dataset: z.string().describe('Dataset name or alias'),
      timestamp: z
        .union([z.number(), z.string()])
        .describe('Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago"'),
    },
    async ({ dataset, timestamp }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        throw createUnsupportedChainError({
          toolName: 'portal_block_at_timestamp',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin'],
          suggestions: [
            'Use portal_get_block_number for the current head block.',
            'Use portal_query_hyperliquid_fills with a recent block window for Hyperliquid activity.',
          ],
        })
      }

      const result = await resolveBlockAtTimestamp(dataset, timestamp)
      const notices = result.resolution === 'estimated'
        ? ['Timestamp lookup near the current head was not indexed yet, so this result was estimated from the latest indexed block.']
        : undefined

      return formatResult(
        result,
        `Resolved ${result.timestamp_human} to block ${result.block_number} (${result.resolution}).`,
        { notices },
      )
    },
  )
}
