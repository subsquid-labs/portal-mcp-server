import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { ActionableError } from '../../helpers/errors.js'
import { formatResult } from '../../helpers/format.js'
import { formatUSD, formatNumber, formatPct } from '../../helpers/formatting.js'
import { hashString53 } from '../../helpers/hash.js'
import { buildPaginationInfo, decodeOffsetPageCursor, encodeOffsetPageCursor, paginateOffsetItems } from '../../helpers/pagination.js'
import { buildAnalysisCoverage, buildQueryFreshness, buildRankedOrdering } from '../../helpers/result-metadata.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { visitHyperliquidFillBlocks } from './fill-stream.js'

type HyperliquidAggregateCursorRequest = {
  timeframe?: string
  requested_from_block: number
  requested_to_block: number
  analyzed_from_block: number
  analyzed_to_block: number
  coin?: string[]
  user?: string[]
  dir?: string[]
  group_by: 'coin' | 'user' | 'direction' | 'none'
  limit: number
}

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
        .describe("Dataset name (default: 'hyperliquid-fills'). Optional when continuing with cursor."),
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
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Max grouped rows to return per page (default: 30)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ dataset, timeframe, from_block, to_block, coin, user, dir, group_by, limit, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor =
        cursor ? decodeOffsetPageCursor<HyperliquidAggregateCursorRequest>(cursor, 'portal_aggregate_hyperliquid_fills') : undefined
      const requestedDataset = dataset ? await resolveDataset(dataset) : undefined
      dataset = paginationCursor?.dataset ?? requestedDataset ?? 'hyperliquid-fills'
      if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
        throw new ActionableError('This cursor belongs to a different dataset.', [
          'Reuse the cursor with the same dataset as the previous response.',
          'Omit cursor to start a fresh aggregate query.',
        ], {
          cursor_dataset: paginationCursor.dataset,
          requested_dataset: requestedDataset,
        })
      }

      const freshResolvedWindow = paginationCursor
        ? undefined
        : await resolveTimeframeOrBlocks({
            dataset,
            timeframe,
            from_block,
            to_block,
          })

      const resolvedWindow = paginationCursor
        ? {
            range_kind: paginationCursor.request.timeframe ? 'timeframe' : 'block_range',
          }
        : freshResolvedWindow!

      const requestedFromBlock = paginationCursor?.request.requested_from_block ?? freshResolvedWindow!.from_block
      const { validatedToBlock, head } = paginationCursor
        ? { validatedToBlock: paginationCursor.request.analyzed_to_block, head: { number: paginationCursor.request.requested_to_block } }
        : await validateBlockRange(
            dataset,
            requestedFromBlock,
            freshResolvedWindow?.to_block ?? Number.MAX_SAFE_INTEGER,
            false,
          )
      const endBlock = validatedToBlock

      // Build fill filter
      const request = paginationCursor?.request ?? {
        timeframe,
        requested_from_block: requestedFromBlock,
        requested_to_block: endBlock,
        analyzed_from_block: 0,
        analyzed_to_block: endBlock,
        ...(coin ? { coin } : {}),
        ...(user ? { user: user.map((u) => u.toLowerCase()) } : {}),
        ...(dir ? { dir } : {}),
        group_by,
        limit,
      }
      const fillFilter: Record<string, unknown> = {}
      if (request.coin) fillFilter.coin = request.coin
      if (request.user) fillFilter.user = request.user
      if (request.dir) fillFilter.dir = request.dir

      const requestedBlockRange = endBlock - request.requested_from_block + 1
      const maxAggregationBlocks = 1_000_000
      const effectiveFrom = paginationCursor?.request.analyzed_from_block ??
        (requestedBlockRange > maxAggregationBlocks
          ? endBlock - maxAggregationBlocks + 1
          : request.requested_from_block)
      request.analyzed_from_block = effectiveFrom
      request.analyzed_to_block = endBlock

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
      const byCoin = request.group_by === 'coin'
        ? new Map<string, { fills: number; volume: number; traders: Set<number>; pnl: number }>()
        : undefined
      const byUser = request.group_by === 'user'
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
          .map((item, i) => ({ rank: i + 1, ...item }))
      } else if (request.group_by === 'direction') {
        grouped = Object.entries(dirCounts)
          .map(([direction, count]) => ({ direction, fill_count: count }))
          .sort((a, b) => b.fill_count - a.fill_count)
      }

      const { pageItems, hasMore, nextOffset } = grouped
        ? paginateOffsetItems(grouped, request.limit, paginationCursor?.offset ?? 0)
        : { pageItems: undefined, hasMore: false, nextOffset: undefined }
      const nextCursor = grouped && hasMore
        ? encodeOffsetPageCursor<HyperliquidAggregateCursorRequest>({
            tool: 'portal_aggregate_hyperliquid_fills',
            dataset,
            request,
            offset: nextOffset ?? (paginationCursor?.offset ?? 0) + (pageItems?.length ?? 0),
          })
        : undefined

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
        response.grouped = pageItems
        response.grouped_total = grouped.length
        response.top_count = pageItems?.length ?? 0
      }
      if (chunksFetched > 1) response.chunks_fetched = chunksFetched
      if (chunkSizeReduced) response.chunk_size_reduced = true
      const notices: string[] = []
      if (effectiveFrom > request.requested_from_block) {
        notices.push(`Analyzed the most recent ${maxAggregationBlocks.toLocaleString()} blocks for performance.`)
      }
      if (grouped && hasMore) {
        const pageStart = (paginationCursor?.offset ?? 0) + 1
        const pageEnd = (paginationCursor?.offset ?? 0) + (pageItems?.length ?? 0)
        notices.push(`Showing grouped rows ${pageStart}-${pageEnd}. Use _pagination.next_cursor to continue.`)
      }

      const coinNote = request.coin ? ` for ${request.coin.join(', ')}` : ''
      return formatResult(
        response,
        `${totalFills.toLocaleString()} fills${coinNote}: ${traders.size} traders, $${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })} volume`,
        {
          ...(notices.length > 0 ? { notices } : {}),
          ...(grouped ? { pagination: buildPaginationInfo(request.limit, pageItems?.length ?? 0, nextCursor) } : {}),
          ...(grouped
            ? {
                ordering:
                  request.group_by === 'direction'
                    ? buildRankedOrdering({
                        sortedBy: 'fill_count',
                        direction: 'desc',
                      })
                    : buildRankedOrdering({
                        sortedBy: 'volume_usd',
                        direction: 'desc',
                        rankField: 'rank',
                      }),
              }
            : {}),
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: request.requested_to_block,
            resolvedWindow,
          }),
          coverage: buildAnalysisCoverage({
            windowFromBlock: request.requested_from_block,
            windowToBlock: request.requested_to_block,
            analyzedFromBlock: effectiveFrom,
            analyzedToBlock: endBlock,
            hasMore,
          }),
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
