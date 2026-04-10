import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { ActionableError } from '../../helpers/errors.js'
import { TRANSACTION_FIELD_PRESETS } from '../../helpers/field-presets.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatTransactionFields } from '../../helpers/formatting.js'
import {
  normalizeBitcoinTransactionResult,
  normalizeEvmTransactionResult,
  normalizeHyperliquidFillResult,
  normalizeSolanaTransactionResult,
} from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeCursor, encodeCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { getTimestampWindowNotices, resolveTimeframeOrBlocks, type ResolvedBlockWindow, type TimestampInput } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { getQueryExamples, getValidationNotices, normalizeAddresses, validateQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Get Recent Transactions (Convenience Wrapper)
// ============================================================================

/**
 * Convenience wrapper that auto-calculates block ranges for recent activity.
 * Supports EVM, Solana, and Bitcoin chains.
 */

function flattenTransactionsWithBlockContext(results: unknown[], formatter?: (tx: Record<string, unknown>) => Record<string, unknown>) {
  return results.flatMap((block: unknown) => {
    const typedBlock = block as {
      number?: number
      timestamp?: number
      header?: {
        number?: number
        timestamp?: number
      }
      transactions?: Array<Record<string, unknown>>
    }

    const blockNumber = typedBlock.number ?? typedBlock.header?.number
    const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

    return (typedBlock.transactions || []).map((tx) => {
      const enriched = {
        ...tx,
        ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
        ...(timestamp !== undefined
          ? {
              timestamp,
              timestamp_human: formatTimestamp(timestamp),
            }
          : {}),
      }

      return formatter ? formatter(enriched) : enriched
    })
  })
}

type RecentTransactionItem = Record<string, unknown> & {
  block_number?: number
  transactionIndex?: number
}

type RecentTransactionsCursor = {
  tool: 'portal_get_recent_activity'
  dataset: string
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  range_label: string
  limit: number
  from_addresses?: string[]
  to_addresses?: string[]
  window_from_block: number
  window_to_block: number
  page_to_block: number
  skip_inclusive_block: number
}

function getBlockNumber(tx: RecentTransactionItem): number | undefined {
  return typeof tx.block_number === 'number' ? tx.block_number : undefined
}

function getTransactionIndex(tx: RecentTransactionItem): number {
  if (typeof tx.transactionIndex === 'number') {
    return tx.transactionIndex
  }
  if (typeof tx.transactionIndex === 'string') {
    const parsed = Number(tx.transactionIndex)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function sortRecentTransactions(items: RecentTransactionItem[]): RecentTransactionItem[] {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) {
      return leftBlock - rightBlock
    }

    const leftIndex = getTransactionIndex(left)
    const rightIndex = getTransactionIndex(right)
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex
    }

    const leftSignatures = Array.isArray(left['signatures']) ? left['signatures'] : undefined
    const rightSignatures = Array.isArray(right['signatures']) ? right['signatures'] : undefined
    const leftHash = String(left['hash'] ?? leftSignatures?.[0] ?? '')
    const rightHash = String(right['hash'] ?? rightSignatures?.[0] ?? '')
    return leftHash.localeCompare(rightHash)
  })
}

function describeRecentWindow(rangeLabel: string) {
  return rangeLabel.includes('->') ? rangeLabel : (/^\d+$/.test(rangeLabel) ? `last ${rangeLabel} blocks` : `last ${rangeLabel}`)
}

function buildRecentMessage(prefix: string, rangeLabel: string, hasMore: boolean, limit: number) {
  return `${prefix}${hasMore ? ` (preview page capped at ${limit})` : ''} from ${describeRecentWindow(rangeLabel)}`
}

function createRecentTransactionsCursor(
  params: Omit<RecentTransactionsCursor, 'tool'>,
) {
  return encodeCursor({
    tool: 'portal_get_recent_activity',
    ...params,
  })
}

export function registerGetRecentTransactionsTool(server: McpServer) {
  server.tool(
    'portal_get_recent_activity',
    buildToolDescription('portal_get_recent_activity'),
    {
      network: z
        .string()
        .optional()
        .describe("Network name (supports short names: 'polygon', 'base', 'ethereum', 'arbitrum', etc.). Optional when continuing with cursor."),
      timeframe: z
        .string()
        .optional()
        .default('100')
        .describe(
          "Time period or block count. Examples: '100' (default), '1h', '6h', '24h', '7d', '3d'.",
        ),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      from_addresses: z.array(z.string()).optional().describe('Filter by sender addresses'),
      to_addresses: z.array(z.string()).optional().describe('Filter by recipient addresses'),
      limit: z.number().max(200).optional().default(10).describe('Max transactions to return (max: 200)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ network, timeframe, from_timestamp, to_timestamp, from_addresses, to_addresses, limit, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor ? decodeCursor<RecentTransactionsCursor>(cursor, 'portal_get_recent_activity') : undefined
      const requestedDataset = network ? await resolveDataset(network) : undefined
      let dataset = paginationCursor?.dataset ?? requestedDataset
      if (!dataset) {
        throw new ActionableError('network is required unless you are continuing with cursor.', [
          'Provide network for a fresh recent-activity query.',
          'Reuse _pagination.next_cursor from a previous response to continue paging.',
        ])
      }
      const chainType = detectChainType(dataset)

      if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
        throw new ActionableError('This cursor belongs to a different network.', [
          'Reuse the cursor with the same network and filters as the previous response.',
          'Omit cursor to start a fresh query window.',
        ], {
          cursor_dataset: paginationCursor.dataset,
          requested_dataset: requestedDataset,
        })
      }

      if (paginationCursor) {
        timeframe = paginationCursor.timeframe ?? timeframe
        from_timestamp = paginationCursor.from_timestamp
        to_timestamp = paginationCursor.to_timestamp
        limit = paginationCursor.limit
        from_addresses = paginationCursor.from_addresses
        to_addresses = paginationCursor.to_addresses
      }

      // Resolve block range — numeric values are exact block counts,
      // time-based values (1h, 6h, etc.) use Portal's /timestamps/ API
      let resolvedBlocks: ResolvedBlockWindow
      let rangeLabel: string
      const head = await getBlockHead(dataset)

      if (paginationCursor) {
        resolvedBlocks = {
          from_block: paginationCursor.window_from_block,
          to_block: paginationCursor.window_to_block,
          range_kind:
            paginationCursor.from_timestamp !== undefined || paginationCursor.to_timestamp !== undefined
              ? 'timestamp_range'
              : paginationCursor.timeframe
                ? 'timeframe'
                : 'block_range',
        }
        rangeLabel = paginationCursor.range_label
      } else {
        const isTimestampWindow = from_timestamp !== undefined || to_timestamp !== undefined
        const isBlockCount = !isTimestampWindow && /^\d+$/.test(timeframe)

        if (isTimestampWindow) {
          resolvedBlocks = await resolveTimeframeOrBlocks({ dataset, from_timestamp, to_timestamp })
          rangeLabel = `${resolvedBlocks.from_lookup?.normalized_input ?? 'window start'} -> ${resolvedBlocks.to_lookup?.normalized_input ?? 'window end'}`
        } else if (isBlockCount) {
          const blockRange = parseInt(timeframe, 10)
          resolvedBlocks = {
            from_block: Math.max(0, head.number - blockRange),
            to_block: head.number,
            range_kind: 'block_range',
          }
          rangeLabel = timeframe
        } else {
          resolvedBlocks = await resolveTimeframeOrBlocks({ dataset, timeframe })
          rangeLabel = timeframe
        }
      }

      const fromBlock = resolvedBlocks.from_block
      const windowToBlock = resolvedBlocks.to_block

      const pageToBlock = paginationCursor?.page_to_block ?? windowToBlock
      const blockRange = pageToBlock - fromBlock
      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        return await queryHyperliquidRecent({
          dataset,
          fromBlock,
          pageToBlock,
          windowToBlock,
          timeframe,
          fromTimestamp: from_timestamp,
          toTimestamp: to_timestamp,
          rangeLabel,
          limit,
          fetchLimit,
          cursor: paginationCursor,
          resolvedBlocks,
          headBlockNumber: head.number,
          queryStartTime,
        })
      }

      // Build chain-specific query
      if (chainType === 'bitcoin') {
        return await queryBitcoinRecent({
          dataset,
          fromBlock,
          pageToBlock,
          windowToBlock,
          timeframe,
          fromTimestamp: from_timestamp,
          toTimestamp: to_timestamp,
          rangeLabel,
          limit,
          fetchLimit,
          cursor: paginationCursor,
          resolvedBlocks,
          headBlockNumber: head.number,
          queryStartTime,
        })
      }
      if (chainType === 'solana') {
        return await querySolanaRecent({
          dataset,
          fromBlock,
          pageToBlock,
          windowToBlock,
          timeframe,
          fromTimestamp: from_timestamp,
          toTimestamp: to_timestamp,
          rangeLabel,
          from_addresses,
          limit,
          fetchLimit,
          cursor: paginationCursor,
          resolvedBlocks,
          headBlockNumber: head.number,
          queryStartTime,
        })
      }

      // EVM path
      const includeL2 = isL2Chain(dataset)
      const normalizedFrom = normalizeAddresses(from_addresses, chainType)
      const normalizedTo = normalizeAddresses(to_addresses, chainType)

      const txFilters: Record<string, unknown>[] = []
      if (normalizedFrom || normalizedTo) {
        if (normalizedFrom) {
          txFilters.push({ from: normalizedFrom })
        }
        if (normalizedTo) {
          txFilters.push({ to: normalizedTo })
        }
      }

      // Validate query size to prevent memory crashes
      const hasFilters = txFilters.length > 0
      const validation = validateQuerySize({
        blockRange: blockRange,
        hasFilters,
        queryType: 'transactions',
        limit,
      })

      if (!validation.valid) {
        const examples = !hasFilters ? getQueryExamples('transactions') : ''
        throw new Error(validation.error + examples)
      }

      // Use standard preset (no 'input' field) to prevent response size explosions.
      const fields = {
        block: { number: true, timestamp: true, hash: true },
        transaction: {
          ...TRANSACTION_FIELD_PRESETS.standard.transaction,
          transactionIndex: true,
          gasUsed: true,
          status: true,
          sighash: true,
        },
      }

      const query: Record<string, unknown> = {
        type: 'evm',
        fromBlock,
        toBlock: pageToBlock,
        fields,
        transactions: txFilters.length > 0 ? txFilters : [{}],
      }

      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['transactions'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 500 : 100,
      })

      const allTxs = sortRecentTransactions(
        flattenTransactionsWithBlockContext(results, (tx) => normalizeEvmTransactionResult(formatTransactionFields(tx))) as RecentTransactionItem[],
      )
      const page = paginateAscendingItems(
        allTxs,
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
        ? createRecentTransactionsCursor({
            dataset,
            ...(timeframe ? { timeframe } : {}),
            ...(from_timestamp !== undefined ? { from_timestamp } : {}),
            ...(to_timestamp !== undefined ? { to_timestamp } : {}),
            range_label: rangeLabel,
            limit,
            ...(normalizedFrom ? { from_addresses: normalizedFrom } : {}),
            ...(normalizedTo ? { to_addresses: normalizedTo } : {}),
            window_from_block: fromBlock,
            window_to_block: windowToBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined
      const notices = [...getTimestampWindowNotices(resolvedBlocks), ...getValidationNotices(validation)]
      if (nextCursor) {
        notices.push('Older results are available via _pagination.next_cursor.')
      }

      return formatResult(
        page.pageItems,
        buildRecentMessage(`Retrieved ${page.pageItems.length} recent transactions`, rangeLabel, page.hasMore, limit),
        {
          toolName: 'portal_get_recent_activity',
          notices,
          pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
          ordering: buildChronologicalPageOrdering({
            sortedBy: 'block_number',
            tieBreakers: ['transactionIndex', 'hash'],
          }),
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock,
            resolvedWindow: resolvedBlocks,
          }),
          coverage: buildQueryCoverage({
            windowFromBlock: fromBlock,
            windowToBlock,
            pageToBlock,
            items: page.pageItems,
            getBlockNumber,
            hasMore: page.hasMore,
          }),
          execution: buildExecutionMetadata({
            limit,
            from_block: fromBlock,
            to_block: windowToBlock,
            page_to_block: pageToBlock,
            range_kind: resolvedBlocks.range_kind,
            normalized_output: true,
            notes: ['Returns normalized activity records so agents can switch networks with less tool-specific logic.'],
          }),
          metadata: {
            network: dataset,
            dataset,
            from_block: fromBlock,
            to_block: pageToBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}

// ---------------------------------------------------------------------------
// Bitcoin recent transactions
// ---------------------------------------------------------------------------

async function queryBitcoinRecent(params: {
  dataset: string
  fromBlock: number
  pageToBlock: number
  windowToBlock: number
  timeframe?: string
  fromTimestamp?: TimestampInput
  toTimestamp?: TimestampInput
  rangeLabel: string
  limit: number
  fetchLimit: number
  cursor?: RecentTransactionsCursor
  resolvedBlocks: ResolvedBlockWindow
  headBlockNumber: number
  queryStartTime: number
}) {
  const { dataset, fromBlock, pageToBlock, windowToBlock, timeframe, fromTimestamp, toTimestamp, rangeLabel, limit, fetchLimit, cursor, resolvedBlocks, headBlockNumber, queryStartTime } = params
  const query = {
    type: 'bitcoin',
    fromBlock,
    toBlock: pageToBlock,
    fields: {
      block: { number: true, timestamp: true },
      transaction: {
        transactionIndex: true,
        hash: true,
        size: true,
        vsize: true,
        weight: true,
        version: true,
        locktime: true,
      },
    },
    transactions: [{}],
  }

  const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
    itemKeys: ['transactions'],
    limit: fetchLimit,
    chunkSize: 20,
  })

  const allTxs = sortRecentTransactions(
    flattenTransactionsWithBlockContext(results, (tx) => normalizeBitcoinTransactionResult(tx)) as RecentTransactionItem[],
  )
  const page = paginateAscendingItems(
    allTxs,
    limit,
    getBlockNumber,
    cursor
      ? {
          page_to_block: cursor.page_to_block,
          skip_inclusive_block: cursor.skip_inclusive_block,
        }
      : undefined,
  )
  const nextCursor = page.hasMore && page.nextBoundary
    ? createRecentTransactionsCursor({
        dataset,
        ...(timeframe ? { timeframe } : {}),
        ...(fromTimestamp !== undefined ? { from_timestamp: fromTimestamp } : {}),
        ...(toTimestamp !== undefined ? { to_timestamp: toTimestamp } : {}),
        range_label: rangeLabel,
        limit,
        ...(params.cursor?.from_addresses ? { from_addresses: params.cursor.from_addresses } : {}),
        ...(params.cursor?.to_addresses ? { to_addresses: params.cursor.to_addresses } : {}),
        window_from_block: fromBlock,
        window_to_block: windowToBlock,
        page_to_block: page.nextBoundary.page_to_block,
        skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
      })
    : undefined
  const notices = getTimestampWindowNotices(resolvedBlocks)
  if (nextCursor) notices.push('Older results are available via _pagination.next_cursor.')

  return formatResult(
    page.pageItems,
    buildRecentMessage(
      `Retrieved ${page.pageItems.length} recent Bitcoin transactions`,
      rangeLabel,
      page.hasMore,
      limit,
    ),
    {
      toolName: 'portal_get_recent_activity',
      ...(notices.length > 0 ? { notices } : {}),
      pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
      ordering: buildChronologicalPageOrdering({
        sortedBy: 'block_number',
        tieBreakers: ['transactionIndex', 'hash'],
      }),
      freshness: buildQueryFreshness({
        finality: 'latest',
        headBlockNumber,
        windowToBlock,
        resolvedWindow: resolvedBlocks,
      }),
      coverage: buildQueryCoverage({
        windowFromBlock: fromBlock,
        windowToBlock,
        pageToBlock,
        items: page.pageItems,
        getBlockNumber,
        hasMore: page.hasMore,
      }),
      execution: buildExecutionMetadata({
        limit,
        from_block: fromBlock,
        to_block: windowToBlock,
        page_to_block: pageToBlock,
        range_kind: resolvedBlocks.range_kind,
        normalized_output: true,
      }),
      metadata: {
        network: dataset,
        dataset,
        from_block: fromBlock,
        to_block: pageToBlock,
        query_start_time: queryStartTime,
      },
    },
  )
}

// ---------------------------------------------------------------------------
// Solana recent transactions
// ---------------------------------------------------------------------------

async function querySolanaRecent(params: {
  dataset: string
  fromBlock: number
  pageToBlock: number
  windowToBlock: number
  timeframe?: string
  fromTimestamp?: TimestampInput
  toTimestamp?: TimestampInput
  rangeLabel: string
  from_addresses: string[] | undefined
  limit: number
  fetchLimit: number
  cursor?: RecentTransactionsCursor
  resolvedBlocks: ResolvedBlockWindow
  headBlockNumber: number
  queryStartTime: number
}) {
  const { dataset, fromBlock, pageToBlock, windowToBlock, timeframe, fromTimestamp, toTimestamp, rangeLabel, from_addresses, limit, fetchLimit, cursor, resolvedBlocks, headBlockNumber, queryStartTime } = params
  const txFilters: Record<string, unknown>[] = []
  if (from_addresses?.length) {
    txFilters.push({ feePayer: from_addresses })
  }
  const hasFilters = txFilters.length > 0

  const query = {
    type: 'solana',
    fromBlock,
    toBlock: pageToBlock,
    fields: {
      block: { number: true, timestamp: true },
      transaction: {
        transactionIndex: true,
        signatures: true,
        fee: true,
        feePayer: true,
        err: true,
        computeUnitsConsumed: true,
      },
    },
    transactions: hasFilters ? txFilters : [{}],
  }

  const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
    itemKeys: ['transactions'],
    limit: fetchLimit,
    chunkSize: hasFilters ? 500 : 100,
  })

  const allTxs = sortRecentTransactions(
    flattenTransactionsWithBlockContext(results, (tx) => normalizeSolanaTransactionResult(tx)) as RecentTransactionItem[],
  )
  const page = paginateAscendingItems(
    allTxs,
    limit,
    getBlockNumber,
    cursor
      ? {
          page_to_block: cursor.page_to_block,
          skip_inclusive_block: cursor.skip_inclusive_block,
        }
      : undefined,
  )
  const nextCursor = page.hasMore && page.nextBoundary
    ? createRecentTransactionsCursor({
        dataset,
        ...(timeframe ? { timeframe } : {}),
        ...(fromTimestamp !== undefined ? { from_timestamp: fromTimestamp } : {}),
        ...(toTimestamp !== undefined ? { to_timestamp: toTimestamp } : {}),
        range_label: rangeLabel,
        limit,
        ...(params.cursor?.from_addresses ? { from_addresses: params.cursor.from_addresses } : {}),
        ...(params.cursor?.to_addresses ? { to_addresses: params.cursor.to_addresses } : {}),
        window_from_block: fromBlock,
        window_to_block: windowToBlock,
        page_to_block: page.nextBoundary.page_to_block,
        skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
      })
    : undefined
  const notices = getTimestampWindowNotices(resolvedBlocks)
  if (nextCursor) notices.push('Older results are available via _pagination.next_cursor.')

  return formatResult(
    page.pageItems,
    buildRecentMessage(
      `Retrieved ${page.pageItems.length} recent Solana transactions`,
      rangeLabel,
      page.hasMore,
      limit,
    ),
    {
      toolName: 'portal_get_recent_activity',
      ...(notices.length > 0 ? { notices } : {}),
      pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
      ordering: buildChronologicalPageOrdering({
        sortedBy: 'slot_number',
        tieBreakers: ['transactionIndex', 'signatures[0]'],
      }),
      freshness: buildQueryFreshness({
        finality: 'latest',
        headBlockNumber,
        windowToBlock,
        resolvedWindow: resolvedBlocks,
      }),
      coverage: buildQueryCoverage({
        windowFromBlock: fromBlock,
        windowToBlock,
        pageToBlock,
        items: page.pageItems,
        getBlockNumber,
        hasMore: page.hasMore,
      }),
      execution: buildExecutionMetadata({
        limit,
        from_block: fromBlock,
        to_block: windowToBlock,
        page_to_block: pageToBlock,
        range_kind: resolvedBlocks.range_kind,
        normalized_output: true,
      }),
      metadata: {
        network: dataset,
        dataset,
        from_block: fromBlock,
        to_block: pageToBlock,
        query_start_time: queryStartTime,
      },
    },
  )
}

// ---------------------------------------------------------------------------
// Hyperliquid recent fills
// ---------------------------------------------------------------------------

async function queryHyperliquidRecent(params: {
  dataset: string
  fromBlock: number
  pageToBlock: number
  windowToBlock: number
  timeframe?: string
  fromTimestamp?: TimestampInput
  toTimestamp?: TimestampInput
  rangeLabel: string
  limit: number
  fetchLimit: number
  cursor?: RecentTransactionsCursor
  resolvedBlocks: ResolvedBlockWindow
  headBlockNumber: number
  queryStartTime: number
}) {
  const { dataset, fromBlock, pageToBlock, windowToBlock, timeframe, fromTimestamp, toTimestamp, rangeLabel, limit, fetchLimit, cursor, resolvedBlocks, headBlockNumber, queryStartTime } = params

  const query = {
    type: 'hyperliquidFills',
    fromBlock,
    toBlock: pageToBlock,
    fields: {
      block: { number: true, timestamp: true },
      fill: {
        fillIndex: true,
        user: true,
        coin: true,
        px: true,
        sz: true,
        dir: true,
        side: true,
        fee: true,
        hash: true,
        time: true,
      },
    },
    fills: [{}],
  }

  const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
    itemKeys: ['fills'],
    limit: fetchLimit,
    chunkSize: 5_000,
    maxBytes: 100 * 1024 * 1024,
  })

  const allFills = sortRecentTransactions(results.flatMap((block: unknown) => {
    const typedBlock = block as {
      number?: number
      timestamp?: number
      header?: { number?: number; timestamp?: number }
      fills?: Array<Record<string, unknown>>
    }
    const blockNumber = typedBlock.number ?? typedBlock.header?.number
    const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

    return (typedBlock.fills || []).map((fill) =>
      normalizeHyperliquidFillResult({
        ...fill,
        ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
      }),
    ) as RecentTransactionItem[]
  }))

  const page = paginateAscendingItems(
    allFills,
    limit,
    getBlockNumber,
    cursor
      ? {
          page_to_block: cursor.page_to_block,
          skip_inclusive_block: cursor.skip_inclusive_block,
        }
      : undefined,
  )
  const nextCursor = page.hasMore && page.nextBoundary
    ? createRecentTransactionsCursor({
        dataset,
        ...(timeframe ? { timeframe } : {}),
        ...(fromTimestamp !== undefined ? { from_timestamp: fromTimestamp } : {}),
        ...(toTimestamp !== undefined ? { to_timestamp: toTimestamp } : {}),
        range_label: rangeLabel,
        limit,
        window_from_block: fromBlock,
        window_to_block: windowToBlock,
        page_to_block: page.nextBoundary.page_to_block,
        skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
      })
    : undefined
  const notices = getTimestampWindowNotices(resolvedBlocks)
  if (nextCursor) notices.push('Older results are available via _pagination.next_cursor.')

  return formatResult(
    page.pageItems,
    buildRecentMessage(
      `Retrieved ${page.pageItems.length} recent Hyperliquid fills`,
      rangeLabel,
      page.hasMore,
      limit,
    ),
    {
      toolName: 'portal_get_recent_activity',
      ...(notices.length > 0 ? { notices } : {}),
      pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
      ordering: buildChronologicalPageOrdering({
        sortedBy: 'block_number',
        tieBreakers: ['fillIndex', 'hash'],
      }),
      freshness: buildQueryFreshness({
        finality: 'latest',
        headBlockNumber,
        windowToBlock,
        resolvedWindow: resolvedBlocks,
      }),
      coverage: buildQueryCoverage({
        windowFromBlock: fromBlock,
        windowToBlock,
        pageToBlock,
        items: page.pageItems,
        getBlockNumber,
        hasMore: page.hasMore,
      }),
      execution: buildExecutionMetadata({
        limit,
        from_block: fromBlock,
        to_block: windowToBlock,
        page_to_block: pageToBlock,
        range_kind: resolvedBlocks.range_kind,
        normalized_output: true,
      }),
      metadata: {
        network: dataset,
        dataset,
        from_block: fromBlock,
        to_block: pageToBlock,
        query_start_time: queryStartTime,
      },
    },
  )
}
