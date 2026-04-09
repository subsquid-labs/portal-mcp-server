import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { formatResult } from '../../helpers/format.js'
import { formatUSD, formatNumber, formatPct } from '../../helpers/formatting.js'
import { hashString53 } from '../../helpers/hash.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { visitHyperliquidFillBlocks } from './fill-stream.js'

// ============================================================================
// Tool: Aggregate Hyperliquid Fills
// ============================================================================

/**
 * Aggregate Hyperliquid trade fill statistics — unique traders, volume,
 * direction breakdown, top coins — without returning individual fills.
 */
export function registerAggregateHyperliquidFillsTool(server: McpServer) {
  server.tool(
    'portal_aggregate_hyperliquid_fills',
    `Aggregate Hyperliquid trading statistics: unique traders, fill count, volume, direction breakdown, top coins. Answers questions like "how many traders traded BTC in the past hour?" or "what's the most traded coin on Hyperliquid today?"`,
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Dataset name (default: 'hyperliquid-fills')"),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block number'),
      coin: z.array(z.string()).optional().describe('Filter by asset symbols (e.g., ["BTC", "ETH"])'),
      user: z.array(z.string()).optional().describe('Filter by trader addresses (0x-prefixed, lowercase)'),
      dir: z.array(z.string()).optional().describe('Filter by direction: "Open Long", "Close Long", "Open Short", "Close Short"'),
      group_by: z
        .enum(['coin', 'user', 'direction', 'none'])
        .optional()
        .default('none')
        .describe("Group by: 'coin' (per asset), 'user' (per trader), 'direction', 'none' (totals only)"),
    },
    async ({ dataset, timeframe, from_block, to_block, coin, user, dir, group_by }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)

      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      // Build fill filter
      const fillFilter: Record<string, unknown> = {}
      if (coin) fillFilter.coin = coin
      if (user) fillFilter.user = user.map((u) => u.toLowerCase())
      if (dir) fillFilter.dir = dir

      const requestedBlockRange = endBlock - resolvedFromBlock + 1
      const maxAggregationBlocks = 1_000_000
      const effectiveFrom = requestedBlockRange > maxAggregationBlocks
        ? endBlock - maxAggregationBlocks + 1
        : resolvedFromBlock

      // Compute aggregates incrementally to avoid materializing the full fill stream.
      const traders = new Set<number>()
      const coins = new Set<string>()
      let totalVolume = 0
      let totalFees = 0
      let totalPnl = 0
      let totalFills = 0
      const dirCounts: Record<string, number> = {}

      // Group if requested
      let grouped: any[] | undefined
      const byCoin = group_by === 'coin'
        ? new Map<string, { fills: number; volume: number; traders: Set<number>; pnl: number }>()
        : undefined
      const byUser = group_by === 'user'
        ? new Map<string, { fills: number; volume: number; coins: Set<string>; pnl: number }>()
        : undefined

      const { returnedBlocks, chunksFetched, chunkSizeReduced } = await visitHyperliquidFillBlocks({
        dataset,
        fromBlock: effectiveFrom,
        toBlock: endBlock,
        fillFilter,
        fillFields: {
          user: true,
          coin: true,
          px: true,
          sz: true,
          dir: true,
          fee: true,
          closedPnl: true,
        },
        maxBytes: 120 * 1024 * 1024,
        concurrency: 2,
        onBlock: (block) => {
          const fills = block.fills || []
          for (let index = 0; index < fills.length; index += 1) {
            const fill = fills[index]
            const userKey = typeof fill.user === 'string' ? fill.user : undefined
            const coinKey = typeof fill.coin === 'string' ? fill.coin : undefined
            const notional = Number(fill.px || 0) * Number(fill.sz || 0)
            const pnl = Number(fill.closedPnl || 0)
            const fee = Math.abs(Number(fill.fee || 0))
            const direction = typeof fill.dir === 'string' ? fill.dir : 'Unknown'

            totalFills += 1
            if (userKey) traders.add(hashString53(userKey))
            if (coinKey) coins.add(coinKey)
            totalVolume += notional
            totalFees += fee
            totalPnl += pnl
            dirCounts[direction] = (dirCounts[direction] || 0) + 1

            if (byCoin) {
              const coinStats = byCoin.get(coinKey || 'unknown') || {
                fills: 0,
                volume: 0,
                traders: new Set<number>(),
                pnl: 0,
              }
              coinStats.fills += 1
              coinStats.volume += notional
              if (userKey) coinStats.traders.add(hashString53(userKey))
              coinStats.pnl += pnl
              byCoin.set(coinKey || 'unknown', coinStats)
            }

            if (byUser) {
              const userStats = byUser.get(userKey || 'unknown') || {
                fills: 0,
                volume: 0,
                coins: new Set<string>(),
                pnl: 0,
              }
              userStats.fills += 1
              userStats.volume += notional
              if (coinKey) userStats.coins.add(coinKey)
              userStats.pnl += pnl
              byUser.set(userKey || 'unknown', userStats)
            }
          }
        },
      })

      if (totalFills === 0) {
        throw new Error('No Hyperliquid fills found for the specified filters')
      }

      if (byCoin) {
        grouped = Array.from(byCoin.entries())
          .map(([c, data]) => ({
            coin: c,
            fill_count: data.fills,
            unique_traders: data.traders.size,
            volume_usd: parseFloat(data.volume.toFixed(2)),
            volume_formatted: formatUSD(data.volume),
            market_share_pct: formatPct(totalVolume > 0 ? (data.volume / totalVolume) * 100 : 0),
            realized_pnl: parseFloat(data.pnl.toFixed(2)),
            realized_pnl_formatted: (data.pnl >= 0 ? '+' : '') + formatUSD(data.pnl),
          }))
          .sort((a, b) => b.volume_usd - a.volume_usd)
          .slice(0, 30)
          .map((item, i) => ({ rank: i + 1, ...item }))
      } else if (byUser) {
        grouped = Array.from(byUser.entries())
          .map(([u, data]) => ({
            user: u,
            fill_count: data.fills,
            coins_traded: data.coins.size,
            volume_usd: parseFloat(data.volume.toFixed(2)),
            volume_formatted: formatUSD(data.volume),
            market_share_pct: formatPct(totalVolume > 0 ? (data.volume / totalVolume) * 100 : 0),
            realized_pnl: parseFloat(data.pnl.toFixed(2)),
            realized_pnl_formatted: (data.pnl >= 0 ? '+' : '') + formatUSD(data.pnl),
          }))
          .sort((a, b) => b.volume_usd - a.volume_usd)
          .slice(0, 30)
          .map((item, i) => ({ rank: i + 1, ...item }))
      } else if (group_by === 'direction') {
        grouped = Object.entries(dirCounts)
          .map(([direction, count]) => ({ direction, fill_count: count }))
          .sort((a, b) => b.fill_count - a.fill_count)
      }

      // Compute additional metrics
      const liquidationCount = (dirCounts['Short > Long'] || 0) + (dirCounts['Long > Short'] || 0)
      const openLongs = dirCounts['Open Long'] || 0
      const openShorts = dirCounts['Open Short'] || 0
      const longShortRatio = openShorts > 0 ? parseFloat((openLongs / openShorts).toFixed(3)) : openLongs > 0 ? Infinity : 0

      const response: any = {
        total_fills: totalFills,
        total_fills_formatted: formatNumber(totalFills),
        unique_traders: traders.size,
        unique_coins: coins.size,
        total_volume_usd: parseFloat(totalVolume.toFixed(2)),
        total_volume_formatted: formatUSD(totalVolume),
        total_fees_usd: parseFloat(totalFees.toFixed(2)),
        total_fees_formatted: formatUSD(totalFees),
        total_realized_pnl: parseFloat(totalPnl.toFixed(2)),
        total_realized_pnl_formatted: (totalPnl >= 0 ? '+' : '') + formatUSD(totalPnl),
        liquidation_count: liquidationCount,
        liquidation_pct: formatPct(totalFills > 0 ? (liquidationCount / totalFills) * 100 : 0),
        long_short_ratio: longShortRatio,
        long_short_label: longShortRatio > 1.05 ? 'Long-biased' : longShortRatio < 0.95 ? 'Short-biased' : 'Balanced',
        direction_breakdown: dirCounts,
        blocks_analyzed: returnedBlocks,
      }

      if (grouped) {
        response.grouped = grouped
        response.top_count = grouped.length
      }
      if (chunksFetched > 1) response.chunks_fetched = chunksFetched
      if (chunkSizeReduced) response.chunk_size_reduced = true
      if (effectiveFrom > resolvedFromBlock) {
        response._note = `Analyzed the most recent ${maxAggregationBlocks.toLocaleString()} blocks for performance`
      }

      const coinNote = coin ? ` for ${coin.join(', ')}` : ''
      return formatResult(
        response,
        `${totalFills.toLocaleString()} fills${coinNote}: ${traders.size} traders, $${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })} volume`,
        {
          metadata: {
            dataset,
            from_block: effectiveFrom,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
