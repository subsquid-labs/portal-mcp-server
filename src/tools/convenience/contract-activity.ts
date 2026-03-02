import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetch, portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmLogFields, buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeEvmAddress } from '../../helpers/validation.js'
import type { BlockHead } from '../../types/index.js'

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
    'Analyze smart contract activity. Returns interaction count, unique callers, events emitted, and top users. Perfect for monitoring contract usage, identifying power users, or detecting unusual activity patterns.',
    {
      dataset: z.string().describe('Dataset name or alias'),
      contract_address: z.string().describe('Contract address to analyze'),
      timeframe: z
        .enum(['1h', '24h', '7d', '1000', '5000'])
        .optional()
        .default('1000')
        .describe("Analysis period: '1h'=~1800 blocks, '24h'=~43200, '7d'=~302400, or block count"),
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

      // Get latest block (cached for 30s)
      const head = await getBlockHead(dataset)
      const latestBlock = head.number

      // Calculate block range
      let blockRange: number
      switch (timeframe) {
        case '1h':
          blockRange = 1800
          break
        case '24h':
          blockRange = 43200
          break
        case '7d':
          blockRange = 302400
          break
        default:
          blockRange = parseInt(timeframe)
      }

      const fromBlock = Math.max(0, latestBlock - blockRange)
      const toBlock = latestBlock

      // Query 1: Transactions to contract
      const txQuery = {
        type: 'evm',
        fromBlock,
        toBlock,
        fields: {
          block: { number: true, timestamp: true },
          transaction: buildEvmTransactionFields(false),
        },
        transactions: [{ to: [normalizedContract] }],
      }

      const txResults = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, txQuery)

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

        const eventResults = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, eventsQuery)

        const rawEvents = eventResults.flatMap((block: unknown) => (block as { logs?: unknown[] }).logs || [])
        events = rawEvents as Array<{ topics?: string[]; data: string }>

        // Count events by topic0 (event signature)
        ;(events as Array<{ topics?: string[]; data: string }>).forEach((event) => {
          const topic0 = event.topics?.[0] || 'unknown'
          eventsByType[topic0] = (eventsByType[topic0] || 0) + 1
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
