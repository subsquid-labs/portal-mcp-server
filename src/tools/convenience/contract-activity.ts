import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { EVENT_NAMES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { TRANSACTION_FIELD_PRESETS } from '../../helpers/field-presets.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { normalizeEvmAddress } from '../../helpers/validation.js'

// ============================================================================
// Tool: Get Contract Activity Summary (Convenience Wrapper)
// ============================================================================

/**
 * Analyzes contract activity in one call.
 * Returns:
 * - Total interactions
 * - Unique callers
 * - Event emissions
 * - Top callers by frequency
 */
export function registerGetContractActivityTool(server: McpServer) {
  server.tool(
    'portal_get_contract_activity',
    'Analyze smart contract activity: interaction count, unique callers, event emissions, and top users over a time period.',
    {
      dataset: z.string().describe('Dataset name or alias'),
      contract_address: z.string().describe('Contract address to analyze'),
      timeframe: z
        .enum(['1h', '24h', '7d', '1000', '5000'])
        .optional()
        .default('1000')
        .describe("Analysis period: '1h'=~1 hour, '24h'=~1 day, '7d'=~1 week, or block count"),
      include_events: z.boolean().optional().default(true).describe('Include event log summary'),
    },
    async ({ dataset, contract_address, timeframe, include_events }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_contract_activity is only for EVM chains')
      }

      const normalizedContract = normalizeEvmAddress(contract_address)

      // Resolve block range — numeric values are exact block counts,
      // time-based values (1h, 24h, etc.) use Portal's /timestamps/ API
      let fromBlock: number
      let toBlock: number
      const isBlockCount = /^\d+$/.test(timeframe)

      if (isBlockCount) {
        const head = await getBlockHead(dataset)
        const blockRange = parseInt(timeframe)
        toBlock = head.number
        fromBlock = Math.max(0, toBlock - blockRange)
      } else {
        const resolved = await resolveTimeframeOrBlocks({ dataset, timeframe })
        fromBlock = resolved.from_block
        toBlock = resolved.to_block
      }

      // Query 1: Transactions to contract (standard preset — no input hex bloat)
      const txQuery = {
        type: 'evm',
        fromBlock,
        toBlock,
        fields: {
          block: { number: true, timestamp: true },
          transaction: { ...TRANSACTION_FIELD_PRESETS.standard.transaction },
        },
        transactions: [{ to: [normalizedContract] }],
      }

      // Contract activity aggregates all data, allow higher byte cap for dense chains
      const txResults = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        txQuery,
        undefined,
        0,
        100 * 1024 * 1024,
      )

      const transactions = txResults.flatMap(
        (block: unknown) => (block as { transactions?: unknown[] }).transactions || [],
      ) as Array<{ from: string; to: string; hash: string }>

      // Analyze callers
      const callerCounts = new Map<string, number>()
      transactions.forEach((tx) => {
        const from = tx.from.toLowerCase()
        callerCounts.set(from, (callerCounts.get(from) || 0) + 1)
      })

      const uniqueCallers = Array.from(callerCounts.keys())
      const topCallers = Array.from(callerCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([address, count]) => ({ address, interaction_count: count }))

      // Query 2: Events emitted (if requested)
      let events: unknown[] = []
      let eventsByType: Record<string, number> = {}
      if (include_events) {
        const eventsQuery = {
          type: 'evm',
          fromBlock,
          toBlock,
          fields: {
            block: { number: true, timestamp: true },
            log: buildEvmLogFields(),
          },
          logs: [{ address: [normalizedContract] }],
        }

        const eventResults = await portalFetchStream(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          eventsQuery,
          undefined,
          0,
          100 * 1024 * 1024,
        )

        const rawEvents = eventResults.flatMap((block: unknown) => (block as { logs?: unknown[] }).logs || [])
        events = rawEvents as Array<{ topics?: string[]; data: string }>

        // Count events by topic0 (event signature) — resolve to human-readable names
        ;(events as Array<{ topics?: string[]; data: string }>).forEach((event) => {
          const topic0 = event.topics?.[0] || 'unknown'
          const eventName = EVENT_NAMES[topic0] || topic0
          eventsByType[eventName] = (eventsByType[eventName] || 0) + 1
        })
      }

      const summary = {
        contract_address: normalizedContract,
        timeframe: {
          from_block: fromBlock,
          to_block: toBlock,
          description: timeframe,
        },
        interactions: {
          total_transactions: transactions.length,
          unique_callers: uniqueCallers.length,
          top_callers: topCallers,
          // Removed all_callers: massive array that bloats response unnecessarily
        },
        events: include_events
          ? {
              total_events: events.length,
              unique_event_types: Object.keys(eventsByType).length,
              events_by_type: eventsByType,
            }
          : null,
      }

      return formatResult(
        summary,
        `Contract ${normalizedContract}: ${transactions.length} interactions from ${uniqueCallers.length} unique callers, ${events.length} events`,
        {
          metadata: {
            dataset,
            from_block: fromBlock,
            to_block: toBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
