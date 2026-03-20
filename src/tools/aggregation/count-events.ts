import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { EVENT_NAMES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { getQueryExamples, normalizeAddresses, validateQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Count Events
// ============================================================================

/**
 * Count events without fetching full data.
 * Perfect for "how many X" questions - uses ~1% of tokens vs full query.
 */
export function registerCountEventsTool(server: McpServer) {
  server.tool(
    'portal_count_events',
    `Count events/logs without fetching full data. Returns counts by contract, ~99% smaller than portal_query_logs.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      timeframe: z.string().optional().describe("Time range (e.g., '24h', '7d'). Alternative to from_block/to_block"),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block number'),
      addresses: z.array(z.string()).optional().describe('Contract addresses to count events from'),
      topic0: z.array(z.string()).optional().describe('Event signatures to count (e.g., Transfer signature)'),
      group_by: z
        .enum(['address', 'topic0', 'none'])
        .optional()
        .default('none')
        .describe("Group counts by: 'address' (per contract), 'topic0' (per event type), 'none' (total only)"),
      top_n: z
        .number()
        .optional()
        .default(20)
        .describe('When grouping, return only top N results (default: 20). Set to 0 for all results.'),
    },
    async ({ dataset, timeframe, from_block, to_block, addresses, topic0, group_by, top_n }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_count_events is only for EVM chains')
      }

      // Resolve timeframe or use explicit blocks
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const normalizedAddresses = normalizeAddresses(addresses, chainType)

      // Validate query size to prevent crashes
      const queryBlockRange = resolvedToBlock - resolvedFromBlock
      const hasFilters = !!(normalizedAddresses || topic0)
      const validation = validateQuerySize({
        blockRange: queryBlockRange,
        hasFilters,
        queryType: 'logs',
        limit: 10000, // count_events has no user-facing limit
      })
      if (!validation.valid) {
        const examples = !hasFilters ? getQueryExamples('logs') : ''
        throw new Error(validation.error + examples)
      }

      // Build minimal query - only fetch what we need to count
      // Only request 'topics' when grouping by topic0 (reduces response size)
      const logFilter: Record<string, unknown> = {}
      if (normalizedAddresses) logFilter.address = normalizedAddresses
      if (topic0) logFilter.topic0 = topic0

      const logFields: Record<string, boolean> = {
        address: true,
        logIndex: true,
      }
      if (group_by === 'topic0') {
        logFields.topics = true
      }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: resolvedToBlock,
        fields: {
          block: { number: true },
          log: logFields,
        },
        logs: [logFilter],
      }

      // count_events downloads full log data to count client-side, so cap bytes at 100MB
      // to handle dense chains like Base (~160 txs/block)
      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
        undefined,
        0,
        100 * 1024 * 1024,
      )

      // Count events
      const allLogs = results.flatMap((block: any) =>
        (block.logs || []).map((log: any) => ({ ...log, blockNumber: block.number })),
      )

      const totalCount = allLogs.length

      // Group by address or topic0 if requested
      let grouped: any = undefined

      if (group_by === 'address') {
        const byAddress = new Map<string, number>()
        allLogs.forEach((log: any) => {
          const addr = log.address || 'unknown'
          byAddress.set(addr, (byAddress.get(addr) || 0) + 1)
        })

        grouped = Array.from(byAddress.entries())
          .map(([address, count]) => ({ address, count }))
          .sort((a, b) => b.count - a.count)
      } else if (group_by === 'topic0') {
        const byTopic = new Map<string, number>()
        allLogs.forEach((log: any) => {
          // Portal returns topics as an array, topic0 is the first element
          const topic = log.topics?.[0] || 'unknown'
          byTopic.set(topic, (byTopic.get(topic) || 0) + 1)
        })

        grouped = Array.from(byTopic.entries())
          .map(([topic0, count]) => ({
            topic0,
            event_name: EVENT_NAMES[topic0] || null,
            count,
          }))
          .sort((a, b) => b.count - a.count)
      }

      // Calculate blocks analyzed
      const blocks = allLogs.map((l: any) => l.blockNumber).filter(Boolean)
      const blockRange =
        blocks.length > 0
          ? {
              from: Math.min(...blocks),
              to: Math.max(...blocks),
              count: results.length,
            }
          : { from: resolvedFromBlock, to: resolvedToBlock, count: results.length }

      const response: any = {
        total_events: totalCount,
        block_range: blockRange,
      }

      if (grouped) {
        const totalGroups = grouped.length
        const shouldLimit = top_n && top_n > 0 && grouped.length > top_n

        if (shouldLimit) {
          response.grouped = grouped.slice(0, top_n)
          response.showing_top = top_n
          response.total_groups = totalGroups
          response.hidden_groups = totalGroups - top_n
        } else {
          response.grouped = grouped
          response.total_groups = totalGroups
        }
      }

      let message = `Counted ${totalCount.toLocaleString()} events across ${results.length} blocks`
      if (grouped && response.hidden_groups) {
        message += ` (showing top ${response.showing_top} of ${response.total_groups} groups)`
      }

      return formatResult(response, message, {
        metadata: {
          dataset,
          from_block: resolvedFromBlock,
          to_block: resolvedToBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
