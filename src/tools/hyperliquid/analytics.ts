import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { buildTableDescriptor } from '../../helpers/chart-metadata.js'
import { ActionableError } from '../../helpers/errors.js'
import { formatResult } from '../../helpers/format.js'
import { formatUSD, formatNumber, formatPct, shortenAddress } from '../../helpers/formatting.js'
import { hashString53 } from '../../helpers/hash.js'
import { buildPaginationInfo, decodeCursor, encodeCursor } from '../../helpers/pagination.js'
import { buildAnalysisCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import type { ResponseFormat } from '../../helpers/response-modes.js'
import { buildPercentileSummary } from '../../helpers/statistics.js'
import { resolveTimeframeOrBlocks, type TimestampInput } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { buildMetricCard, buildPortalUi, buildRankedBarsPanel, buildTablePanel } from '../../helpers/ui-metadata.js'
import { visitHyperliquidFillBlocks } from './fill-stream.js'

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
const DEFAULT_ANALYTICS_SECTION_LIMIT = 6
const MAX_ANALYTICS_BLOCKS = 500000
const FAST_MODE_MAX_ANALYTICS_BLOCKS = 100000
const HYPERLIQUID_ANALYTICS_FAST_INITIAL_CHUNK_SIZE = 20_000
const HYPERLIQUID_ANALYTICS_DEEP_INITIAL_CHUNK_SIZE = 40_000
const HYPERLIQUID_ANALYTICS_CACHE_TTL_MS = 30_000
const HYPERLIQUID_ANALYTICS_CACHE_MAX_ENTRIES = 8

type HyperliquidAnalyticsCursorRequest = {
  timeframe?: string
  mode: 'fast' | 'deep'
  coin?: string[]
  response_format: ResponseFormat
  section_limit?: number
  window_from_block: number
  window_to_block: number
  range_kind: 'timeframe' | 'block_range' | 'timestamp_range'
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
}

type HyperliquidAnalyticsCursor = {
  tool: 'portal_hyperliquid_get_analytics'
  dataset: string
  request: HyperliquidAnalyticsCursorRequest
  offsets: {
    volume_by_coin: number
    top_traders_by_volume: number
    top_pnl_winners: number
    top_pnl_losers: number
  }
}

type CachedHyperliquidAnalyticsResult = {
  key: string
  response: Record<string, any>
  summary: string
  dataset: string
  fromBlock: number
  toBlock: number
  cachedAt: number
}

type PendingHyperliquidAnalyticsResult = Promise<{
  formattedResponse: Record<string, any>
  response: Record<string, any>
  summary: string
  shortSummary: string
  notices?: string[]
  effectiveFrom: number
  hasMoreSections: boolean
}>

const hyperliquidAnalyticsCache = new Map<string, CachedHyperliquidAnalyticsResult>()
const pendingHyperliquidAnalyticsResults = new Map<string, PendingHyperliquidAnalyticsResult>()

function getCachedHyperliquidAnalyticsResult(cacheKey: string): CachedHyperliquidAnalyticsResult | undefined {
  const cached = hyperliquidAnalyticsCache.get(cacheKey)
  if (!cached) return undefined
  if (Date.now() - cached.cachedAt > HYPERLIQUID_ANALYTICS_CACHE_TTL_MS) {
    hyperliquidAnalyticsCache.delete(cacheKey)
    return undefined
  }
  return cached
}

function setCachedHyperliquidAnalyticsResult(
  cacheKey: string,
  result: Omit<CachedHyperliquidAnalyticsResult, 'key' | 'cachedAt'>,
): void {
  hyperliquidAnalyticsCache.set(cacheKey, {
    key: cacheKey,
    cachedAt: Date.now(),
    ...result,
  })

  if (hyperliquidAnalyticsCache.size > HYPERLIQUID_ANALYTICS_CACHE_MAX_ENTRIES) {
    const oldestEntry = Array.from(hyperliquidAnalyticsCache.entries()).reduce<[string, CachedHyperliquidAnalyticsResult] | undefined>(
      (oldest, entry) => {
        if (!oldest || entry[1].cachedAt < oldest[1].cachedAt) return entry
        return oldest
      },
      undefined,
    )
    if (oldestEntry) hyperliquidAnalyticsCache.delete(oldestEntry[0])
  }
}

function paginateSection<T>(items: T[], offset: number, limit: number) {
  const pageItems = items.slice(offset, offset + limit)
  const nextOffset = offset + pageItems.length
  return {
    pageItems,
    hasMore: nextOffset < items.length,
    nextOffset,
  }
}

function formatHyperliquidAnalyticsResponse(response: Record<string, any>, responseFormat: ResponseFormat) {
  const internalFields = {
    ...(response._cache ? { _cache: response._cache } : {}),
    ...(response._chunks_fetched !== undefined ? { _chunks_fetched: response._chunks_fetched } : {}),
    ...(response._chunk_size_reduced !== undefined ? { _chunk_size_reduced: response._chunk_size_reduced } : {}),
  }

  const compactOverview = response.overview
    ? {
        mode: response.overview.mode,
        total_fills: response.overview.total_fills,
        unique_traders: response.overview.unique_traders,
        unique_coins: response.overview.unique_coins,
        total_volume_usd: response.overview.total_volume_usd,
        total_fees_usd: response.overview.total_fees_usd,
        total_realized_pnl: response.overview.total_realized_pnl,
        long_short_ratio: response.overview.long_short_ratio,
        long_short_label: response.overview.long_short_label,
      }
    : undefined

  const compactLiquidations = response.liquidations
    ? {
        count: response.liquidations.count,
        volume_usd: response.liquidations.volume_usd,
        percentage_of_fills: response.liquidations.percentage_of_fills,
      }
    : undefined

  const compactVolumeRows = Array.isArray(response.volume_by_coin)
    ? response.volume_by_coin.map((item: Record<string, any>) => ({
        rank: item.rank,
        coin: item.coin,
        volume_usd: item.volume_usd,
        fill_count: item.fill_count,
        unique_traders: item.unique_traders,
        realized_pnl: item.realized_pnl,
      }))
    : undefined

  const compactTraderRows = Array.isArray(response.top_traders_by_volume)
    ? response.top_traders_by_volume.map((item: Record<string, any>) => ({
        rank: item.rank,
        user: item.user,
        user_short: item.user_short,
        volume_usd: item.volume_usd,
        fill_count: item.fill_count,
        realized_pnl: item.realized_pnl,
      }))
    : undefined

  const compactPnlRows = (rows: unknown) =>
    Array.isArray(rows)
      ? rows.map((item: Record<string, any>) => ({
          rank: item.rank,
          user: item.user,
          user_short: item.user_short,
          realized_pnl: item.realized_pnl,
          volume_usd: item.volume_usd,
        }))
      : undefined

  if (responseFormat === 'full') {
    return response
  }

  if (responseFormat === 'summary') {
    return {
      ...internalFields,
      ...(compactOverview ? { overview: compactOverview } : {}),
      ...(compactLiquidations ? { liquidations: compactLiquidations } : {}),
      ...(compactVolumeRows?.[0] ? { top_coin: compactVolumeRows[0] } : {}),
      ...(compactTraderRows?.[0] ? { top_trader: compactTraderRows[0] } : {}),
    }
  }

  return {
    ...internalFields,
    ...(compactOverview ? { overview: compactOverview } : {}),
    ...(compactLiquidations ? { liquidations: compactLiquidations } : {}),
    ...(compactVolumeRows ? { volume_by_coin: compactVolumeRows } : {}),
    ...(compactTraderRows ? { top_traders_by_volume: compactTraderRows } : {}),
    ...(compactPnlRows(response.top_pnl_winners) ? { top_pnl_winners: compactPnlRows(response.top_pnl_winners) } : {}),
    ...(compactPnlRows(response.top_pnl_losers) ? { top_pnl_losers: compactPnlRows(response.top_pnl_losers) } : {}),
  }
}

function decorateHyperliquidAnalyticsPresentation(response: Record<string, any>) {
  const tables = []

  if (Array.isArray(response.volume_by_coin)) {
    tables.push(buildTableDescriptor({
      id: 'volume_by_coin',
      dataKey: 'volume_by_coin',
      rowCount: response.volume_by_coin.length,
      title: 'Volume by coin',
      subtitle: 'Ranked by notional USD volume',
      keyField: 'coin',
      defaultSort: { key: 'rank', direction: 'asc' },
      dense: true,
      columns: [
        { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
        { key: 'coin', label: 'Coin', kind: 'dimension' },
        { key: 'volume_usd', label: 'Volume', kind: 'metric', format: 'currency_usd', unit: 'USD', align: 'right' },
        { key: 'fill_count', label: 'Fills', kind: 'metric', format: 'integer', align: 'right' },
        { key: 'unique_traders', label: 'Traders', kind: 'metric', format: 'integer', align: 'right' },
      ],
    }))
  }

  if (Array.isArray(response.top_traders_by_volume)) {
    tables.push(buildTableDescriptor({
      id: 'top_traders_by_volume',
      dataKey: 'top_traders_by_volume',
      rowCount: response.top_traders_by_volume.length,
      title: 'Top traders by volume',
      subtitle: 'Ranked by notional USD volume',
      keyField: 'user',
      defaultSort: { key: 'rank', direction: 'asc' },
      dense: true,
      columns: [
        { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
        { key: 'user_short', label: 'Trader', kind: 'dimension' },
        { key: 'volume_usd', label: 'Volume', kind: 'metric', format: 'currency_usd', unit: 'USD', align: 'right' },
        { key: 'fill_count', label: 'Fills', kind: 'metric', format: 'integer', align: 'right' },
        { key: 'realized_pnl', label: 'Realized PnL', kind: 'metric', format: 'currency_usd', unit: 'USD', align: 'right' },
      ],
    }))
  }

  if (Array.isArray(response.top_pnl_winners)) {
    tables.push(buildTableDescriptor({
      id: 'top_pnl_winners',
      dataKey: 'top_pnl_winners',
      rowCount: response.top_pnl_winners.length,
      title: 'Top PnL winners',
      subtitle: 'Highest realized PnL over the selected window',
      keyField: 'user',
      defaultSort: { key: 'rank', direction: 'asc' },
      dense: true,
      columns: [
        { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
        { key: 'user_short', label: 'Trader', kind: 'dimension' },
        { key: 'realized_pnl', label: 'Realized PnL', kind: 'metric', format: 'currency_usd', unit: 'USD', align: 'right' },
        { key: 'volume_usd', label: 'Volume', kind: 'metric', format: 'currency_usd', unit: 'USD', align: 'right' },
      ],
    }))
  }

  if (Array.isArray(response.top_pnl_losers)) {
    tables.push(buildTableDescriptor({
      id: 'top_pnl_losers',
      dataKey: 'top_pnl_losers',
      rowCount: response.top_pnl_losers.length,
      title: 'Top PnL losers',
      subtitle: 'Lowest realized PnL over the selected window',
      keyField: 'user',
      defaultSort: { key: 'rank', direction: 'asc' },
      dense: true,
      columns: [
        { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
        { key: 'user_short', label: 'Trader', kind: 'dimension' },
        { key: 'realized_pnl', label: 'Realized PnL', kind: 'metric', format: 'currency_usd', unit: 'USD', align: 'right' },
        { key: 'volume_usd', label: 'Volume', kind: 'metric', format: 'currency_usd', unit: 'USD', align: 'right' },
      ],
    }))
  }

  const ui = buildPortalUi({
    version: 'portal_ui_v1',
    layout: 'dashboard',
    density: 'compact',
    design_intent: 'analytics_dashboard',
    headline: {
      title: 'Hyperliquid analytics',
      subtitle: 'Cards for the market snapshot plus ranked sections for coins, traders, and realized PnL.',
    },
    metric_cards: [
      buildMetricCard({ id: 'total-fills', label: 'Fills', value_path: 'overview.total_fills', format: 'integer', emphasis: 'primary' }),
      buildMetricCard({ id: 'unique-traders', label: 'Unique traders', value_path: 'overview.unique_traders', format: 'integer' }),
      buildMetricCard({ id: 'total-volume', label: 'Volume', value_path: 'overview.total_volume_usd', format: 'currency_usd', unit: 'USD' }),
      buildMetricCard({ id: 'liquidations', label: 'Liquidations', value_path: 'liquidations.count', format: 'integer' }),
    ],
    panels: [
      ...(Array.isArray(response.volume_by_coin)
        ? [buildRankedBarsPanel({
            id: 'coin-volume-bars',
            kind: 'ranked_bars_panel',
            title: 'Volume by coin',
            subtitle: 'Horizontal ranking by notional USD volume.',
            data_key: 'volume_by_coin',
            category_key: 'coin',
            value_key: 'volume_usd',
            rank_key: 'rank',
            value_format: 'currency_usd',
            unit: 'USD',
            emphasis: 'primary',
          })]
        : []),
      ...(Array.isArray(response.top_traders_by_volume)
        ? [buildRankedBarsPanel({
            id: 'trader-volume-bars',
            kind: 'ranked_bars_panel',
            title: 'Top traders by volume',
            subtitle: 'Traders ranked by notional USD volume.',
            data_key: 'top_traders_by_volume',
            category_key: 'user_short',
            value_key: 'volume_usd',
            rank_key: 'rank',
            value_format: 'currency_usd',
            unit: 'USD',
          })]
        : []),
      ...tables.map((table) => buildTablePanel({
        id: `${table.id}-panel`,
        kind: 'table_panel',
        title: table.title ?? table.id,
        subtitle: table.subtitle,
        table_id: table.id,
      })),
    ],
    follow_up_actions: [
      { label: 'Show ranked rows', intent: 'show_raw', target: 'volume_by_coin' },
      { label: 'Drill into trader rankings', intent: 'drilldown', target: 'top_traders_by_volume' },
    ],
  })

  return {
    response: {
      ...response,
      ...(tables.length > 0 ? { tables } : {}),
    },
    ui,
  }
}

export function registerHyperliquidAnalyticsTool(server: McpServer) {
  server.tool(
    'portal_hyperliquid_get_analytics',
    buildToolDescription('portal_hyperliquid_get_analytics'),
    {
      network: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Network name (default: 'hyperliquid-fills')"),
      timeframe: z
        .string()
        .optional()
        .default('1h')
        .describe("Time range: '1h', '6h', '24h'. Default: '1h'"),
      mode: z
        .enum(['fast', 'deep'])
        .optional()
        .default('fast')
        .describe('fast = lighter scan budget, deep = fuller Hyperliquid window analysis'),
      from_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Natural start time like "6h ago", ISO datetime, or Unix timestamp'),
      to_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Natural end time like "now", ISO datetime, or Unix timestamp'),
      coin: z.array(z.string()).optional().describe('Filter by asset symbols (e.g., ["BTC", "ETH"])'),
      response_format: z
        .enum(['full', 'compact', 'summary'])
        .optional()
        .default('compact')
        .describe("Response format: 'summary' (smallest snapshot), 'compact' (chat-sized ranked sections, default), 'full' (complete analytics)."),
      section_limit: z
        .number()
        .optional()
        .default(DEFAULT_ANALYTICS_SECTION_LIMIT)
        .describe(`Per-section page size for ranked sections. Default: ${DEFAULT_ANALYTICS_SECTION_LIMIT}`),
      cursor: z.string().optional().describe('Continuation cursor for ranked analytics sections'),
    },
    async ({ network, timeframe, mode, from_timestamp, to_timestamp, coin, response_format, section_limit, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor ? decodeCursor<HyperliquidAnalyticsCursor>(cursor, 'portal_hyperliquid_get_analytics') : undefined
      const requestedDataset = network ? await resolveDataset(network) : undefined
      let dataset = paginationCursor?.dataset ?? requestedDataset ?? 'hyperliquid-fills'
      if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
        throw new ActionableError('This cursor belongs to a different dataset.', [
          'Reuse the cursor with the same dataset as the previous response.',
          'Omit cursor to start a fresh Hyperliquid analytics query.',
        ], {
          cursor_dataset: paginationCursor.dataset,
          requested_dataset: requestedDataset,
        })
      }
      if (paginationCursor) {
        timeframe = paginationCursor.request.timeframe ?? timeframe
        mode = paginationCursor.request.mode
        coin = paginationCursor.request.coin
        response_format = paginationCursor.request.response_format
        section_limit = paginationCursor.request.section_limit ?? section_limit
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
      }

      const freshResolvedWindow = paginationCursor
        ? undefined
        : await resolveTimeframeOrBlocks({
            dataset,
            timeframe: from_timestamp === undefined && to_timestamp === undefined ? timeframe : undefined,
            from_timestamp: from_timestamp as TimestampInput | undefined,
            to_timestamp: to_timestamp as TimestampInput | undefined,
          })
      const resolvedWindow = paginationCursor
        ? { range_kind: paginationCursor.request.range_kind }
        : freshResolvedWindow!
      const fromBlock = paginationCursor?.request.window_from_block ?? freshResolvedWindow!.from_block

      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        fromBlock,
        paginationCursor?.request.window_to_block ?? freshResolvedWindow?.to_block ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const fillFilter: Record<string, unknown> = {}
      if (coin) fillFilter.coin = coin

      const requestedBlockRange = endBlock - fromBlock + 1
      const maxAnalyticsBlocks = mode === 'deep' ? MAX_ANALYTICS_BLOCKS : FAST_MODE_MAX_ANALYTICS_BLOCKS
      const effectiveFrom = requestedBlockRange > maxAnalyticsBlocks
        ? endBlock - maxAnalyticsBlocks + 1
        : fromBlock
      const cacheKey = `${dataset}:${mode}:${timeframe ?? ''}:${String(from_timestamp ?? '')}:${String(to_timestamp ?? '')}:${(coin || []).join(',')}:${response_format}:${section_limit ?? ''}`
      const cached = !cursor ? getCachedHyperliquidAnalyticsResult(cacheKey) : undefined

      if (cached) {
        const cachedResponse = JSON.parse(JSON.stringify(cached.response)) as Record<string, any>
        cachedResponse._cache = {
          hit: true,
          age_ms: Date.now() - cached.cachedAt,
        }
        const formattedCachedResponse = formatHyperliquidAnalyticsResponse(cachedResponse, response_format as ResponseFormat)
        const presentation = decorateHyperliquidAnalyticsPresentation(formattedCachedResponse)
        return formatResult(
          presentation.response,
          cached.summary,
          {
            toolName: 'portal_hyperliquid_get_analytics',
            ordering: {
              kind: 'sections',
              volume_by_coin: { order: 'rank_ascending', sorted_by: 'volume_usd', direction: 'desc' },
              top_traders_by_volume: { order: 'rank_ascending', sorted_by: 'volume_usd', direction: 'desc' },
              top_pnl_winners: { order: 'rank_ascending', sorted_by: 'realized_pnl', direction: 'desc' },
              top_pnl_losers: { order: 'rank_ascending', sorted_by: 'realized_pnl', direction: 'asc' },
            },
            pagination: cachedResponse._pagination,
            freshness: buildQueryFreshness({
              finality: 'latest',
              headBlockNumber: head.number,
              windowToBlock: endBlock,
              resolvedWindow,
            }),
            coverage: buildAnalysisCoverage({
              windowFromBlock: fromBlock,
              windowToBlock: endBlock,
              analyzedFromBlock: cached.fromBlock,
              analyzedToBlock: endBlock,
              hasMore: Boolean(cachedResponse._pagination?.has_more),
            }),
            execution: buildExecutionMetadata({
              mode,
              response_format,
              from_block: cached.fromBlock,
              to_block: endBlock,
              range_kind: resolvedWindow.range_kind,
              notes: ['Served from the short-lived Hyperliquid analytics cache.'],
            }),
            ui: presentation.ui,
            llm: {
              answer_sequence: ['overview', 'liquidations', 'volume_by_coin', 'top_traders_by_volume', 'top_pnl_winners', 'top_pnl_losers'],
              parser_notes: [
                'overview is the market snapshot; the ranked sections underneath are already ordered so the first row is the leader for that ranking.',
                'Use volume_by_coin for market structure, top_traders_by_volume for concentration, and the PnL sections for realized winner or loser context.',
              ],
            },
            metadata: {
              dataset: cached.dataset,
              from_block: cached.fromBlock,
              to_block: cached.toBlock,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      const loadFreshAnalytics = async () => {
        // Single-pass aggregation
        const traders = new Set<number>()
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
            traders: Set<number>
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

        const { chunksFetched, chunkSizeReduced } = await visitHyperliquidFillBlocks({
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
          initialChunkSize: Math.min(
            maxAnalyticsBlocks,
            mode === 'deep' ? HYPERLIQUID_ANALYTICS_DEEP_INITIAL_CHUNK_SIZE : HYPERLIQUID_ANALYTICS_FAST_INITIAL_CHUNK_SIZE,
          ),
          maxBytes: 150 * 1024 * 1024,
          concurrency: 2,
          onBlock: (block) => {
            const fills = block.fills || []
            for (let index = 0; index < fills.length; index += 1) {
              const fill = fills[index]
              const userKey = typeof fill.user === 'string' ? fill.user : undefined
              const coinKey = typeof fill.coin === 'string' ? fill.coin : 'unknown'
              const notional = Number(fill.px || 0) * Number(fill.sz || 0)
              const fee = Math.abs(Number(fill.fee || 0))
              const pnl = Number(fill.closedPnl || 0)
              const direction = typeof fill.dir === 'string' ? fill.dir : 'Unknown'
              const isLiquidation = direction === 'Short > Long' || direction === 'Long > Short'

              totalFills += 1
              if (userKey) traders.add(hashString53(userKey))
              if (coinKey) allCoins.add(coinKey)
              totalVolume += notional
              totalFees += fee
              totalPnl += pnl
              if (isLiquidation) {
                liquidationCount += 1
                liquidationVolume += notional
              }
              dirCounts[direction] = (dirCounts[direction] || 0) + 1

              let cd = coinData.get(coinKey)
              if (!cd) {
                cd = { fills: 0, volume: 0, traders: new Set<number>(), pnl: 0, fees: 0, longs: 0, shorts: 0, liquidations: 0, liqVolume: 0 }
                coinData.set(coinKey, cd)
              }
              cd.fills += 1
              cd.volume += notional
              if (userKey) cd.traders.add(hashString53(userKey))
              cd.pnl += pnl
              cd.fees += fee
              if (direction === 'Open Long') cd.longs += 1
              if (direction === 'Open Short') cd.shorts += 1
              if (isLiquidation) {
                cd.liquidations += 1
                cd.liqVolume += notional
              }

              if (userKey) {
                let td = traderData.get(userKey)
                if (!td) {
                  td = { fills: 0, volume: 0, pnl: 0, coins: new Set() }
                  traderData.set(userKey, td)
                }
                td.fills += 1
                td.volume += notional
                td.pnl += pnl
                if (coinKey) td.coins.add(coinKey)
              }
            }
          },
        })

        if (totalFills === 0) {
          throw new Error('No Hyperliquid fills found for the specified filters')
        }

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
          .map((item, i) => ({
            rank: i + 1,
            ...item,
            volume_formatted: formatUSD(item.volume_usd),
            market_share: formatPct((item.volume_usd / totalVolume) * 100),
            pnl_formatted: (item.realized_pnl >= 0 ? '+' : '') + formatUSD(item.realized_pnl),
          }))

        const topTraders = Array.from(traderData.entries())
          .map(([user, d]) => ({
            user,
            fill_count: d.fills,
            volume_usd: parseFloat(d.volume.toFixed(2)),
            realized_pnl: parseFloat(d.pnl.toFixed(2)),
            coins_traded: d.coins.size,
          }))
          .sort((a, b) => b.volume_usd - a.volume_usd)
          .map((item, i) => ({
            rank: i + 1,
            ...item,
            user_short: shortenAddress(item.user),
            volume_formatted: formatUSD(item.volume_usd),
            pnl_formatted: (item.realized_pnl >= 0 ? '+' : '') + formatUSD(item.realized_pnl),
          }))

        const topWinners = Array.from(traderData.entries())
          .map(([user, d]) => ({ user, realized_pnl: parseFloat(d.pnl.toFixed(2)), volume_usd: parseFloat(d.volume.toFixed(2)) }))
          .sort((a, b) => b.realized_pnl - a.realized_pnl)
          .map((item, i) => ({
            rank: i + 1,
            ...item,
            user_short: shortenAddress(item.user),
            pnl_formatted: '+' + formatUSD(item.realized_pnl),
          }))

        const topLosers = Array.from(traderData.entries())
          .map(([user, d]) => ({ user, realized_pnl: parseFloat(d.pnl.toFixed(2)), volume_usd: parseFloat(d.volume.toFixed(2)) }))
          .sort((a, b) => a.realized_pnl - b.realized_pnl)
          .map((item, i) => ({
            rank: i + 1,
            ...item,
            user_short: shortenAddress(item.user),
            pnl_formatted: formatUSD(item.realized_pnl),
          }))

        const volumePageSize = Math.min(section_limit ?? MAX_VOLUME_COINS, MAX_VOLUME_COINS)
        const traderPageSize = Math.min(section_limit ?? MAX_TOP_TRADERS, MAX_TOP_TRADERS)
        const pnlPageSize = Math.min(section_limit ?? MAX_TOP_PNL, MAX_TOP_PNL)
        const offsets = paginationCursor?.offsets ?? {
          volume_by_coin: 0,
          top_traders_by_volume: 0,
          top_pnl_winners: 0,
          top_pnl_losers: 0,
        }
        const volumePage = paginateSection(volumeByCoin, offsets.volume_by_coin, volumePageSize)
        const traderPage = paginateSection(topTraders, offsets.top_traders_by_volume, traderPageSize)
        const winnerPage = paginateSection(topWinners, offsets.top_pnl_winners, pnlPageSize)
        const loserPage = paginateSection(topLosers, offsets.top_pnl_losers, pnlPageSize)
        const hasMoreSections = volumePage.hasMore || traderPage.hasMore || winnerPage.hasMore || loserPage.hasMore
        const nextCursor = hasMoreSections
          ? encodeCursor({
              tool: 'portal_hyperliquid_get_analytics',
              dataset,
              request: {
                timeframe,
                mode,
                ...(coin ? { coin } : {}),
                response_format: response_format as ResponseFormat,
                ...(section_limit !== undefined ? { section_limit } : {}),
                window_from_block: fromBlock,
                window_to_block: endBlock,
                range_kind: resolvedWindow.range_kind,
                ...(from_timestamp !== undefined ? { from_timestamp: from_timestamp as TimestampInput } : {}),
                ...(to_timestamp !== undefined ? { to_timestamp: to_timestamp as TimestampInput } : {}),
              },
              offsets: {
                volume_by_coin: volumePage.nextOffset,
                top_traders_by_volume: traderPage.nextOffset,
                top_pnl_winners: winnerPage.nextOffset,
                top_pnl_losers: loserPage.nextOffset,
              },
            } satisfies HyperliquidAnalyticsCursor)
          : undefined

        const openLongs = dirCounts['Open Long'] || 0
        const openShorts = dirCounts['Open Short'] || 0
        const lsRatio = openShorts > 0 ? openLongs / openShorts : 0

        const response: any = {
          overview: {
            mode,
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
          percentiles: {
            coin_volume_usd: buildPercentileSummary(volumeByCoin.map((item) => item.volume_usd)),
            trader_volume_usd: buildPercentileSummary(topTraders.map((item) => item.volume_usd)),
            trader_realized_pnl_usd: buildPercentileSummary(Array.from(traderData.values()).map((item) => item.pnl)),
          },
          liquidations: {
            count: liquidationCount,
            count_formatted: formatNumber(liquidationCount),
            volume_usd: parseFloat(liquidationVolume.toFixed(2)),
            volume_formatted: formatUSD(liquidationVolume),
            percentage_of_fills: formatPct((liquidationCount / totalFills) * 100),
          },
          volume_by_coin: volumePage.pageItems,
          top_traders_by_volume: traderPage.pageItems,
          top_pnl_winners: winnerPage.pageItems,
          top_pnl_losers: loserPage.pageItems,
        }

        const notices =
          effectiveFrom > fromBlock
            ? [`${mode === 'fast' ? 'Fast' : 'Deep'} mode analyzed the most recent ${maxAnalyticsBlocks.toLocaleString()} blocks for performance.`]
            : undefined
        if (chunksFetched > 1) response._chunks_fetched = chunksFetched
        if (chunkSizeReduced) response._chunk_size_reduced = true
        response._pagination = {
          ...buildPaginationInfo(
            Math.max(volumePageSize, traderPageSize, pnlPageSize),
            (response.volume_by_coin?.length ?? 0) + (response.top_traders_by_volume?.length ?? 0) + (response.top_pnl_winners?.length ?? 0) + (response.top_pnl_losers?.length ?? 0),
            nextCursor,
          ),
          sections: {
            volume_by_coin: { returned: response.volume_by_coin.length, has_more: volumePage.hasMore },
            top_traders_by_volume: { returned: response.top_traders_by_volume.length, has_more: traderPage.hasMore },
            top_pnl_winners: { returned: response.top_pnl_winners.length, has_more: winnerPage.hasMore },
            top_pnl_losers: { returned: response.top_pnl_losers.length, has_more: loserPage.hasMore },
          },
        }

        const formattedResponse = formatHyperliquidAnalyticsResponse(response, response_format as ResponseFormat)
        const summary = `Hyperliquid analytics${coin ? ` for ${coin.join(', ')}` : ''}: ${totalFills.toLocaleString()} fills, ${traders.size} traders, $${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })} volume, ${liquidationCount} liquidations`
        if (!cursor) {
          setCachedHyperliquidAnalyticsResult(cacheKey, {
            response: JSON.parse(JSON.stringify(response)) as Record<string, any>,
            summary,
            dataset,
            fromBlock: effectiveFrom,
            toBlock: endBlock,
          })
        }

        return {
          formattedResponse,
          response,
          summary,
          shortSummary: `Hyperliquid summary: ${totalFills.toLocaleString()} fills, ${traders.size} traders, $${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })} volume`,
          notices,
          effectiveFrom,
          hasMoreSections,
        }
      }

      const pending = !cursor ? pendingHyperliquidAnalyticsResults.get(cacheKey) : undefined
      const analyticsResult = pending ?? loadFreshAnalytics()
      if (!pending && !cursor) {
        pendingHyperliquidAnalyticsResults.set(cacheKey, analyticsResult)
      }

      let freshAnalytics
      try {
        freshAnalytics = await analyticsResult
      } finally {
        if (!pending && !cursor) {
          pendingHyperliquidAnalyticsResults.delete(cacheKey)
        }
      }

      return formatResult(
        decorateHyperliquidAnalyticsPresentation(freshAnalytics.formattedResponse).response,
        response_format === 'summary' ? freshAnalytics.shortSummary : freshAnalytics.summary,
        {
          toolName: 'portal_hyperliquid_get_analytics',
          notices: freshAnalytics.notices,
          pagination: freshAnalytics.response._pagination,
          ordering: {
            kind: 'sections',
            volume_by_coin: { order: 'rank_ascending', sorted_by: 'volume_usd', direction: 'desc' },
            top_traders_by_volume: { order: 'rank_ascending', sorted_by: 'volume_usd', direction: 'desc' },
            top_pnl_winners: { order: 'rank_ascending', sorted_by: 'realized_pnl', direction: 'desc' },
            top_pnl_losers: { order: 'rank_ascending', sorted_by: 'realized_pnl', direction: 'asc' },
          },
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: endBlock,
            resolvedWindow,
          }),
          coverage: buildAnalysisCoverage({
            windowFromBlock: fromBlock,
            windowToBlock: endBlock,
            analyzedFromBlock: freshAnalytics.effectiveFrom,
            analyzedToBlock: endBlock,
            hasMore: freshAnalytics.hasMoreSections,
          }),
          execution: buildExecutionMetadata({
            mode,
            response_format,
            from_block: freshAnalytics.effectiveFrom,
            to_block: endBlock,
            range_kind: resolvedWindow.range_kind,
            notes: [coin?.length ? `Coin filter active for ${coin.join(', ')}.` : 'Network-wide Hyperliquid fill analytics.'],
          }),
          ui: decorateHyperliquidAnalyticsPresentation(freshAnalytics.formattedResponse).ui,
          llm: {
            answer_sequence: ['overview', 'liquidations', 'volume_by_coin', 'top_traders_by_volume', 'top_pnl_winners', 'top_pnl_losers'],
            parser_notes: [
              'overview is the market snapshot; the ranked sections underneath are already ordered so the first row is the leader for that ranking.',
              'Use volume_by_coin for market structure, top_traders_by_volume for concentration, and the PnL sections for realized winner or loser context.',
            ],
          },
          metadata: {
            dataset,
            from_block: freshAnalytics.effectiveFrom,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
