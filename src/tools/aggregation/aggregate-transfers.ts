import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { normalizeAddresses } from '../../helpers/validation.js'

// ============================================================================
// Tool: Aggregate Transfers
// ============================================================================

// Transfer event signature
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Aggregate transfer statistics without fetching individual transfers.
 * Perfect for "transfer volume" questions.
 */
export function registerAggregateTransfersTool(server: McpServer) {
  server.tool(
    'portal_aggregate_transfers',
    `Aggregate ERC20 transfer statistics: volume, unique addresses, token breakdown. ~98% smaller than fetching individual transfers.`,
    {
      dataset: z.string().describe('Dataset name'),
      timeframe: z.string().optional().describe("Time range (e.g., '24h', '7d')"),
      from_block: z.number().optional().describe('Starting block (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block'),
      token_address: z.string().optional().describe('Specific token contract to aggregate (e.g., USDC address)'),
      from_address: z.string().optional().describe('Filter transfers from this sender'),
      to_address: z.string().optional().describe('Filter transfers to this receiver'),
      group_by: z
        .enum(['token', 'sender', 'receiver', 'none'])
        .optional()
        .default('none')
        .describe("Group by: 'token' (per token), 'sender', 'receiver', 'none' (totals only)"),
    },
    async ({ dataset, timeframe, from_block, to_block, token_address, from_address, to_address, group_by }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_aggregate_transfers is only for EVM chains')
      }

      // Resolve timeframe
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      // Build filter
      const logFilter: Record<string, unknown> = {
        topic0: [TRANSFER_TOPIC0],
      }

      if (token_address) {
        logFilter.address = normalizeAddresses([token_address], chainType)
      }

      // topic1 = from address (indexed), topic2 = to address (indexed)
      if (from_address) {
        const paddedFrom = '0x' + '0'.repeat(24) + from_address.toLowerCase().slice(2)
        logFilter.topic1 = [paddedFrom]
      }
      if (to_address) {
        const paddedTo = '0x' + '0'.repeat(24) + to_address.toLowerCase().slice(2)
        logFilter.topic2 = [paddedTo]
      }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: resolvedToBlock,
        fields: {
          block: { number: true },
          log: {
            address: true,
            topics: true,
            data: true,
            logIndex: true,
          },
        },
        logs: [logFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      // Extract transfers
      const allLogs = results.flatMap((block: any) =>
        (block.logs || []).map((log: any) => ({ ...log, blockNumber: block.number })),
      )

      const totalTransfers = allLogs.length

      // Extract addresses and compute volume from topics + data
      const senders = new Set<string>()
      const receivers = new Set<string>()
      const tokens = new Set<string>()
      let totalVolumeRaw = 0n

      allLogs.forEach((log: any) => {
        if (log.address) tokens.add(log.address.toLowerCase())
        if (log.topics && log.topics.length >= 3) {
          const from = '0x' + log.topics[1].slice(-40)
          const to = '0x' + log.topics[2].slice(-40)
          senders.add(from)
          receivers.add(to)
        }
        // Extract transfer value from data (Transfer event: data = uint256 value)
        if (log.data && log.data !== '0x' && log.data.length >= 66) {
          try {
            totalVolumeRaw += BigInt(log.data.slice(0, 66))
          } catch {
            // skip malformed data
          }
        }
      })

      // Group if requested
      let grouped: any = undefined

      if (group_by === 'token') {
        const byToken = new Map<string, { count: number; volume: bigint }>()
        allLogs.forEach((log: any) => {
          const token = log.address?.toLowerCase() || 'unknown'
          const existing = byToken.get(token) || { count: 0, volume: 0n }
          existing.count++
          if (log.data && log.data !== '0x' && log.data.length >= 66) {
            try { existing.volume += BigInt(log.data.slice(0, 66)) } catch { /* skip */ }
          }
          byToken.set(token, existing)
        })

        grouped = Array.from(byToken.entries())
          .map(([token, { count, volume }]) => ({
            token,
            transfer_count: count,
            total_volume_raw: volume.toString(),
          }))
          .sort((a, b) => b.transfer_count - a.transfer_count)
      } else if (group_by === 'sender') {
        const bySender = new Map<string, number>()
        allLogs.forEach((log: any) => {
          if (log.topics && log.topics.length >= 2) {
            const from = '0x' + log.topics[1].slice(-40)
            bySender.set(from, (bySender.get(from) || 0) + 1)
          }
        })

        grouped = Array.from(bySender.entries())
          .map(([sender, count]) => ({ sender, transfer_count: count }))
          .sort((a, b) => b.transfer_count - a.transfer_count)
          .slice(0, 20)
      } else if (group_by === 'receiver') {
        const byReceiver = new Map<string, number>()
        allLogs.forEach((log: any) => {
          if (log.topics && log.topics.length >= 3) {
            const to = '0x' + log.topics[2].slice(-40)
            byReceiver.set(to, (byReceiver.get(to) || 0) + 1)
          }
        })

        grouped = Array.from(byReceiver.entries())
          .map(([receiver, count]) => ({ receiver, transfer_count: count }))
          .sort((a, b) => b.transfer_count - a.transfer_count)
          .slice(0, 20)
      }

      const response: any = {
        total_transfers: totalTransfers,
        total_volume_raw: totalVolumeRaw.toString(),
        unique_senders: senders.size,
        unique_receivers: receivers.size,
        unique_tokens: tokens.size,
        blocks_analyzed: results.length,
      }

      if (grouped) {
        response.grouped = grouped
        response.top_count = grouped.length
      }

      return formatResult(
        response,
        `Aggregated ${totalTransfers.toLocaleString()} transfers: ${senders.size} senders, ${receivers.size} receivers, ${tokens.size} tokens`,
        {
          metadata: {
            dataset,
            from_block: resolvedFromBlock,
            to_block: resolvedToBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
