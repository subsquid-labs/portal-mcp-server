import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { EVENT_NAMES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { TRANSACTION_FIELD_PRESETS } from '../../helpers/field-presets.js'
import { portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { hashString53 } from '../../helpers/hash.js'
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
      const callerCounts = new Map<string, number>()
      const uniqueCallerHashes = new Set<number>()
      let totalTransactions = 0
      await portalFetchStreamRangeVisit(`${PORTAL_URL}/datasets/${dataset}/stream`, txQuery, {
        maxBytes: 100 * 1024 * 1024,
        onRecord: (record) => {
          const transactions = (record as { transactions?: Array<{ from?: string }> }).transactions || []

          totalTransactions += transactions.length
          transactions.forEach((tx) => {
            if (!tx.from) return
            const from = tx.from.toLowerCase()
            callerCounts.set(from, (callerCounts.get(from) || 0) + 1)
            uniqueCallerHashes.add(hashString53(from))
          })
        },
      })

      const topCallers = Array.from(callerCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([address, count]) => ({ address, interaction_count: count }))

      // Query 2: Events emitted (if requested)
      let eventsByType: Record<string, number> = {}
      let totalEvents = 0
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

        await portalFetchStreamRangeVisit(`${PORTAL_URL}/datasets/${dataset}/stream`, eventsQuery, {
          maxBytes: 100 * 1024 * 1024,
          onRecord: (record) => {
            const events = (record as { logs?: Array<{ topics?: string[] }> }).logs || []
            totalEvents += events.length

            events.forEach((event) => {
              const topic0 = event.topics?.[0] || 'unknown'
              const eventName = EVENT_NAMES[topic0] || topic0
              eventsByType[eventName] = (eventsByType[eventName] || 0) + 1
            })
          },
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
          total_transactions: totalTransactions,
          unique_callers: uniqueCallerHashes.size,
          top_callers: topCallers,
          // Removed all_callers: massive array that bloats response unnecessarily
        },
        events: include_events
          ? {
              total_events: totalEvents,
              unique_event_types: Object.keys(eventsByType).length,
              events_by_type: eventsByType,
            }
          : null,
      }

      return formatResult(
        summary,
        `Contract ${normalizedContract}: ${totalTransactions} interactions from ${uniqueCallerHashes.size} unique callers, ${totalEvents} events`,
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
