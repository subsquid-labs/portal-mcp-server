import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import {
  buildBoundedSearchExecution,
  buildBoundedSearchNotice,
  scanBoundedBlockRange,
} from '../../helpers/bounded-search.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import {
  type TokenListLookupMetadata,
  type TokenSymbolResolution,
  buildTokenListLookupNotices,
  resolveTokenSymbolsForQuery,
} from '../../helpers/entity-resolution.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { resolveEventTopic0 } from '../../helpers/evm-aliases.js'
import { portalFetchRecentRecordsWithScan, portalFetchStreamRange } from '../../helpers/fetch.js'
import { getLogFields } from '../../helpers/field-presets.js'
import { buildEvmLogFields, buildEvmTraceFields, buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatResult, formatTimestamp } from '../../helpers/format.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import { normalizeEvmLogResult } from '../../helpers/normalized-results.js'
import {
  buildCursorDirectionNotice,
  buildPaginationInfo,
  decodeRecentPageCursor,
  encodeRecentPageCursor,
  paginateAscendingItems,
  paginateForwardItems,
} from '../../helpers/pagination.js'
import { type ResponseFormat, applyResponseFormat, resolveDefaultResponseFormat } from '../../helpers/response-modes.js'
import {
  buildChronologicalPageOrdering,
  buildQueryCoverage,
  buildQueryFreshness,
} from '../../helpers/result-metadata.js'
import { type TimestampInput, getTimestampWindowNotices, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { quoteUntrusted } from '../../helpers/untrusted-text.js'
import {
  getQueryExamples,
  getValidationNotices,
  normalizeAddresses,
  validateQuerySize,
} from '../../helpers/validation.js'
import { decodeLog } from '../utilities/decode-logs.js'

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
      logs?: Record<string, unknown>[]
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
  token_symbols?: string[]
  max_token_symbol_matches?: number
  event?: string | string[]
  topic0?: string[]
  topic1?: string[]
  topic2?: string[]
  topic3?: string[]
  scan_order?: 'earliest' | 'latest'
  max_scan_blocks?: number
  field_preset: 'minimal' | 'standard' | 'full'
  response_format: ResponseFormat
  include_transaction: boolean
  include_transaction_traces: boolean
  include_transaction_logs: boolean
  decode?: boolean
}

type QueryLogsCursor = {
  tool: 'portal_evm_query_logs'
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

const uniqueStrings = (values: string[]) => Array.from(new Set(values))

function buildTokenResolutionNotices(resolutions: TokenSymbolResolution[], unresolvedSymbols: string[]) {
  const notices: string[] = []
  if (unresolvedSymbols.length > 0) {
    notices.push(
      `No token-list match found for symbol(s): ${unresolvedSymbols.map((symbol) => quoteUntrusted(symbol)).join(', ')}.`,
    )
  }
  for (const resolution of resolutions) {
    if (resolution.matches.length > 1) {
      notices.push(
        `Token symbol ${quoteUntrusted(resolution.symbol)} resolved to ${resolution.matches.length} token-list matches; all selected addresses were included. Use addresses for a single deterministic contract.`,
      )
    }
    if (resolution.truncated) {
      notices.push(
        `Token symbol ${quoteUntrusted(resolution.symbol)} had more matches than max_token_symbol_matches; results were capped.`,
      )
    }
  }
  return notices
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

    return String(left.transactionHash ?? left.tx_hash ?? '').localeCompare(
      String(right.transactionHash ?? right.tx_hash ?? ''),
    )
  })
}

function hasTopicFilter(topics: string[] | undefined): boolean {
  return Array.isArray(topics) && topics.length > 0
}

function getRecentLogChunkSize(blockRange: number, hasFilters: boolean): number {
  const safeChunkSize = hasFilters ? 500 : 100
  return Math.max(1, Math.min(safeChunkSize, blockRange))
}

const DEFAULT_SELECTIVE_LATEST_SCAN_BLOCKS = 25_000

function getSelectiveLatestLogChunkSize(blockRange: number): number {
  return Math.min(2_500, Math.max(1, blockRange))
}

function shouldUseBoundedFilteredLatestScan({
  scanOrder,
  blockRange,
  limit,
  addressFilters,
  topic0,
  topic1,
  topic2,
  topic3,
}: {
  scanOrder: 'earliest' | 'latest'
  blockRange: number
  limit: number
  addressFilters: string[] | undefined
  topic0: string[]
  topic1?: string[]
  topic2?: string[]
  topic3?: string[]
}): boolean {
  return (
    scanOrder === 'latest' &&
    blockRange > 10_000 &&
    limit <= 25 &&
    !!addressFilters?.length &&
    topic0.length > 0 &&
    (hasTopicFilter(topic1) || hasTopicFilter(topic2) || hasTopicFilter(topic3))
  )
}

async function fetchLogsByScanOrder({
  url,
  query,
  fromBlock,
  toBlock,
  targetCount,
  chunkSize,
  scanOrder,
  concurrency = 1,
  maxScanBlocks,
}: {
  url: string
  query: Record<string, unknown>
  fromBlock: number
  toBlock: number
  targetCount: number
  chunkSize: number
  scanOrder: 'earliest' | 'latest'
  concurrency?: number
  maxScanBlocks?: number
}) {
  const scan = await scanBoundedBlockRange<EvmLogItem>({
    fromBlock,
    toBlock,
    chunkSize,
    concurrency,
    scanOrder,
    maxScanBlocks,
    shouldContinue: (state) => state.items.length < targetCount,
    fetchChunk: async (chunk) => {
      const records = await portalFetchStreamRange(url, {
        ...query,
        fromBlock: chunk.fromBlock,
        toBlock: chunk.toBlock,
      })
      const logs = sortLogs(flattenLogsWithBlockContext(records) as EvmLogItem[])
      return scanOrder === 'latest' ? logs.reverse() : logs
    },
  })
  /* Every collected row, oldest first. The caller pages them: by offset for
     a forward scan, by block boundary for a backward one. */
  return {
    ...scan,
    items: sortLogs([...scan.items]),
  }
}

export function registerQueryLogsTool(server: McpServer) {
  registerPortalTool(
    server,
    'portal_evm_query_logs',
    buildToolDescription('portal_evm_query_logs'),
    {
      network: z.string().optional().describe('Network name or alias. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .describe(
          "Natural time range such as '5m', '1h', '24h', '7d', or 'past 30 minutes'. Alternative to from_block/to_block.",
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
        .describe(
          'Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".',
        ),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".',
        ),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      addresses: z
        .array(z.string())
        .optional()
        .describe(
          "Contract addresses to filter (e.g., ['0xUSDC...', '0xDAI...']). IMPORTANT: Always include this or topics for fast queries.",
        ),
      token_symbols: z
        .array(z.string())
        .optional()
        .describe('Token symbols to resolve via open token-list data and merge into addresses, e.g. ["USDC"].'),
      max_token_symbol_matches: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe(
          'Maximum token-list matches to include per token symbol. Use addresses for deterministic single-contract filters.',
        ),
      event: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'Common event alias or topic0 hash. Examples: "transfer", "approval", "swap", "sync", "deposit", "withdrawal". Merges with topic0.',
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
      scan_order: z
        .enum(['latest', 'earliest'])
        .optional()
        .default('latest')
        .describe('Which side of the block window to scan first. Use earliest for first-event questions.'),
      max_scan_blocks: z
        .number()
        .int()
        .min(1)
        .max(250_000)
        .optional()
        .describe(
          'Maximum blocks to inspect for bounded earliest/latest scans. Sparse latest searches default to 25,000 blocks to stay within MCP request timeouts; raise only when deeper coverage is worth the added latency.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .default(20)
        .describe(
          'Max logs to return (default: 20, max: 25). This verified ceiling keeps pages within MCP client budgets.',
        ),
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
        .describe(
          "Response format: defaults to 'compact' for chat-friendly output, or stays 'full' when inline transaction context is requested. Use 'summary' for counting or categorizing.",
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
      decode: z
        .boolean()
        .optional()
        .default(false)
        .describe('Decode known log signatures inline when topics/data are available'),
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
      addresses,
      token_symbols,
      max_token_symbol_matches,
      event,
      topic0,
      topic1,
      topic2,
      topic3,
      scan_order,
      max_scan_blocks,
      limit,
      field_preset,
      response_format,
      include_transaction,
      include_transaction_traces,
      include_transaction_logs,
      decode,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<QueryLogsRequest>(cursor, 'portal_evm_query_logs')
        : undefined
      let dataset = paginationCursor?.dataset ?? (network ? await resolveDataset(network) : undefined)
      if (!dataset) {
        throw new Error('network is required unless you are continuing with cursor.')
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_evm_query_logs',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_solana_query_instructions for Solana program activity.',
            'Use portal_bitcoin_query_transactions with include_inputs/include_outputs for Bitcoin UTXO activity.',
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
        token_symbols = paginationCursor.request.token_symbols
        max_token_symbol_matches = paginationCursor.request.max_token_symbol_matches ?? 5
        event = paginationCursor.request.event
        topic0 = paginationCursor.request.topic0
        topic1 = paginationCursor.request.topic1
        topic2 = paginationCursor.request.topic2
        topic3 = paginationCursor.request.topic3
        scan_order = paginationCursor.request.scan_order ?? 'latest'
        max_scan_blocks = paginationCursor.request.max_scan_blocks
        field_preset = paginationCursor.request.field_preset
        response_format = paginationCursor.request.response_format
        include_transaction = paginationCursor.request.include_transaction
        include_transaction_traces = paginationCursor.request.include_transaction_traces
        include_transaction_logs = paginationCursor.request.include_transaction_logs
        decode = paginationCursor.request.decode ?? false
      }
      const effectiveResponseFormat = resolveDefaultResponseFormat(response_format, {
        preserveFullIf: include_transaction || include_transaction_traces || include_transaction_logs,
      })

      // Resolve timeframe or use explicit blocks
      const openEndedLatestBlockWindow =
        !paginationCursor &&
        !timeframe &&
        from_timestamp === undefined &&
        to_timestamp === undefined &&
        from_block !== undefined &&
        to_block === undefined &&
        scan_order === 'latest'

      let resolvedBlocks = paginationCursor
        ? {
            from_block: paginationCursor.window_from_block,
            to_block: paginationCursor.window_to_block,
            range_kind:
              paginationCursor.request.from_timestamp !== undefined ||
              paginationCursor.request.to_timestamp !== undefined
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
      if (openEndedLatestBlockWindow) {
        resolvedBlocks = {
          ...resolvedBlocks,
          to_block: Number.MAX_SAFE_INTEGER,
        }
      }
      const resolvedFromBlock = resolvedBlocks.from_block
      const resolvedToBlock = resolvedBlocks.to_block

      const normalizedAddressFilters = normalizeAddresses(addresses, chainType) ?? []
      let tokenSymbolResolutions: TokenSymbolResolution[] = []
      let unresolvedTokenSymbols: string[] = []
      let resolvedTokenSymbolAddresses: string[] = []
      let tokenSymbolLookup: TokenListLookupMetadata | undefined
      if (!paginationCursor && token_symbols && token_symbols.length > 0) {
        const resolvedSymbols = await resolveTokenSymbolsForQuery({
          dataset,
          symbols: token_symbols,
          maxMatchesPerSymbol: max_token_symbol_matches,
        })
        tokenSymbolResolutions = resolvedSymbols.resolutions
        unresolvedTokenSymbols = resolvedSymbols.unresolved_symbols
        resolvedTokenSymbolAddresses = resolvedSymbols.addresses
        tokenSymbolLookup = resolvedSymbols.lookup
        if (resolvedTokenSymbolAddresses.length === 0 && normalizedAddressFilters.length === 0) {
          throw new Error(
            `No token-list matches found for token_symbols: ${token_symbols.map((symbol) => quoteUntrusted(symbol)).join(', ')}. Use portal_resolve_entity to inspect matches or pass addresses directly.`,
          )
        }
      }
      const normalizedAddresses = uniqueStrings([...normalizedAddressFilters, ...resolvedTokenSymbolAddresses])
      const addressFilters = normalizedAddresses.length > 0 ? normalizedAddresses : undefined
      const normalizedTopic0 = Array.from(
        new Set([...(topic0 ?? []), ...resolveEventTopic0(event)].map((value) => value.toLowerCase())),
      )
      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      if (openEndedLatestBlockWindow) {
        resolvedBlocks = {
          ...resolvedBlocks,
          to_block: endBlock,
        }
      }
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock
      const includeL2 = isL2Chain(dataset)

      // Validate query size to prevent crashes
      const blockRange = pageToBlock - resolvedFromBlock
      const inclusiveBlockRange = Math.max(0, blockRange + 1)
      const hasFilters = !!(addressFilters || normalizedTopic0.length > 0 || topic1 || topic2 || topic3)

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
      if (addressFilters) logFilter.address = addressFilters
      if (normalizedTopic0.length > 0) logFilter.topic0 = normalizedTopic0
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
        ...(decode ? { data: true } : {}),
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
      const portalUrl = `${PORTAL_URL}/datasets/${dataset}/stream`
      const boundedFilteredLatestScan = shouldUseBoundedFilteredLatestScan({
        scanOrder: scan_order,
        blockRange: inclusiveBlockRange,
        limit,
        addressFilters,
        topic0: normalizedTopic0,
        topic1,
        topic2,
        topic3,
      })
      const scanResult =
        scan_order === 'earliest' || boundedFilteredLatestScan
          ? await fetchLogsByScanOrder({
              url: portalUrl,
              query,
              fromBlock: resolvedFromBlock,
              toBlock: pageToBlock,
              targetCount: fetchLimit,
              chunkSize: boundedFilteredLatestScan
                ? getSelectiveLatestLogChunkSize(inclusiveBlockRange)
                : getRecentLogChunkSize(inclusiveBlockRange, hasFilters),
              scanOrder: scan_order,
              concurrency: boundedFilteredLatestScan ? 5 : 1,
              maxScanBlocks: boundedFilteredLatestScan
                ? Math.min(inclusiveBlockRange, max_scan_blocks ?? DEFAULT_SELECTIVE_LATEST_SCAN_BLOCKS)
                : max_scan_blocks,
            })
          : undefined
      const recentFetch = scanResult
        ? undefined
        : await portalFetchRecentRecordsWithScan(portalUrl, query, {
            itemKeys: ['logs'],
            limit: fetchLimit,
            chunkSize: getRecentLogChunkSize(inclusiveBlockRange, hasFilters),
          })
      const results = recentFetch?.records ?? []
      const recentScan = recentFetch?.scan

      const allLogs = scanResult ? scanResult.items : sortLogs(flattenLogsWithBlockContext(results) as EvmLogItem[])
      const cursorBoundary = paginationCursor
        ? {
            page_to_block: paginationCursor.page_to_block,
            skip_inclusive_block: paginationCursor.skip_inclusive_block,
          }
        : undefined
      /* A forward scan pages by offset: the cursor records how many rows of
         the window were already shown and the next call re-scans past them. A
         backward scan pages by block boundary, and when max_scan_blocks stopped
         it with the page unfilled, the cursor starts just below the scanned
         slice so the next call reads on into the window. */
      const page = (() => {
        if (scanResult && scan_order === 'earliest') {
          return paginateForwardItems(allLogs, limit, cursorSkip, endBlock)
        }
        const boundaryPage = paginateAscendingItems(allLogs, limit, getBlockNumber, cursorBoundary)
        if (!scanResult || !scanResult.hasUnscannedBlocks || boundaryPage.hasMore) return boundaryPage
        return {
          pageItems: boundaryPage.pageItems,
          hasMore: true,
          nextBoundary: { page_to_block: scanResult.scannedFromBlock - 1, skip_inclusive_block: 0 },
        }
      })()
      const nextCursor =
        page.hasMore && page.nextBoundary
          ? encodeRecentPageCursor<QueryLogsRequest>({
              tool: 'portal_evm_query_logs',
              dataset,
              request: {
                ...(timeframe ? { timeframe } : {}),
                ...(from_timestamp !== undefined ? { from_timestamp } : {}),
                ...(to_timestamp !== undefined ? { to_timestamp } : {}),
                limit,
                finalized_only,
                ...(addressFilters ? { addresses: addressFilters } : {}),
                ...(token_symbols ? { token_symbols } : {}),
                ...(max_token_symbol_matches !== undefined ? { max_token_symbol_matches } : {}),
                ...(event ? { event } : {}),
                ...(normalizedTopic0.length > 0 ? { topic0: normalizedTopic0 } : {}),
                ...(topic1 ? { topic1 } : {}),
                ...(topic2 ? { topic2 } : {}),
                ...(topic3 ? { topic3 } : {}),
                scan_order,
                ...(max_scan_blocks !== undefined ? { max_scan_blocks } : {}),
                field_preset,
                response_format: effectiveResponseFormat,
                include_transaction,
                include_transaction_traces,
                include_transaction_logs,
                ...(decode ? { decode } : {}),
              },
              window_from_block: resolvedFromBlock,
              window_to_block: endBlock,
              page_to_block: page.nextBoundary.page_to_block,
              skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
            })
          : undefined

      // Apply response format (summary/compact/full)
      const decodedItems = decode
        ? page.pageItems.map((item) => {
            const topics = Array.isArray(item.topics)
              ? item.topics.filter((value): value is string => typeof value === 'string')
              : []
            const data = typeof item.data === 'string' ? item.data : '0x'
            return {
              ...item,
              decoded_log: decodeLog({
                address: String(item.address ?? ''),
                topics,
                data,
                transactionHash:
                  typeof item.transactionHash === 'string'
                    ? item.transactionHash
                    : typeof item.tx_hash === 'string'
                      ? item.tx_hash
                      : undefined,
                logIndex:
                  typeof item.logIndex === 'number'
                    ? item.logIndex
                    : typeof item.log_index === 'number'
                      ? item.log_index
                      : undefined,
              }),
            }
          })
        : page.pageItems
      const formattedData = applyResponseFormat(decodedItems, effectiveResponseFormat, 'logs')
      const notices = [
        ...getTimestampWindowNotices(resolvedBlocks),
        ...getValidationNotices(validation),
        ...buildTokenResolutionNotices(tokenSymbolResolutions, unresolvedTokenSymbols),
        ...buildTokenListLookupNotices(tokenSymbolLookup),
      ]
      if (openEndedLatestBlockWindow) {
        notices.push('Open-ended from_block was resolved through the latest indexed head for scan_order=latest.')
      }
      if (boundedFilteredLatestScan) {
        notices.push(
          `Used a bounded filtered latest scan strategy: scan backward from the indexed head in small concurrent chunks, inspecting at most ${(max_scan_blocks ?? DEFAULT_SELECTIVE_LATEST_SCAN_BLOCKS).toLocaleString()} blocks unless a match is proven sooner.`,
        )
      }
      if (nextCursor) notices.push(buildCursorDirectionNotice(scan_order))
      const boundedSearchNotice = scanResult ? buildBoundedSearchNotice(scanResult, 'EVM log scan') : undefined
      if (boundedSearchNotice) notices.push(boundedSearchNotice)
      const freshness = buildQueryFreshness({
        finality: finalized_only ? 'finalized' : 'latest',
        headBlockNumber: head.number,
        windowToBlock: endBlock,
        resolvedWindow: resolvedBlocks,
      })
      const coverage = buildQueryCoverage({
        windowFromBlock: resolvedFromBlock,
        windowToBlock: endBlock,
        pageToBlock: scanResult && scan_order === 'earliest' ? scanResult.scannedToBlock : pageToBlock,
        items: page.pageItems,
        getBlockNumber,
        hasMore: page.hasMore,
        /* A backward scan stops once the page is full, so the blocks below
           its last chunk were never read; the fetch says whether it got to
           the window start. */
        windowComplete: scanResult ? !scanResult.hasUnscannedBlocks : (recentScan?.exhausted ?? true),
      })

      const scannedEndLabel = scan_order === 'earliest' ? 'oldest' : 'newest'
      const unscannedEndLabel = scan_order === 'earliest' ? 'newer' : 'older'
      const message =
        effectiveResponseFormat === 'summary'
          ? `Log summary for ${page.pageItems.length} logs${page.hasMore ? ' (preview page)' : ''}`
          : scanResult?.hasUnscannedBlocks
            ? page.pageItems.length > 0
              ? `Retrieved ${page.pageItems.length} logs from the ${scannedEndLabel} ${scanResult.scannedBlocks.toLocaleString()} blocks; ${unscannedEndLabel} requested blocks were not scanned`
              : `No matching logs found in the ${scannedEndLabel} ${scanResult.scannedBlocks.toLocaleString()} blocks; ${unscannedEndLabel} requested blocks were not scanned`
            : scanResult
              ? `Retrieved ${page.pageItems.length} logs by scanning ${scan_order === 'latest' ? 'backward from the end' : 'forward from the start'} of the window`
              : `Retrieved ${page.pageItems.length} logs${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
        toolName: 'portal_evm_query_logs',
        notices,
        pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
        ordering: buildChronologicalPageOrdering({
          sortedBy: 'block_number',
          tieBreakers: ['logIndex', 'transactionIndex', 'transactionHash'],
          ...(scan_order === 'earliest'
            ? { windowFocus: 'oldest_matches' as const, continuation: 'newer' as const }
            : {}),
        }),
        freshness,
        coverage,
        execution: {
          ...buildExecutionMetadata({
            response_format: effectiveResponseFormat,
            finalized_only,
            limit,
            from_block: resolvedFromBlock,
            to_block: endBlock,
            page_to_block: pageToBlock,
            scan_order,
            range_kind: resolvedBlocks.range_kind,
            decode,
            notes: [
              token_symbols && token_symbols.length > 0
                ? 'token_symbols were resolved from open token-list data and merged into addresses.'
                : undefined,
              openEndedLatestBlockWindow
                ? 'Open-ended from_block searched through the latest indexed head because scan_order=latest.'
                : undefined,
              boundedFilteredLatestScan
                ? 'Bounded filtered latest scan used small concurrent reverse chunks to keep sparse mint/event searches within MCP timeouts.'
                : undefined,
              include_transaction || include_transaction_traces || include_transaction_logs
                ? 'Parent transaction context was requested for matching logs.'
                : `Using ${field_preset} field preset.`,
            ].filter((note): note is string => Boolean(note)),
            normalized_output: true,
          }),
          ...(scanResult ? buildBoundedSearchExecution(scanResult) : {}),
        },
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
