import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatUSD, formatNumber, formatPct } from '../../helpers/formatting.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

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

      const query = {
        type: 'hyperliquidFills',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          fill: {
            user: true,
            coin: true,
            px: true,
            sz: true,
            side: true,
            dir: true,
            fee: true,
            closedPnl: true,
            feeToken: true,
          },
        },
        fills: [fillFilter],
      }

      // Cap streaming to avoid OOM — HL blocks are ~0.083s, 500k ≈ ~12h
      const blockRange = endBlock - resolvedFromBlock
      const maxBlocks = Math.min(blockRange, 500000)
      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
        undefined,
        maxBlocks,
        100 * 1024 * 1024,
      )
      const wasPartial = blockRange > 500000

      // Extract all fills
      const allFills = results.flatMap((block: any) =>
        (block.fills || []).map((fill: any) => ({
          ...fill,
          block_timestamp: block.header?.timestamp,
        })),
      )

      // Compute aggregates
      const traders = new Set<string>()
      const coins = new Set<string>()
      let totalVolume = 0
      let totalFees = 0
      let totalPnl = 0
      const dirCounts: Record<string, number> = {}

      allFills.forEach((fill: any) => {
        if (fill.user) traders.add(fill.user)
        if (fill.coin) coins.add(fill.coin)

        const notional = (fill.px || 0) * (fill.sz || 0)
        totalVolume += notional
        totalFees += Math.abs(fill.fee || 0)
        totalPnl += fill.closedPnl || 0

        const direction = fill.dir || 'Unknown'
        dirCounts[direction] = (dirCounts[direction] || 0) + 1
      })

      // Group if requested
      let grouped: any[] | undefined

      if (group_by === 'coin') {
        const byCoin = new Map<string, { fills: number; volume: number; traders: Set<string>; pnl: number }>()
        allFills.forEach((fill: any) => {
          const c = fill.coin || 'unknown'
          const existing = byCoin.get(c) || { fills: 0, volume: 0, traders: new Set<string>(), pnl: 0 }
          existing.fills++
          existing.volume += (fill.px || 0) * (fill.sz || 0)
          if (fill.user) existing.traders.add(fill.user)
          existing.pnl += fill.closedPnl || 0
          byCoin.set(c, existing)
        })

        grouped = Array.from(byCoin.entries())
          .map(([c, data]) => ({
            coin: c,
            fill_count: data.fills,
            unique_traders: data.traders.size,
            volume_usd: parseFloat(data.volume.toFixed(2)),
            volume_formatted: formatUSD(data.volume),
            market_share_pct: formatPct((data.volume / totalVolume) * 100),
            realized_pnl: parseFloat(data.pnl.toFixed(2)),
            realized_pnl_formatted: (data.pnl >= 0 ? '+' : '') + formatUSD(data.pnl),
          }))
          .sort((a, b) => b.volume_usd - a.volume_usd)
          .slice(0, 30)
          .map((item, i) => ({ rank: i + 1, ...item }))
      } else if (group_by === 'user') {
        const byUser = new Map<string, { fills: number; volume: number; coins: Set<string>; pnl: number }>()
        allFills.forEach((fill: any) => {
          const u = fill.user || 'unknown'
          const existing = byUser.get(u) || { fills: 0, volume: 0, coins: new Set<string>(), pnl: 0 }
          existing.fills++
          existing.volume += (fill.px || 0) * (fill.sz || 0)
          if (fill.coin) existing.coins.add(fill.coin)
          existing.pnl += fill.closedPnl || 0
          byUser.set(u, existing)
        })

        grouped = Array.from(byUser.entries())
          .map(([u, data]) => ({
            user: u,
            fill_count: data.fills,
            coins_traded: data.coins.size,
            volume_usd: parseFloat(data.volume.toFixed(2)),
            volume_formatted: formatUSD(data.volume),
            market_share_pct: formatPct((data.volume / totalVolume) * 100),
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
        total_fills: allFills.length,
        total_fills_formatted: formatNumber(allFills.length),
        unique_traders: traders.size,
        unique_coins: coins.size,
        total_volume_usd: parseFloat(totalVolume.toFixed(2)),
        total_volume_formatted: formatUSD(totalVolume),
        total_fees_usd: parseFloat(totalFees.toFixed(2)),
        total_fees_formatted: formatUSD(totalFees),
        total_realized_pnl: parseFloat(totalPnl.toFixed(2)),
        total_realized_pnl_formatted: (totalPnl >= 0 ? '+' : '') + formatUSD(totalPnl),
        liquidation_count: liquidationCount,
        liquidation_pct: formatPct((liquidationCount / allFills.length) * 100),
        long_short_ratio: longShortRatio,
        long_short_label: longShortRatio > 1.05 ? 'Long-biased' : longShortRatio < 0.95 ? 'Short-biased' : 'Balanced',
        direction_breakdown: dirCounts,
        blocks_analyzed: results.length,
      }

      if (grouped) {
        response.grouped = grouped
        response.top_count = grouped.length
      }

      if (wasPartial) {
        response.partial = true
        response.blocks_capped = maxBlocks
        response.total_requested_blocks = blockRange
      }

      const coinNote = coin ? ` for ${coin.join(', ')}` : ''
      const partialNote = wasPartial ? ` (partial: ${results.length}/${blockRange} blocks)` : ''
      return formatResult(
        response,
        `${allFills.length.toLocaleString()} fills${coinNote}: ${traders.size} traders, $${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })} volume${partialNote}`,
        {
          metadata: {
            dataset,
            from_block: resolvedFromBlock,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
