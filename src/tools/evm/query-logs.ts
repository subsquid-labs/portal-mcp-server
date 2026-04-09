import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { getLogFields } from '../../helpers/field-presets.js'
import { normalizeEvmLogResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildEvmLogFields, buildEvmTraceFields, buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp } from '../../helpers/formatting.js'
import { buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { type ResponseFormat, applyResponseFormat } from '../../helpers/response-modes.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import {
  getQueryExamples,
  getValidationNotices,
  normalizeAddresses,
  validateQuerySize,
} from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Logs (EVM)
// ============================================================================

function flattenLogsWithBlockContext(results: unknown[]) {
  return results.flatMap((block: unknown) => {
    const typedBlock = block as {
      number?: number
      timestamp?: number
      header?: {
        number?: number
        timestamp?: number
      }
      logs?: Array<Record<string, unknown>>
    }

    const blockNumber = typedBlock.number ?? typedBlock.header?.number
    const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

    return (typedBlock.logs || []).map((log) =>
      normalizeEvmLogResult({
        ...(log as Record<string, unknown>),
        ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
        ...(timestamp !== undefined
          ? {
              timestamp,
              timestamp_human: formatTimestamp(timestamp),
            }
          : {}),
      }),
    )
  })
}

type QueryLogsRequest = {
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  limit: number
  finalized_only: boolean
  addresses?: string[]
  topic0?: string[]
  topic1?: string[]
  topic2?: string[]
  topic3?: string[]
  field_preset: 'minimal' | 'standard' | 'full'
  response_format: ResponseFormat
  include_transaction: boolean
  include_transaction_traces: boolean
  include_transaction_logs: boolean
}

type QueryLogsCursor = {
  tool: 'portal_query_logs'
  dataset: string
  request: QueryLogsRequest
  window_from_block: number
  window_to_block: number
  page_to_block: number
  skip_inclusive_block: number
}

type EvmLogItem = Record<string, unknown> & {
  block_number?: number
  logIndex?: number
  log_index?: number
  transactionHash?: string
}

function getBlockNumber(log: EvmLogItem): number | undefined {
  return typeof log.block_number === 'number' ? log.block_number : undefined
}

function getLogIndex(log: EvmLogItem): number {
  const value = typeof log.logIndex === 'number' ? log.logIndex : typeof log.log_index === 'number' ? log.log_index : 0
  return value
}

function sortLogs(items: EvmLogItem[]) {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) return leftBlock - rightBlock

    const leftIndex = getLogIndex(left)
    const rightIndex = getLogIndex(right)
    if (leftIndex !== rightIndex) return leftIndex - rightIndex

    return String(left.transactionHash ?? left.tx_hash ?? '').localeCompare(String(right.transactionHash ?? right.tx_hash ?? ''))
  })
}

export function registerQueryLogsTool(server: McpServer) {
  server.tool(
    'portal_query_logs',
    `Query event logs from EVM chains. Filter by contract address, event signature (topic0), and indexed parameters. Use field_preset and response_format to control response size.`,
    {
      dataset: z.string().optional().describe('Dataset name or alias. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .describe(
          "Time range (e.g., '24h', '7d'). Alternative to from_block/to_block. Supported: 1h, 6h, 12h, 24h, 3d, 7d, 14d, 30d",
        ),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z
        .number()
        .optional()
        .describe(
          'Ending block number. RECOMMENDED: <10k blocks for fast (<1s) responses. Larger ranges may be slow or timeout.',
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
      addresses: z
        .array(z.string())
        .optional()
        .describe(
          "Contract addresses to filter (e.g., ['0xUSDC...', '0xDAI...']). IMPORTANT: Always include this or topics for fast queries.",
        ),
      topic0: z
        .array(z.string())
        .optional()
        .describe(
          'Event signatures (topic0). E.g., Transfer = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        ),
      topic1: z
        .array(z.string())
        .optional()
        .describe('Topic1 filter (often: from address in Transfer, indexed parameter 1)'),
      topic2: z
        .array(z.string())
        .optional()
        .describe('Topic2 filter (often: to address in Transfer, indexed parameter 2)'),
      topic3: z.array(z.string()).optional().describe('Topic3 filter (indexed parameter 3, chain-specific)'),
      limit: z
        .number()
        .max(200)
        .optional()
        .default(20)
        .describe('Max logs to return (default: 20, max: 1000). Note: Lower default for MCP to reduce context usage.'),
      field_preset: z
        .enum(['minimal', 'standard', 'full'])
        .optional()
        .default('standard')
        .describe(
          "Field preset: 'minimal' (address+topic0+block, ~80% smaller), 'standard' (all topics+timestamp), 'full' (includes raw data hex, largest). Use 'minimal' to reduce context usage.",
        ),
      response_format: z
        .enum(['full', 'compact', 'summary'])
        .optional()
        .default('full')
        .describe(
          "Response format: 'summary' (~95% smaller, aggregated stats only), 'compact' (~70% smaller, strips verbose fields), 'full' (complete data). Use 'summary' for counting/categorizing.",
        ),
      include_transaction: z.boolean().optional().default(false).describe('Include parent transaction data'),
      include_transaction_traces: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include traces for parent transactions'),
      include_transaction_logs: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include all logs from parent transactions'),
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
      addresses,
      topic0,
      topic1,
      topic2,
      topic3,
      limit,
      field_preset,
      response_format,
      include_transaction,
      include_transaction_traces,
      include_transaction_logs,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<QueryLogsRequest>(cursor, 'portal_query_logs')
        : undefined
      dataset = paginationCursor?.dataset ?? (dataset ? await resolveDataset(dataset) : undefined)
      if (!dataset) {
        throw new Error('dataset is required unless you are continuing with cursor.')
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_query_logs',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_query_solana_instructions for Solana program activity.',
            'Use portal_query_bitcoin_outputs or portal_query_bitcoin_inputs for Bitcoin UTXO activity.',
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
        addresses = paginationCursor.request.addresses
        topic0 = paginationCursor.request.topic0
        topic1 = paginationCursor.request.topic1
        topic2 = paginationCursor.request.topic2
        topic3 = paginationCursor.request.topic3
        field_preset = paginationCursor.request.field_preset
        response_format = paginationCursor.request.response_format
        include_transaction = paginationCursor.request.include_transaction
        include_transaction_traces = paginationCursor.request.include_transaction_traces
        include_transaction_logs = paginationCursor.request.include_transaction_logs
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

      const normalizedAddresses = normalizeAddresses(addresses, chainType)
      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock
      const includeL2 = isL2Chain(dataset)

      // Validate query size to prevent crashes
      const blockRange = pageToBlock - resolvedFromBlock
      const hasFilters = !!(normalizedAddresses || topic0 || topic1 || topic2 || topic3)

      const validation = validateQuerySize({
        blockRange,
        hasFilters,
        queryType: 'logs',
        limit: limit ?? 100,
      })

      if (!validation.valid) {
        // Add examples to help user fix the query
        const examples = !hasFilters ? getQueryExamples('logs') : ''
        throw new Error(validation.error + examples)
      }

      const logFilter: Record<string, unknown> = {}
      if (normalizedAddresses) logFilter.address = normalizedAddresses
      if (topic0) logFilter.topic0 = topic0
      if (topic1) logFilter.topic1 = topic1
      if (topic2) logFilter.topic2 = topic2
      if (topic3) logFilter.topic3 = topic3
      if (include_transaction) logFilter.transaction = true
      if (include_transaction_traces) logFilter.transactionTraces = true
      if (include_transaction_logs) logFilter.transactionLogs = true

      // Use field preset to control response size
      const presetFields = getLogFields(field_preset || 'standard')
      const fields: Record<string, unknown> = { ...presetFields }
      fields.block = {
        ...((fields.block as Record<string, boolean> | undefined) ?? {}),
        number: true,
        timestamp: true,
      }
      fields.log = {
        ...((fields.log as Record<string, boolean> | undefined) ?? {}),
        transactionHash: true,
        logIndex: true,
        address: true,
        topics: true,
      }

      // Add transaction/trace fields if requested
      if (include_transaction || include_transaction_traces || include_transaction_logs) {
        fields.transaction = buildEvmTransactionFields(includeL2)
      }
      if (include_transaction_traces) {
        fields.trace = buildEvmTraceFields()
      }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields,
        logs: [logFilter],
      }

      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['logs'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 500 : 100,
      })

      const allLogs = sortLogs(flattenLogsWithBlockContext(results) as EvmLogItem[])
      const page = paginateAscendingItems(
        allLogs,
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
        ? encodeRecentPageCursor<QueryLogsRequest>({
            tool: 'portal_query_logs',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(normalizedAddresses ? { addresses: normalizedAddresses } : {}),
              ...(topic0 ? { topic0 } : {}),
              ...(topic1 ? { topic1 } : {}),
              ...(topic2 ? { topic2 } : {}),
              ...(topic3 ? { topic3 } : {}),
              field_preset,
              response_format: response_format as ResponseFormat,
              include_transaction,
              include_transaction_traces,
              include_transaction_logs,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined

      // Apply response format (summary/compact/full)
      const formattedData = applyResponseFormat(page.pageItems, response_format || 'full', 'logs')
      const notices = [...getTimestampWindowNotices(resolvedBlocks), ...getValidationNotices(validation)]
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

      const message =
        response_format === 'summary'
          ? `Log summary for ${page.pageItems.length} logs${page.hasMore ? ' (latest preview page)' : ''}`
          : `Retrieved ${page.pageItems.length} logs${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
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
      })
    },
  )
}
