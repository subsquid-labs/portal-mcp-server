import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { formatResult } from '../../helpers/format.js'
import { buildBlockLookupFreshness } from '../../helpers/result-metadata.js'
import { resolveBlockAtTimestamp } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'

// ============================================================================
// Tool: Block at Timestamp
// ============================================================================

export function registerBlockAtTimestampTool(server: McpServer) {
  server.tool(
    'portal_debug_resolve_time_to_block',
    buildToolDescription('portal_debug_resolve_time_to_block'),
    {
      network: z.string().describe('Network name or alias'),
      timestamp: z
        .union([z.number(), z.string()])
        .describe('Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago"'),
    },
    async ({ network, timestamp }) => {
      const dataset = await resolveDataset(network)
      const chainType = detectChainType(dataset)

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        throw createUnsupportedChainError({
          toolName: 'portal_debug_resolve_time_to_block',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin'],
          suggestions: [
            'Use portal_get_head for the current head block.',
            'Use portal_hyperliquid_query_fills with a recent block window for Hyperliquid activity.',
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
        {
          toolName: 'portal_debug_resolve_time_to_block',
          notices,
          freshness: buildBlockLookupFreshness(result),
          coverage: {
            kind: 'timestamp_lookup',
            window_complete: true,
            result_complete: true,
            resolution: result.resolution,
          },
          execution: buildExecutionMetadata({
            notes: [
              result.resolution === 'estimated'
                ? 'Resolved near the indexed head using the latest known block timestamp.'
                : 'Resolved directly against indexed timestamp data.',
            ],
          }),
          metadata: {
            network: dataset,
          },
        },
      )
    },
  )
}
