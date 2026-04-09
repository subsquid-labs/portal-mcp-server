import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatUSD, formatNumber, formatPct, shortenAddress } from '../../helpers/formatting.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Hyperliquid Analytics Dashboard
// ============================================================================

function toSeconds(ts: number): number {
  if (ts > 1e12) return Math.floor(ts / 1000)
  return ts
}

const TOP_COINS = ['BTC', 'ETH', 'SOL', 'HYPE']
const MAX_VOLUME_COINS = 12
const MAX_TOP_TRADERS = 8
const MAX_TOP_PNL = 5

export function registerHyperliquidAnalyticsTool(server: McpServer) {
  server.tool(
    'portal_hyperliquid_analytics',
    `Comprehensive Hyperliquid trading analytics dashboard. Returns volume breakdown by coin, trader activity, PnL summary, liquidation stats, and long/short ratios — all in one call.

WHEN TO USE:
- "How's Hyperliquid doing today?"
- "Hyperliquid trading summary"
- "What's the most traded coin on Hyperliquid?"
- "Show me Hyperliquid liquidations"
- "Hyperliquid long/short ratio"
- "Top traders on Hyperliquid"

EXAMPLES:
- Quick snapshot: { timeframe: "1h" }
- Daily summary: { timeframe: "24h" }
- BTC focus: { timeframe: "6h", coin: ["BTC"] }`,
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Dataset name (default: 'hyperliquid-fills')"),
      timeframe: z
        .string()
        .optional()
        .default('1h')
        .describe("Time range: '1h', '6h', '24h'. Default: '1h'"),
      coin: z.array(z.string()).optional().describe('Filter by asset symbols (e.g., ["BTC", "ETH"])'),
    },
    async ({ dataset, timeframe, coin }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)

      const { from_block: fromBlock, to_block: toBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        fromBlock,
        toBlock ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const fillFilter: Record<string, unknown> = {}
      if (coin) fillFilter.coin = coin

      const query = {
        type: 'hyperliquidFills',
        fromBlock,
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
          },
        },
        fills: [fillFilter],
      }

      const blockRange = endBlock - fromBlock
      const maxBlocks = Math.min(blockRange, 500000)
      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
        undefined,
        maxBlocks,
        200 * 1024 * 1024,
      )

      // Single-pass aggregation
      const traders = new Set<string>()
      const allCoins = new Set<string>()
      let totalVolume = 0
      let totalFees = 0
      let totalPnl = 0
      let totalFills = 0
      let liquidationCount = 0
      let liquidationVolume = 0
      const dirCounts: Record<string, number> = {}

      // Per-coin tracking
      const coinData = new Map<
        string,
        {
          fills: number
          volume: number
          traders: Set<string>
          pnl: number
          fees: number
          longs: number
          shorts: number
          liquidations: number
          liqVolume: number
        }
      >()

      // Per-trader tracking (for top traders)
      const traderData = new Map<
        string,
        { fills: number; volume: number; pnl: number; coins: Set<string> }
      >()

      results.forEach((block: any) => {
        ;(block.fills || []).forEach((fill: any) => {
          totalFills++
          const notional = (fill.px || 0) * (fill.sz || 0)
          const isLiquidation = fill.dir === 'Short > Long' || fill.dir === 'Long > Short'

          if (fill.user) traders.add(fill.user)
          if (fill.coin) allCoins.add(fill.coin)
          totalVolume += notional
          totalFees += Math.abs(fill.fee || 0)
          totalPnl += fill.closedPnl || 0
          if (isLiquidation) {
            liquidationCount++
            liquidationVolume += notional
          }

          const direction = fill.dir || 'Unknown'
          dirCounts[direction] = (dirCounts[direction] || 0) + 1

          // Per-coin
          const c = fill.coin || 'unknown'
          let cd = coinData.get(c)
          if (!cd) {
            cd = { fills: 0, volume: 0, traders: new Set(), pnl: 0, fees: 0, longs: 0, shorts: 0, liquidations: 0, liqVolume: 0 }
            coinData.set(c, cd)
          }
          cd.fills++
          cd.volume += notional
          if (fill.user) cd.traders.add(fill.user)
          cd.pnl += fill.closedPnl || 0
          cd.fees += Math.abs(fill.fee || 0)
          if (fill.dir === 'Open Long') cd.longs++
          if (fill.dir === 'Open Short') cd.shorts++
          if (isLiquidation) {
            cd.liquidations++
            cd.liqVolume += notional
          }

          // Per-trader
          if (fill.user) {
            let td = traderData.get(fill.user)
            if (!td) {
              td = { fills: 0, volume: 0, pnl: 0, coins: new Set() }
              traderData.set(fill.user, td)
            }
            td.fills++
            td.volume += notional
            td.pnl += fill.closedPnl || 0
            if (fill.coin) td.coins.add(fill.coin)
          }
        })
      })

      // Build volume by coin (top coins + others)
      const volumeByCoin = Array.from(coinData.entries())
        .map(([c, d]) => ({
          coin: c,
          fill_count: d.fills,
          volume_usd: parseFloat(d.volume.toFixed(2)),
          unique_traders: d.traders.size,
          realized_pnl: parseFloat(d.pnl.toFixed(2)),
          fees_usd: parseFloat(d.fees.toFixed(2)),
          long_short_ratio: d.shorts > 0 ? parseFloat((d.longs / d.shorts).toFixed(3)) : d.longs > 0 ? Infinity : 0,
          liquidation_count: d.liquidations,
          liquidation_volume_usd: parseFloat(d.liqVolume.toFixed(2)),
        }))
        .sort((a, b) => b.volume_usd - a.volume_usd)
        .slice(0, MAX_VOLUME_COINS)

      // Top traders by volume
      const topTraders = Array.from(traderData.entries())
        .map(([user, d]) => ({
          user,
          fill_count: d.fills,
          volume_usd: parseFloat(d.volume.toFixed(2)),
          realized_pnl: parseFloat(d.pnl.toFixed(2)),
          coins_traded: d.coins.size,
        }))
        .sort((a, b) => b.volume_usd - a.volume_usd)
        .slice(0, MAX_TOP_TRADERS)

      // Top PnL winners & losers
      const topWinners = Array.from(traderData.entries())
        .map(([user, d]) => ({ user, realized_pnl: parseFloat(d.pnl.toFixed(2)), volume_usd: parseFloat(d.volume.toFixed(2)) }))
        .sort((a, b) => b.realized_pnl - a.realized_pnl)
        .slice(0, MAX_TOP_PNL)

      const topLosers = Array.from(traderData.entries())
        .map(([user, d]) => ({ user, realized_pnl: parseFloat(d.pnl.toFixed(2)), volume_usd: parseFloat(d.volume.toFixed(2)) }))
        .sort((a, b) => a.realized_pnl - b.realized_pnl)
        .slice(0, MAX_TOP_PNL)

      const openLongs = dirCounts['Open Long'] || 0
      const openShorts = dirCounts['Open Short'] || 0
      const wasPartial = blockRange > 500000

      const lsRatio = openShorts > 0 ? openLongs / openShorts : 0

      const response: any = {
        overview: {
          total_fills: totalFills,
          total_fills_formatted: formatNumber(totalFills),
          unique_traders: traders.size,
          unique_traders_formatted: formatNumber(traders.size),
          unique_coins: allCoins.size,
          total_volume_usd: parseFloat(totalVolume.toFixed(2)),
          total_volume_formatted: formatUSD(totalVolume),
          total_fees_usd: parseFloat(totalFees.toFixed(2)),
          total_fees_formatted: formatUSD(totalFees),
          total_realized_pnl: parseFloat(totalPnl.toFixed(2)),
          total_pnl_formatted: (totalPnl >= 0 ? '+' : '') + formatUSD(totalPnl),
          long_short_ratio: parseFloat(lsRatio.toFixed(3)),
          long_short_label: lsRatio > 1.05 ? 'Long-biased' : lsRatio < 0.95 ? 'Short-biased' : 'Balanced',
          direction_breakdown: dirCounts,
        },
        liquidations: {
          count: liquidationCount,
          count_formatted: formatNumber(liquidationCount),
          volume_usd: parseFloat(liquidationVolume.toFixed(2)),
          volume_formatted: formatUSD(liquidationVolume),
          percentage_of_fills: formatPct((liquidationCount / totalFills) * 100),
        },
        volume_by_coin: volumeByCoin.map((item, i) => ({
          rank: i + 1,
          ...item,
          volume_formatted: formatUSD(item.volume_usd),
          market_share: formatPct((item.volume_usd / totalVolume) * 100),
          pnl_formatted: (item.realized_pnl >= 0 ? '+' : '') + formatUSD(item.realized_pnl),
        })),
        top_traders_by_volume: topTraders.map((item, i) => ({
          rank: i + 1,
          ...item,
          user_short: shortenAddress(item.user),
          volume_formatted: formatUSD(item.volume_usd),
          pnl_formatted: (item.realized_pnl >= 0 ? '+' : '') + formatUSD(item.realized_pnl),
        })),
        top_pnl_winners: topWinners.map((item, i) => ({
          rank: i + 1,
          ...item,
          user_short: shortenAddress(item.user),
          pnl_formatted: '+' + formatUSD(item.realized_pnl),
        })),
        top_pnl_losers: topLosers.map((item, i) => ({
          rank: i + 1,
          ...item,
          user_short: shortenAddress(item.user),
          pnl_formatted: formatUSD(item.realized_pnl),
        })),
      }

      if (wasPartial) {
        response._note = 'Data capped at ~12h of blocks for performance'
      }

      const coinNote = coin ? ` for ${coin.join(', ')}` : ''
      return formatResult(
        response,
        `Hyperliquid analytics${coinNote}: ${totalFills.toLocaleString()} fills, ${traders.size} traders, $${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })} volume, ${liquidationCount} liquidations`,
        {
          metadata: {
            dataset,
            from_block: fromBlock,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
