import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeHyperliquidFillResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { applyResponseFormat, type ResponseFormat } from '../../helpers/response-modes.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'

// ============================================================================
// Tool: Query Hyperliquid Fills
// ============================================================================

type HyperliquidFillsRequest = {
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  limit: number
  finalized_only: boolean
  user?: string[]
  coin?: string[]
  dir?: string[]
  builder?: string[]
  fee_token?: string[]
  cloid?: string[]
  include_pnl: boolean
  include_builder_info: boolean
  response_format: ResponseFormat
}

type HyperliquidFillItem = Record<string, unknown> & {
  block_number?: number
  fillIndex?: number
  hash?: string
}

function getBlockNumber(item: HyperliquidFillItem): number | undefined {
  return typeof item.block_number === 'number' ? item.block_number : undefined
}

function getFillIndex(item: HyperliquidFillItem): number {
  if (typeof item.fillIndex === 'number') return item.fillIndex
  if (typeof item.fillIndex === 'string') {
    const parsed = Number(item.fillIndex)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function sortFills(items: HyperliquidFillItem[]) {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) return leftBlock - rightBlock

    const leftIndex = getFillIndex(left)
    const rightIndex = getFillIndex(right)
    if (leftIndex !== rightIndex) return leftIndex - rightIndex

    return String(left.hash ?? '').localeCompare(String(right.hash ?? ''))
  })
}

export function registerQueryHyperliquidFillsTool(server: McpServer) {
  server.tool(
    'portal_hyperliquid_query_fills',
    buildToolDescription('portal_hyperliquid_query_fills'),
    {
      network: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Network name (default: 'hyperliquid-fills'). Optional when continuing with cursor."),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block number'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      user: z.array(z.string()).optional().describe('Trader wallet addresses (0x-prefixed, lowercase)'),
      coin: z.array(z.string()).optional().describe('Asset symbols (e.g., "ETH", "BTC", "SOL")'),
      dir: z.array(z.string()).optional().describe('Trade direction: "Open Long", "Close Long", "Open Short", "Close Short"'),
      builder: z.array(z.string()).optional().describe('Builder addresses (0x-prefixed, lowercase)'),
      fee_token: z.array(z.string()).optional().describe('Fee token symbols'),
      cloid: z.array(z.string()).optional().describe('Client order IDs (0x-prefixed hex)'),
      limit: z.number().optional().default(50).describe('Max fills to return'),
      include_pnl: z.boolean().optional().default(true).describe('Include closedPnl and startPosition fields'),
      include_builder_info: z.boolean().optional().default(false).describe('Include builder and builderFee fields'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().default('full').describe("Response format: 'summary' (aggregated stats, ~90% smaller), 'compact' (essential trade fields only, ~60% smaller), 'full' (all fields)"),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({
      network,
      timeframe,
      from_block,
      to_block,
      from_timestamp,
      to_timestamp,
      finalized_only,
      user,
      coin,
      dir,
      builder,
      fee_token,
      cloid,
      limit,
      include_pnl,
      include_builder_info,
      response_format,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<HyperliquidFillsRequest>(cursor, 'portal_hyperliquid_query_fills')
        : undefined
      let dataset = paginationCursor?.dataset ?? (network ? await resolveDataset(network) : 'hyperliquid-fills')
      if (paginationCursor) {
        dataset = paginationCursor.dataset
        timeframe = paginationCursor.request.timeframe
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
        limit = paginationCursor.request.limit
        finalized_only = paginationCursor.request.finalized_only
        user = paginationCursor.request.user
        coin = paginationCursor.request.coin
        dir = paginationCursor.request.dir
        builder = paginationCursor.request.builder
        fee_token = paginationCursor.request.fee_token
        cloid = paginationCursor.request.cloid
        include_pnl = paginationCursor.request.include_pnl
        include_builder_info = paginationCursor.request.include_builder_info
        response_format = paginationCursor.request.response_format
      }

      // Resolve timeframe or use explicit blocks
      const resolvedBlocks = paginationCursor
        ? {
            from_block: paginationCursor.window_from_block,
            to_block: paginationCursor.window_to_block,
            range_kind:
              paginationCursor.request.from_timestamp !== undefined || paginationCursor.request.to_timestamp !== undefined
                ? 'timestamp_range'
                : paginationCursor.request.timeframe
                  ? 'timeframe'
                  : 'block_range',
          }
        : await resolveTimeframeOrBlocks({
            dataset,
            timeframe,
            from_block,
            to_block,
            from_timestamp,
            to_timestamp,
          })
      const resolvedFromBlock = resolvedBlocks.from_block
      const resolvedToBlock = resolvedBlocks.to_block

      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock

      // Build fill filter
      const fillFilter: Record<string, unknown> = {}
      if (user) fillFilter.user = user.map((u) => u.toLowerCase())
      if (coin) fillFilter.coin = coin
      if (dir) fillFilter.dir = dir
      if (builder) fillFilter.builder = builder.map((b) => b.toLowerCase())
      if (fee_token) fillFilter.feeToken = fee_token
      if (cloid) fillFilter.cloid = cloid

      // Build field selection
      const fillFields: Record<string, boolean> = {
        fillIndex: true,
        user: true,
        coin: true,
        px: true,
        sz: true,
        side: true,
        dir: true,
        fee: true,
        oid: true,
        time: true,
        tid: true,
        crossed: true,
        hash: true,
        cloid: true,
        feeToken: true,
      }

      if (include_pnl) {
        fillFields.closedPnl = true
        fillFields.startPosition = true
      }

      if (include_builder_info) {
        fillFields.builderFee = true
        fillFields.builder = true
        fillFields.twapId = true
      }

      const query = {
        type: 'hyperliquidFills',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields: {
          block: { number: true, timestamp: true },
          fill: fillFields,
        },
        fills: [fillFilter],
      }

      const hasFilters = !!(user || coin || dir || builder || fee_token || cloid)
      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['fills'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 40_000 : 5_000,
        maxBytes: 100 * 1024 * 1024,
      })

      const allFills = sortFills(
        results.flatMap((block: unknown) => {
          const b = block as {
            header?: { number: number; timestamp: number }
            fills?: Array<Record<string, unknown>>
          }
          return (b.fills || []).map((fill) =>
            normalizeHyperliquidFillResult({
              ...fill,
              ...(b.header?.number !== undefined ? { block_number: b.header.number } : {}),
              ...(b.header?.timestamp !== undefined ? { block_timestamp: b.header.timestamp } : {}),
            }),
          )
        }) as HyperliquidFillItem[],
      )
      const page = paginateAscendingItems(
        allFills,
        limit,
        getBlockNumber,
        paginationCursor
          ? {
              page_to_block: paginationCursor.page_to_block,
              skip_inclusive_block: paginationCursor.skip_inclusive_block,
            }
          : undefined,
      )
      const nextCursor = page.hasMore && page.nextBoundary
        ? encodeRecentPageCursor<HyperliquidFillsRequest>({
            tool: 'portal_hyperliquid_query_fills',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(user ? { user } : {}),
              ...(coin ? { coin } : {}),
              ...(dir ? { dir } : {}),
              ...(builder ? { builder } : {}),
              ...(fee_token ? { fee_token } : {}),
              ...(cloid ? { cloid } : {}),
              include_pnl,
              include_builder_info,
              response_format: response_format as ResponseFormat,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined

      const formattedData = applyResponseFormat(page.pageItems, response_format as ResponseFormat, 'hyperliquid_fills')
      const notices = getTimestampWindowNotices(resolvedBlocks)
      if (nextCursor) notices.push('Older results are available via _pagination.next_cursor.')
      const freshness = buildQueryFreshness({
        finality: finalized_only ? 'finalized' : 'latest',
        headBlockNumber: head.number,
        windowToBlock: endBlock,
        resolvedWindow: resolvedBlocks,
      })
      const coverage = buildQueryCoverage({
        windowFromBlock: resolvedFromBlock,
        windowToBlock: endBlock,
        pageToBlock,
        items: page.pageItems,
        getBlockNumber,
        hasMore: page.hasMore,
      })

      return formatResult(
        formattedData,
        `Retrieved ${page.pageItems.length} Hyperliquid fills${page.hasMore ? ` from the most recent matching range (preview page limited to ${limit})` : ''}`,
        {
          toolName: 'portal_hyperliquid_query_fills',
          notices,
          pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
          ordering: buildChronologicalPageOrdering({
            sortedBy: 'block_number',
            tieBreakers: ['time', 'coin', 'user'],
          }),
          freshness,
          coverage,
          execution: buildExecutionMetadata({
            response_format,
            finalized_only,
            limit,
            from_block: resolvedFromBlock,
            to_block: endBlock,
            page_to_block: pageToBlock,
            range_kind: resolvedBlocks.range_kind,
            normalized_output: true,
            notes: [
              include_pnl || include_builder_info
                ? 'Additional fill context was requested with include flags.'
                : 'Using the lightweight fill view.',
            ],
          }),
          metadata: {
            network: dataset,
            dataset,
            from_block: resolvedFromBlock,
            to_block: pageToBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
