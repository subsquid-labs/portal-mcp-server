import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Query Hyperliquid Replica Commands
// ============================================================================

type HyperliquidReplicaRequest = {
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  limit: number
  finalized_only: boolean
  action_type?: Array<'order' | 'cancel' | 'cancelByCloid' | 'batchModify' | 'transfer' | 'withdraw' | 'updateLeverage'>
  user?: string[]
  vault_address?: string[]
  status?: 'ok' | 'err'
}

type HyperliquidActionItem = Record<string, unknown> & {
  block_number?: number
  actionIndex?: number
}

function getBlockNumber(item: HyperliquidActionItem): number | undefined {
  return typeof item.block_number === 'number' ? item.block_number : undefined
}

function getActionIndex(item: HyperliquidActionItem): number {
  if (typeof item.actionIndex === 'number') return item.actionIndex
  if (typeof item.actionIndex === 'string') {
    const parsed = Number(item.actionIndex)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function sortActions(items: HyperliquidActionItem[]) {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) return leftBlock - rightBlock

    const leftIndex = getActionIndex(left)
    const rightIndex = getActionIndex(right)
    if (leftIndex !== rightIndex) return leftIndex - rightIndex

    return String(left.user ?? '').localeCompare(String(right.user ?? ''))
  })
}

export function registerQueryHyperliquidReplicaCmdsTool(server: McpServer) {
  server.tool(
    'portal_query_hyperliquid_replica_cmds',
    'Query Hyperliquid order actions — orders, cancels, transfers, leverage updates. Filter by user, action type, vault, or status. NOTE: Requires hyperliquid-replica-cmds dataset (check availability with portal_list_datasets).',
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-replica-cmds')
        .describe("Dataset name (default: 'hyperliquid-replica-cmds'). Optional when continuing with cursor."),
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
      action_type: z
        .array(z.enum(['order', 'cancel', 'cancelByCloid', 'batchModify', 'transfer', 'withdraw', 'updateLeverage']))
        .optional()
        .describe('Action types to filter'),
      user: z.array(z.string()).optional().describe('User wallet addresses (0x-prefixed, lowercase)'),
      vault_address: z.array(z.string()).optional().describe('Vault addresses (0x-prefixed, lowercase)'),
      status: z.enum(['ok', 'err']).optional().describe('Filter by action status'),
      limit: z.number().optional().default(50).describe('Max actions to return'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      from_timestamp,
      to_timestamp,
      finalized_only,
      action_type,
      user,
      vault_address,
      status,
      limit,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<HyperliquidReplicaRequest>(cursor, 'portal_query_hyperliquid_replica_cmds')
        : undefined
      dataset = paginationCursor?.dataset ?? (dataset ? await resolveDataset(dataset) : 'hyperliquid-replica-cmds')
      if (paginationCursor) {
        dataset = paginationCursor.dataset
        timeframe = paginationCursor.request.timeframe
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
        limit = paginationCursor.request.limit
        finalized_only = paginationCursor.request.finalized_only
        action_type = paginationCursor.request.action_type
        user = paginationCursor.request.user
        vault_address = paginationCursor.request.vault_address
        status = paginationCursor.request.status
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

      // Build action filter
      const actionFilter: Record<string, unknown> = {}
      if (action_type) actionFilter.actionType = action_type
      if (user) actionFilter.user = user.map((u) => u.toLowerCase())
      if (vault_address) actionFilter.vaultAddress = vault_address.map((v) => v.toLowerCase())
      if (status) actionFilter.status = status

      const query = {
        type: 'hyperliquidReplicaCmds',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields: {
          block: { number: true, timestamp: true },
          action: {
            actionIndex: true,
            user: true,
            action: true,
            nonce: true,
            vaultAddress: true,
            status: true,
            response: true,
          },
        },
        actions: [actionFilter],
      }

      const hasFilters = !!(action_type || user || vault_address || status)
      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['actions'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 40_000 : 10_000,
        maxBytes: 100 * 1024 * 1024,
      })

      const allActions = sortActions(
        results.flatMap((block: unknown) => {
          const b = block as {
            header?: { number: number; timestamp: number }
            actions?: Array<Record<string, unknown>>
          }
          return (b.actions || []).map((action) => ({
            block_number: b.header?.number,
            block_timestamp: b.header?.timestamp,
            ...action,
          }))
        }) as HyperliquidActionItem[],
      )
      const page = paginateAscendingItems(
        allActions,
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
        ? encodeRecentPageCursor<HyperliquidReplicaRequest>({
            tool: 'portal_query_hyperliquid_replica_cmds',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(action_type ? { action_type } : {}),
              ...(user ? { user } : {}),
              ...(vault_address ? { vault_address } : {}),
              ...(status ? { status } : {}),
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined
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
        page.pageItems,
        `Retrieved ${page.pageItems.length} Hyperliquid actions${page.hasMore ? ` from the most recent matching range (preview page limited to ${limit})` : ''}`,
        {
          notices,
          pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
          freshness,
          coverage,
          metadata: {
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
