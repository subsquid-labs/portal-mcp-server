import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { getTransactionFields } from '../../helpers/field-presets.js'
import { normalizeEvmTransactionResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import {
  buildEvmLogFields,
  buildEvmStateDiffFields,
  buildEvmTraceFields,
  buildEvmTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatTransactionFields } from '../../helpers/formatting.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { type ResponseFormat, applyResponseFormat } from '../../helpers/response-modes.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import {
  getQueryExamples,
  getValidationNotices,
  normalizeAddresses,
  validateQuerySize,
} from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Transactions (EVM)
// ============================================================================

function flattenTransactionsWithBlockContext(results: unknown[]) {
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

    return (typedBlock.transactions || []).map((tx) =>
      normalizeEvmTransactionResult(
        formatTransactionFields({
          ...tx,
          ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
          ...(timestamp !== undefined
            ? {
                timestamp,
                timestamp_human: formatTimestamp(timestamp),
              }
            : {}),
        }),
      ),
    )
  })
}

type QueryTransactionsRequest = {
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  limit: number
  finalized_only: boolean
  from_addresses?: string[]
  to_addresses?: string[]
  sighash?: string[]
  first_nonce?: number
  last_nonce?: number
  field_preset: 'minimal' | 'standard' | 'full'
  response_format: ResponseFormat
  include_logs: boolean
  include_traces: boolean
  include_state_diffs: boolean
  include_l2_fields: boolean
}

type QueryTransactionsCursor = {
  tool: 'portal_evm_query_transactions'
  dataset: string
  request: QueryTransactionsRequest
  window_from_block: number
  window_to_block: number
  page_to_block: number
  skip_inclusive_block: number
}

type EvmTransactionItem = Record<string, unknown> & {
  block_number?: number
  transactionIndex?: number
  hash?: string
}

function getBlockNumber(tx: EvmTransactionItem): number | undefined {
  return typeof tx.block_number === 'number' ? tx.block_number : undefined
}

function getTransactionIndex(tx: EvmTransactionItem): number {
  if (typeof tx.transactionIndex === 'number') return tx.transactionIndex
  if (typeof tx.transactionIndex === 'string') {
    const parsed = Number(tx.transactionIndex)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function sortTransactions(items: EvmTransactionItem[]) {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) return leftBlock - rightBlock

    const leftIndex = getTransactionIndex(left)
    const rightIndex = getTransactionIndex(right)
    if (leftIndex !== rightIndex) return leftIndex - rightIndex

    return String(left.hash ?? left.tx_hash ?? '').localeCompare(String(right.hash ?? right.tx_hash ?? ''))
  })
}

export function registerQueryTransactionsTool(server: McpServer) {
  server.tool(
    'portal_evm_query_transactions',
    buildToolDescription('portal_evm_query_transactions'),
    {
      network: z.string().optional().describe('Network name or alias. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .describe(
          "Time range (e.g., '24h', '7d'). Alternative to from_block/to_block. Supported: 1h, 6h, 12h, 24h, 3d, 7d, 14d, 30d. Large ranges OK with low limit (<=100).",
        ),
      from_block: z
        .number()
        .optional()
        .describe('Starting block number (use this OR timeframe). Large ranges OK with low limit (<=100).'),
      to_block: z
        .number()
        .optional()
        .describe(
          'Ending block number. RECOMMENDED: <5k blocks for fast (<500ms) responses. Larger ranges may be slow.',
        ),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      from_addresses: z
        .array(z.string())
        .optional()
        .describe(
          'FILTER: Sender addresses (wallets or contracts that initiated the transaction). Optional if limit <=100.',
        ),
      to_addresses: z
        .array(z.string())
        .optional()
        .describe(
          'FILTER: Recipient addresses (typically contracts being called, or wallets receiving ETH). Optional if limit <=100.',
        ),
      sighash: z
        .array(z.string())
        .optional()
        .describe("FILTER: Function sighash (4-byte hex, e.g., '0xa9059cbb' for transfer). Optional if limit <=100."),
      first_nonce: z.number().optional().describe('Minimum nonce'),
      last_nonce: z.number().optional().describe('Maximum nonce'),
      limit: z
        .number()
        .max(200)
        .optional()
        .default(20)
        .describe('Max transactions (default: 20, max: 1000). Note: Lower default for MCP to reduce context usage.'),
      field_preset: z
        .enum(['minimal', 'standard', 'full'])
        .optional()
        .default('standard')
        .describe(
          "Field preset: 'minimal' (from/to/value+block, ~70% smaller), 'standard' (hash+gas+timestamp), 'full' (includes input data hex, largest). Use 'minimal' to reduce context usage.",
        ),
      response_format: z
        .enum(['full', 'compact', 'summary'])
        .optional()
        .default('full')
        .describe(
          "Response format: 'summary' (~90% smaller, aggregated stats), 'compact' (~60% smaller, strips input/nonce), 'full' (complete data). Use 'summary' for counting/profiling.",
        ),
      include_logs: z.boolean().optional().default(false).describe('Include logs emitted by transactions'),
      include_traces: z.boolean().optional().default(false).describe('Include traces for transactions'),
      include_state_diffs: z.boolean().optional().default(false).describe('Include state diffs caused by transactions'),
      include_l2_fields: z.boolean().optional().default(false).describe('Include L2-specific fields'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
      // include_receipt removed: logsBloom is not in TransactionFieldSelection per OpenAPI spec
    },
    async ({
      network,
      timeframe,
      from_block,
      to_block,
      from_timestamp,
      to_timestamp,
      finalized_only,
      from_addresses,
      to_addresses,
      sighash,
      first_nonce,
      last_nonce,
      limit,
      field_preset,
      response_format,
      include_logs,
      include_traces,
      include_state_diffs,
      include_l2_fields,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<QueryTransactionsRequest>(cursor, 'portal_evm_query_transactions')
        : undefined
      let dataset = paginationCursor?.dataset ?? (network ? await resolveDataset(network) : undefined)
      if (!dataset) {
        throw new Error('network is required unless you are continuing with cursor.')
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_evm_query_transactions',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_solana_query_transactions for Solana datasets.',
            'Use portal_bitcoin_query_transactions for Bitcoin datasets.',
          ],
        })
      }

      if (paginationCursor) {
        dataset = paginationCursor.dataset
        timeframe = paginationCursor.request.timeframe
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
        limit = paginationCursor.request.limit
        finalized_only = paginationCursor.request.finalized_only
        from_addresses = paginationCursor.request.from_addresses
        to_addresses = paginationCursor.request.to_addresses
        sighash = paginationCursor.request.sighash
        first_nonce = paginationCursor.request.first_nonce
        last_nonce = paginationCursor.request.last_nonce
        field_preset = paginationCursor.request.field_preset
        response_format = paginationCursor.request.response_format
        include_logs = paginationCursor.request.include_logs
        include_traces = paginationCursor.request.include_traces
        include_state_diffs = paginationCursor.request.include_state_diffs
        include_l2_fields = paginationCursor.request.include_l2_fields
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

      const normalizedFrom = normalizeAddresses(from_addresses, chainType)
      const normalizedTo = normalizeAddresses(to_addresses, chainType)
      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock
      const includeL2 = include_l2_fields || isL2Chain(dataset)

      // Validate query size to prevent crashes
      const blockRange = pageToBlock - resolvedFromBlock
      const hasFilters = !!(normalizedFrom || normalizedTo || sighash)

      const validation = validateQuerySize({
        blockRange,
        hasFilters,
        queryType: 'transactions',
        limit: limit ?? 100,
      })

      if (!validation.valid) {
        // Add examples to help user fix the query
        const examples = !hasFilters ? getQueryExamples('transactions') : ''
        throw new Error(validation.error + examples)
      }

      const txFilter: Record<string, unknown> = {}
      if (normalizedFrom) txFilter.from = normalizedFrom
      if (normalizedTo) txFilter.to = normalizedTo
      if (sighash) txFilter.sighash = sighash
      if (first_nonce !== undefined) txFilter.firstNonce = first_nonce
      if (last_nonce !== undefined) txFilter.lastNonce = last_nonce
      if (include_logs) txFilter.logs = true
      if (include_traces) txFilter.traces = true
      if (include_state_diffs) txFilter.stateDiffs = true

      // Use field preset to control response size
      const presetFields = getTransactionFields(field_preset || 'standard')
      const fields: Record<string, unknown> = { ...presetFields }
      fields.block = {
        ...((fields.block as Record<string, boolean> | undefined) ?? {}),
        number: true,
        timestamp: true,
      }
      fields.transaction = {
        ...((fields.transaction as Record<string, boolean> | undefined) ?? {}),
        hash: true,
        transactionIndex: true,
        from: true,
        to: true,
      }

      // Merge L2 fields if requested (but keep preset as base)
      if (include_l2_fields) {
        const additionalFields = buildEvmTransactionFields(includeL2)
        fields.transaction = {
          ...(fields.transaction as Record<string, boolean>),
          ...additionalFields,
        }
      }

      if (include_logs) {
        fields.log = buildEvmLogFields()
      }
      if (include_traces) {
        fields.trace = buildEvmTraceFields()
      }
      if (include_state_diffs) {
        fields.stateDiff = buildEvmStateDiffFields()
      }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields,
        transactions: [txFilter],
      }

      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['transactions'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 500 : 100,
      })

      const allTxs = sortTransactions(flattenTransactionsWithBlockContext(results) as EvmTransactionItem[])
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
        ? encodeRecentPageCursor<QueryTransactionsRequest>({
            tool: 'portal_evm_query_transactions',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(normalizedFrom ? { from_addresses: normalizedFrom } : {}),
              ...(normalizedTo ? { to_addresses: normalizedTo } : {}),
              ...(sighash ? { sighash } : {}),
              ...(first_nonce !== undefined ? { first_nonce } : {}),
              ...(last_nonce !== undefined ? { last_nonce } : {}),
              field_preset,
              response_format: response_format as ResponseFormat,
              include_logs,
              include_traces,
              include_state_diffs,
              include_l2_fields,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined

      // Apply response format (summary/compact/full)
      const formattedData = applyResponseFormat(page.pageItems, response_format || 'full', 'transactions')
      const notices = [...getTimestampWindowNotices(resolvedBlocks), ...getValidationNotices(validation)]
      if (nextCursor) {
        notices.push('Older results are available via _pagination.next_cursor.')
      }
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

      const message =
        response_format === 'summary'
          ? `Transaction summary for ${page.pageItems.length} transactions${page.hasMore ? ' (latest preview page)' : ''}`
          : `Retrieved ${page.pageItems.length} transactions${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
        toolName: 'portal_evm_query_transactions',
        notices,
        pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
        ordering: buildChronologicalPageOrdering({
          sortedBy: 'block_number',
          tieBreakers: ['transactionIndex', 'hash'],
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
          notes: [
            include_logs || include_traces || include_state_diffs
              ? 'Expanded transaction context was requested with include flags.'
              : `Using ${field_preset} field preset.`,
          ],
          normalized_output: true,
        }),
        metadata: {
          network: dataset,
          dataset,
          from_block: resolvedFromBlock,
          to_block: pageToBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
