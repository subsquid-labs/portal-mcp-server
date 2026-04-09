import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { TRANSACTION_FIELD_PRESETS } from '../../helpers/field-presets.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatTransactionFields } from '../../helpers/formatting.js'
import { buildPaginationInfo, decodeCursor, encodeCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
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
  tool: 'portal_get_recent_transactions'
  dataset: string
  timeframe: string
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

function describeRecentWindow(timeframe: string) {
  return /^\d+$/.test(timeframe) ? `last ${timeframe} blocks` : `last ${timeframe}`
}

function buildRecentMessage(prefix: string, timeframe: string, hasMore: boolean, limit: number) {
  return `${prefix}${hasMore ? ` (preview page capped at ${limit})` : ''} from ${describeRecentWindow(timeframe)}`
}

function createRecentTransactionsCursor(
  params: Omit<RecentTransactionsCursor, 'tool'>,
) {
  return encodeCursor({
    tool: 'portal_get_recent_transactions',
    ...params,
  })
}

export function registerGetRecentTransactionsTool(server: McpServer) {
  server.tool(
    'portal_get_recent_transactions',
    `Get recent transactions without manual block calculation. Automatically queries the last N blocks or timeframe. Supports address filtering.`,
    {
      dataset: z
        .string()
        .describe("Dataset name (supports short names: 'polygon', 'base', 'ethereum', 'arbitrum', etc.)"),
      timeframe: z
        .string()
        .optional()
        .default('100')
        .describe(
          "Time period or block count. Examples: '100' (default), '1h', '6h', '24h', '7d', '3d'.",
        ),
      from_addresses: z.array(z.string()).optional().describe('Filter by sender addresses'),
      to_addresses: z.array(z.string()).optional().describe('Filter by recipient addresses'),
      limit: z.number().max(200).optional().default(10).describe('Max transactions to return (max: 200)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ dataset, timeframe, from_addresses, to_addresses, limit, cursor }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_recent_transactions',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin'],
          suggestions: ['Use portal_query_hyperliquid_fills for Hyperliquid fill activity.'],
        })
      }

      const paginationCursor = cursor ? decodeCursor<RecentTransactionsCursor>(cursor, 'portal_get_recent_transactions') : undefined
      if (paginationCursor && paginationCursor.dataset !== dataset) {
        throw new ActionableError('This cursor belongs to a different dataset.', [
          'Reuse the cursor with the same dataset and filters as the previous response.',
          'Omit cursor to start a fresh query window.',
        ], {
          cursor_dataset: paginationCursor.dataset,
          requested_dataset: dataset,
        })
      }

      if (paginationCursor) {
        timeframe = paginationCursor.timeframe
        from_addresses = paginationCursor.from_addresses
        to_addresses = paginationCursor.to_addresses
      }

      // Resolve block range — numeric values are exact block counts,
      // time-based values (1h, 6h, etc.) use Portal's /timestamps/ API
      let fromBlock: number
      let windowToBlock: number

      if (paginationCursor) {
        fromBlock = paginationCursor.window_from_block
        windowToBlock = paginationCursor.window_to_block
      } else {
        const isBlockCount = /^\d+$/.test(timeframe)

        if (isBlockCount) {
          const head = await getBlockHead(dataset)
          const blockRange = parseInt(timeframe, 10)
          windowToBlock = head.number
          fromBlock = Math.max(0, windowToBlock - blockRange)
        } else {
          const resolved = await resolveTimeframeOrBlocks({ dataset, timeframe })
          fromBlock = resolved.from_block
          windowToBlock = resolved.to_block
        }
      }

      const pageToBlock = paginationCursor?.page_to_block ?? windowToBlock
      const blockRange = pageToBlock - fromBlock
      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1

      // Build chain-specific query
      if (chainType === 'bitcoin') {
        return await queryBitcoinRecent({
          dataset,
          fromBlock,
          pageToBlock,
          windowToBlock,
          timeframe,
          limit,
          fetchLimit,
          cursor: paginationCursor,
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
          from_addresses,
          limit,
          fetchLimit,
          cursor: paginationCursor,
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
        flattenTransactionsWithBlockContext(results, (tx) => formatTransactionFields(tx)) as RecentTransactionItem[],
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
            timeframe,
            ...(normalizedFrom ? { from_addresses: normalizedFrom } : {}),
            ...(normalizedTo ? { to_addresses: normalizedTo } : {}),
            window_from_block: fromBlock,
            window_to_block: windowToBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined
      const notices = getValidationNotices(validation)
      if (nextCursor) {
        notices.push('Older results are available via _pagination.next_cursor.')
      }

      return formatResult(
        page.pageItems,
        buildRecentMessage(`Retrieved ${page.pageItems.length} recent transactions`, timeframe, page.hasMore, limit),
        {
          notices,
          pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
          metadata: {
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
  timeframe: string
  limit: number
  fetchLimit: number
  cursor?: RecentTransactionsCursor
  queryStartTime: number
}) {
  const { dataset, fromBlock, pageToBlock, windowToBlock, timeframe, limit, fetchLimit, cursor, queryStartTime } = params
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

  const allTxs = sortRecentTransactions(flattenTransactionsWithBlockContext(results) as RecentTransactionItem[])
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
        timeframe,
        ...(params.cursor?.from_addresses ? { from_addresses: params.cursor.from_addresses } : {}),
        ...(params.cursor?.to_addresses ? { to_addresses: params.cursor.to_addresses } : {}),
        window_from_block: fromBlock,
        window_to_block: windowToBlock,
        page_to_block: page.nextBoundary.page_to_block,
        skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
      })
    : undefined
  const notices = nextCursor ? ['Older results are available via _pagination.next_cursor.'] : undefined

  return formatResult(
    page.pageItems,
    buildRecentMessage(
      `Retrieved ${page.pageItems.length} recent Bitcoin transactions`,
      timeframe,
      page.hasMore,
      limit,
    ),
    {
      notices,
      pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
      metadata: {
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
  timeframe: string
  from_addresses: string[] | undefined
  limit: number
  fetchLimit: number
  cursor?: RecentTransactionsCursor
  queryStartTime: number
}) {
  const { dataset, fromBlock, pageToBlock, windowToBlock, timeframe, from_addresses, limit, fetchLimit, cursor, queryStartTime } = params
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

  const allTxs = sortRecentTransactions(flattenTransactionsWithBlockContext(results) as RecentTransactionItem[])
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
        timeframe,
        ...(params.cursor?.from_addresses ? { from_addresses: params.cursor.from_addresses } : {}),
        ...(params.cursor?.to_addresses ? { to_addresses: params.cursor.to_addresses } : {}),
        window_from_block: fromBlock,
        window_to_block: windowToBlock,
        page_to_block: page.nextBoundary.page_to_block,
        skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
      })
    : undefined
  const notices = nextCursor ? ['Older results are available via _pagination.next_cursor.'] : undefined

  return formatResult(
    page.pageItems,
    buildRecentMessage(
      `Retrieved ${page.pageItems.length} recent Solana transactions`,
      timeframe,
      page.hasMore,
      limit,
    ),
    {
      notices,
      pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
      metadata: {
        dataset,
        from_block: fromBlock,
        to_block: pageToBlock,
        query_start_time: queryStartTime,
      },
    },
  )
}
