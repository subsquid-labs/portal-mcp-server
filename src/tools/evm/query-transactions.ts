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
import { buildTableDescriptor } from '../../helpers/chart-metadata.js'
import {
  type TokenListLookupMetadata,
  type TokenSymbolResolution,
  buildTokenListLookupNotices,
  resolveTokenSymbolsForQuery,
} from '../../helpers/entity-resolution.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { resolveMethodSighashes } from '../../helpers/evm-aliases.js'
import { portalFetchRecentRecordsWithScan, portalFetchStreamRange } from '../../helpers/fetch.js'
import { getTransactionFields } from '../../helpers/field-presets.js'
import {
  buildEvmLogFields,
  buildEvmStateDiffFields,
  buildEvmTraceFields,
  buildEvmTransactionFields,
} from '../../helpers/fields.js'
import { formatResult, formatTimestamp, formatTransactionFields } from '../../helpers/format.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import { normalizeEvmTransactionResult } from '../../helpers/normalized-results.js'
import {
  buildCursorDirectionNotice,
  buildPaginationInfo,
  decodeRecentPageCursor,
  encodeRecentPageCursor,
  paginateAscendingItems,
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
      transactions?: Record<string, unknown>[]
    }

    const blockNumber = typedBlock.number ?? typedBlock.header?.number
    const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

    return (typedBlock.transactions || []).map((tx) =>
      normalizeEvmTransactionResult(
        formatTransactionFields({
          ...tx,
          ...(readBigIntField(tx, 'value') !== undefined
            ? { value_wei: readBigIntField(tx, 'value')?.toString() }
            : {}),
          ...(readBigIntField(tx, 'effectiveGasPrice') !== undefined
            ? { effectiveGasPrice_wei: readBigIntField(tx, 'effectiveGasPrice')?.toString() }
            : {}),
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
  from_token_symbols?: string[]
  to_token_symbols?: string[]
  max_token_symbol_matches?: number
  sighash?: string[]
  method?: string | string[]
  transaction_hash?: string
  transaction_type?: number
  transaction_status?: number
  contract_creation?: boolean
  min_value_wei?: string | number
  min_gas_used?: string | number
  min_effective_gas_price_wei?: string | number
  order_by?: 'chronological' | 'value_desc' | 'gas_used_desc' | 'effective_gas_price_desc'
  aggregate_by?: 'sender' | 'receiver'
  aggregate_metric?: 'count' | 'value' | 'gas_used' | 'effective_gas_price'
  max_scan_blocks?: number
  scan_order?: 'earliest' | 'latest'
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

type TransactionAggregateRow = {
  rank: number
  address: string
  transaction_count: number
  total_value_wei: string
  total_gas_used: string
  max_gas_used: string
  max_effective_gas_price_wei: string
  first_block?: number
  last_block?: number
  sample_transaction_hash?: string
}

function getBlockNumber(tx: EvmTransactionItem): number | undefined {
  return typeof tx.block_number === 'number' ? tx.block_number : undefined
}

const uniqueStrings = (values: string[]) => Array.from(new Set(values))

function buildTokenResolutionNotices(
  resolutions: TokenSymbolResolution[],
  unresolvedSymbols: string[],
  fieldName: string,
) {
  const notices: string[] = []
  if (unresolvedSymbols.length > 0) {
    notices.push(
      `No token-list match found for ${fieldName}: ${unresolvedSymbols.map((symbol) => quoteUntrusted(symbol)).join(', ')}.`,
    )
  }
  for (const resolution of resolutions) {
    if (resolution.matches.length > 1) {
      notices.push(
        `${fieldName} ${quoteUntrusted(resolution.symbol)} resolved to ${resolution.matches.length} token-list matches; all selected addresses were included. Use from_addresses/to_addresses for deterministic single-contract filters.`,
      )
    }
    if (resolution.truncated) {
      notices.push(
        `${fieldName} ${quoteUntrusted(resolution.symbol)} had more matches than max_token_symbol_matches; results were capped.`,
      )
    }
  }
  return notices
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

function normalizeTransactionType(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().toLowerCase().startsWith('0x')
        ? Number.parseInt(value.trim().slice(2), 16)
        : typeof value === 'string'
          ? Number(value.trim())
          : Number.NaN

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`transaction_type must be a non-negative integer or hex string such as "0x1"; got ${String(value)}`)
  }

  return parsed
}

function getTransactionType(tx: Record<string, unknown>): number | undefined {
  const value = tx.type
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = value.toLowerCase().startsWith('0x') ? Number.parseInt(value.slice(2), 16) : Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function matchesTransactionType(tx: Record<string, unknown>, type: number | undefined): boolean {
  return type === undefined || getTransactionType(tx) === type
}

function normalizeTransactionStatus(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === true || value === 'success' || value === 'succeeded' || value === 'ok' || value === '1') return 1
  if (
    value === false ||
    value === 'failed' ||
    value === 'failure' ||
    value === 'error' ||
    value === 'reverted' ||
    value === '0'
  )
    return 0

  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (parsed === 0 || parsed === 1) return parsed
  throw new Error(`transaction_status must be "success", "failed", 1, or 0; got ${String(value)}`)
}

function normalizeBigIntFilter(value: string | number | undefined, name: string): bigint | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`)
    return BigInt(Math.trunc(value))
  }
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return undefined
  if (!/^(0x[0-9a-f]+|\d+)$/.test(trimmed)) {
    throw new Error(`${name} must be a non-negative integer string or hex string.`)
  }
  return BigInt(trimmed)
}

function readBigIntField(tx: Record<string, unknown>, field: string): bigint | undefined {
  const comparableAliases: Record<string, string[]> = {
    value: ['value_wei'],
    effectiveGasPrice: ['effectiveGasPrice_wei'],
  }
  const candidateFields = [field, ...(comparableAliases[field] ?? [])]

  for (const candidateField of candidateFields) {
    const value = tx[candidateField]
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
    if (typeof value === 'string') {
      const trimmed = value.trim().toLowerCase()
      if (/^(0x[0-9a-f]+|\d+)$/.test(trimmed)) return BigInt(trimmed)
    }
  }
  return undefined
}

function matchesClientTransactionFilters(
  tx: Record<string, unknown>,
  filters: {
    transactionHash?: string
    transactionType?: number
    transactionStatus?: number
    contractCreation?: boolean
    minValueWei?: bigint
    minGasUsed?: bigint
    minEffectiveGasPriceWei?: bigint
  },
): boolean {
  if (filters.transactionHash !== undefined) {
    const hash = String(tx.hash ?? tx.tx_hash ?? '').toLowerCase()
    if (hash !== filters.transactionHash) return false
  }
  if (!matchesTransactionType(tx, filters.transactionType)) return false

  if (filters.transactionStatus !== undefined) {
    const status =
      typeof tx.status === 'number' ? tx.status : typeof tx.status === 'string' ? Number(tx.status) : undefined
    if (status !== filters.transactionStatus) return false
  }

  if (filters.contractCreation !== undefined) {
    const createsContract =
      !tx.to || tx.to === null || (tx.contractAddress !== undefined && tx.contractAddress !== null)
    if (createsContract !== filters.contractCreation) return false
  }

  if (filters.minValueWei !== undefined && (readBigIntField(tx, 'value') ?? 0n) < filters.minValueWei) return false
  if (filters.minGasUsed !== undefined && (readBigIntField(tx, 'gasUsed') ?? 0n) < filters.minGasUsed) return false
  if (
    filters.minEffectiveGasPriceWei !== undefined &&
    (readBigIntField(tx, 'effectiveGasPrice') ?? 0n) < filters.minEffectiveGasPriceWei
  )
    return false

  return true
}

function rankValue(tx: EvmTransactionItem, orderBy: QueryTransactionsRequest['order_by']): bigint {
  switch (orderBy) {
    case 'value_desc':
      return readBigIntField(tx, 'value') ?? 0n
    case 'gas_used_desc':
      return readBigIntField(tx, 'gasUsed') ?? 0n
    case 'effective_gas_price_desc':
      return readBigIntField(tx, 'effectiveGasPrice') ?? 0n
    default:
      return 0n
  }
}

function orderTransactionsForOutput(items: EvmTransactionItem[], orderBy: QueryTransactionsRequest['order_by']) {
  if (!orderBy || orderBy === 'chronological') return sortTransactions(items)

  return items.sort((left, right) => {
    const leftValue = rankValue(left, orderBy)
    const rightValue = rankValue(right, orderBy)
    if (leftValue !== rightValue) return leftValue > rightValue ? -1 : 1

    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) return rightBlock - leftBlock

    return getTransactionIndex(right) - getTransactionIndex(left)
  })
}

function getAggregateAddress(
  tx: EvmTransactionItem,
  aggregateBy: NonNullable<QueryTransactionsRequest['aggregate_by']>,
): string | undefined {
  const value = aggregateBy === 'sender' ? tx.from : tx.to
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined
}

function getAggregateSortValue(
  row: Omit<TransactionAggregateRow, 'rank'>,
  metric: NonNullable<QueryTransactionsRequest['aggregate_metric']>,
): bigint {
  switch (metric) {
    case 'value':
      return BigInt(row.total_value_wei)
    case 'gas_used':
      return BigInt(row.total_gas_used)
    case 'effective_gas_price':
      return BigInt(row.max_effective_gas_price_wei)
    case 'count':
    default:
      return BigInt(row.transaction_count)
  }
}

function aggregateTransactions(
  items: EvmTransactionItem[],
  aggregateBy: NonNullable<QueryTransactionsRequest['aggregate_by']>,
  metric: NonNullable<QueryTransactionsRequest['aggregate_metric']>,
  limit: number,
): TransactionAggregateRow[] {
  const groups = new Map<string, Omit<TransactionAggregateRow, 'rank'>>()

  for (const tx of items) {
    const address = getAggregateAddress(tx, aggregateBy)
    if (!address) continue

    const existing = groups.get(address) ?? {
      address,
      transaction_count: 0,
      total_value_wei: '0',
      total_gas_used: '0',
      max_gas_used: '0',
      max_effective_gas_price_wei: '0',
      first_block: undefined,
      last_block: undefined,
      sample_transaction_hash: typeof tx.hash === 'string' ? tx.hash : undefined,
    }

    const value = readBigIntField(tx, 'value') ?? 0n
    const gasUsed = readBigIntField(tx, 'gasUsed') ?? 0n
    const effectiveGasPrice = readBigIntField(tx, 'effectiveGasPrice') ?? 0n
    const blockNumber = getBlockNumber(tx)

    existing.transaction_count += 1
    existing.total_value_wei = (BigInt(existing.total_value_wei) + value).toString()
    existing.total_gas_used = (BigInt(existing.total_gas_used) + gasUsed).toString()
    existing.max_gas_used = (
      BigInt(existing.max_gas_used) > gasUsed ? BigInt(existing.max_gas_used) : gasUsed
    ).toString()
    existing.max_effective_gas_price_wei = (
      BigInt(existing.max_effective_gas_price_wei) > effectiveGasPrice
        ? BigInt(existing.max_effective_gas_price_wei)
        : effectiveGasPrice
    ).toString()
    existing.first_block =
      blockNumber === undefined ? existing.first_block : Math.min(existing.first_block ?? blockNumber, blockNumber)
    existing.last_block =
      blockNumber === undefined ? existing.last_block : Math.max(existing.last_block ?? blockNumber, blockNumber)
    if (!existing.sample_transaction_hash && typeof tx.hash === 'string') existing.sample_transaction_hash = tx.hash

    groups.set(address, existing)
  }

  return [...groups.values()]
    .sort((left, right) => {
      const leftValue = getAggregateSortValue(left, metric)
      const rightValue = getAggregateSortValue(right, metric)
      if (leftValue !== rightValue) return leftValue > rightValue ? -1 : 1
      if (left.transaction_count !== right.transaction_count) return right.transaction_count - left.transaction_count
      return left.address.localeCompare(right.address)
    })
    .slice(0, limit)
    .map((row, index) => ({ rank: index + 1, ...row }))
}

export async function fetchAdaptiveTransactionRange<T>(
  fromBlock: number,
  toBlock: number,
  fetchRange: (rangeFrom: number, rangeTo: number) => Promise<T[]>,
): Promise<T[]> {
  try {
    return await fetchRange(fromBlock, toBlock)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/response too large/i.test(message) && fromBlock < toBlock) {
      const midpoint = fromBlock + Math.floor((toBlock - fromBlock) / 2)
      const left = await fetchAdaptiveTransactionRange(fromBlock, midpoint, fetchRange)
      const right = await fetchAdaptiveTransactionRange(midpoint + 1, toBlock, fetchRange)
      return [...left, ...right]
    }
    throw error
  }
}

async function fetchTransactionsByScanOrder({
  url,
  query,
  fromBlock,
  toBlock,
  limit,
  chunkSize,
  scanOrder,
  orderBy,
  maxScanBlocks,
  clientFilters,
  candidateLimit,
  offset = 0,
}: {
  url: string
  query: Record<string, unknown>
  fromBlock: number
  toBlock: number
  limit: number
  chunkSize: number
  scanOrder: 'earliest' | 'latest'
  orderBy: QueryTransactionsRequest['order_by']
  maxScanBlocks: number
  clientFilters: Parameters<typeof matchesClientTransactionFilters>[1]
  candidateLimit?: number
  offset?: number
}) {
  const targetCount = offset + limit + 1
  const effectiveCandidateLimit =
    candidateLimit ?? (orderBy && orderBy !== 'chronological' ? Math.max((offset + limit) * 20, 500) : targetCount)
  const collected: EvmTransactionItem[] = []
  let candidateLimitReached = false
  const scan = await scanBoundedBlockRange<EvmTransactionItem>({
    fromBlock,
    toBlock,
    chunkSize,
    scanOrder,
    maxScanBlocks,
    shouldContinue: () => collected.length < effectiveCandidateLimit,
    fetchChunk: async (chunk) => {
      const records = await fetchAdaptiveTransactionRange(chunk.fromBlock, chunk.toBlock, (rangeFrom, rangeTo) =>
        portalFetchStreamRange(url, {
          ...query,
          fromBlock: rangeFrom,
          toBlock: rangeTo,
        }),
      )
      const txs = sortTransactions(flattenTransactionsWithBlockContext(records) as EvmTransactionItem[]).filter((tx) =>
        matchesClientTransactionFilters(tx, clientFilters),
      )
      const orderedChunk = scanOrder === 'latest' ? txs.reverse() : txs
      const selected: EvmTransactionItem[] = []
      for (const tx of orderedChunk) {
        if (collected.length + selected.length >= effectiveCandidateLimit) {
          candidateLimitReached = true
          break
        }
        selected.push(tx)
      }
      collected.push(...selected)
      return selected
    },
  })

  const ordered = orderTransactionsForOutput(collected, orderBy)
  // A 'latest' scan accumulates candidates from the newest end, while the
  // chronological output is oldest-first. Offsetting from the oldest end then
  // moved the window by exactly as many rows as each new page added, so every
  // continuation returned the same page and the newest match was never shown.
  // Rank-ordered output is genuinely offset from its top, so it keeps slicing
  // from the front.
  const chronological = !orderBy || orderBy === 'chronological'
  const items =
    chronological && scanOrder === 'latest'
      ? ordered.slice(Math.max(0, ordered.length - offset - limit), Math.max(0, ordered.length - offset))
      : ordered.slice(offset, offset + limit)
  return {
    ...scan,
    items,
    candidates: ordered,
    hasMore: collected.length > offset + limit,
    candidateCount: collected.length,
    candidateLimit: effectiveCandidateLimit,
    candidateLimitReached,
    hasUnscannedBlocks: scan.hasUnscannedBlocks || candidateLimitReached,
    offset,
  }
}

export function registerQueryTransactionsTool(server: McpServer) {
  registerPortalTool(
    server,
    'portal_evm_query_transactions',
    buildToolDescription('portal_evm_query_transactions'),
    {
      network: z.string().optional().describe('Network name or alias. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .describe(
          "Natural time range such as '5m', '1h', '24h', '7d', or 'past 30 minutes'. Alternative to from_block/to_block. Large ranges are allowed with a low limit (<=100).",
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
      from_token_symbols: z
        .array(z.string())
        .optional()
        .describe(
          'Resolve token symbols via open token-list data and merge them into from_addresses. Rare, but useful for token-contract-originated transactions.',
        ),
      to_token_symbols: z
        .array(z.string())
        .optional()
        .describe(
          'Resolve token symbols via open token-list data and merge them into to_addresses, e.g. transfer/approve calls to USDC.',
        ),
      max_token_symbol_matches: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe(
          'Maximum token-list matches to include per token symbol. Use from_addresses/to_addresses for deterministic single-contract filters.',
        ),
      sighash: z
        .array(z.string())
        .optional()
        .describe("FILTER: Function sighash (4-byte hex, e.g., '0xa9059cbb' for transfer). Optional if limit <=100."),
      method: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'FILTER: Common EVM method alias or 4-byte sighash. Examples: "transfer", "approve", "swap", "transferFrom", "deposit", "withdraw". Merges with sighash.',
        ),
      transaction_hash: z
        .string()
        .optional()
        .describe(
          'FILTER: Exact 32-byte EVM transaction hash (0x...). Combine with from_block/to_block or a narrow timeframe; stops as soon as matched.',
        ),
      transaction_type: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'FILTER: EVM transaction type. Accepts decimal or hex strings such as 0, 1, 2, "0x0", "0x1", "0x2". Applied client-side while streaming Portal results; use with scan_order="earliest" and from_block to find the first typed transaction.',
        ),
      transaction_status: z
        .union([z.enum(['success', 'failed', 'succeeded', 'reverted']), z.number(), z.string()])
        .optional()
        .describe(
          'FILTER: Transaction receipt status. Use "success"/1 or "failed"/0 for failed/reverted transaction searches.',
        ),
      contract_creation: z
        .boolean()
        .optional()
        .describe(
          'FILTER: true returns contract-creation transactions; false excludes them. Useful for "first contract creation from this wallet".',
        ),
      min_value_wei: z
        .union([z.string(), z.number()])
        .optional()
        .describe('FILTER/RANKING: Minimum native token value in wei. Accepts decimal or hex string.'),
      min_gas_used: z
        .union([z.string(), z.number()])
        .optional()
        .describe('FILTER/RANKING: Minimum receipt gasUsed. Accepts decimal or hex string.'),
      min_effective_gas_price_wei: z
        .union([z.string(), z.number()])
        .optional()
        .describe('FILTER/RANKING: Minimum effectiveGasPrice in wei. Accepts decimal or hex string.'),
      order_by: z
        .enum(['chronological', 'value_desc', 'gas_used_desc', 'effective_gas_price_desc'])
        .optional()
        .default('chronological')
        .describe('Optional ranking for top-N questions. Use value_desc, gas_used_desc, or effective_gas_price_desc.'),
      aggregate_by: z
        .enum(['sender', 'receiver'])
        .optional()
        .describe(
          'Optional bounded aggregation for top sender/receiver questions. Returns ranked address rows instead of raw transactions.',
        ),
      aggregate_metric: z
        .enum(['count', 'value', 'gas_used', 'effective_gas_price'])
        .optional()
        .default('count')
        .describe(
          'Metric used with aggregate_by. count ranks by tx count; value by total native value; gas_used by total gas used; effective_gas_price by max effective gas price.',
        ),
      max_scan_blocks: z
        .number()
        .max(50000)
        .optional()
        .describe('Safety cap for first/last/ranked client-side scans. Default: min(window, 10000 blocks).'),
      scan_order: z
        .enum(['latest', 'earliest'])
        .optional()
        .describe(
          'Which side of the block window to scan first. Normal previews default to latest; transaction_type searches default to earliest, so "first tx type 0x1 from block N" scans forward from from_block.',
        ),
      first_nonce: z.number().optional().describe('Minimum nonce'),
      last_nonce: z.number().optional().describe('Maximum nonce'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .default(20)
        .describe(
          'Max transactions (default: 20, max: 25). This verified ceiling keeps pages within MCP client budgets.',
        ),
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
        .describe(
          "Response format: defaults to 'compact' for chat-friendly output, or stays 'full' when inline logs, traces, or state diffs are requested. Use 'summary' for counting or profiling.",
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
      from_token_symbols,
      to_token_symbols,
      max_token_symbol_matches,
      sighash,
      method,
      transaction_hash,
      transaction_type,
      transaction_status,
      contract_creation,
      min_value_wei,
      min_gas_used,
      min_effective_gas_price_wei,
      order_by,
      aggregate_by,
      aggregate_metric,
      max_scan_blocks,
      scan_order,
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
        from_token_symbols = paginationCursor.request.from_token_symbols
        to_token_symbols = paginationCursor.request.to_token_symbols
        max_token_symbol_matches = paginationCursor.request.max_token_symbol_matches ?? 5
        sighash = paginationCursor.request.sighash
        method = paginationCursor.request.method
        transaction_hash = paginationCursor.request.transaction_hash
        transaction_type = paginationCursor.request.transaction_type
        transaction_status = paginationCursor.request.transaction_status
        contract_creation = paginationCursor.request.contract_creation
        min_value_wei = paginationCursor.request.min_value_wei
        min_gas_used = paginationCursor.request.min_gas_used
        min_effective_gas_price_wei = paginationCursor.request.min_effective_gas_price_wei
        order_by = paginationCursor.request.order_by ?? 'chronological'
        aggregate_by = paginationCursor.request.aggregate_by
        aggregate_metric = paginationCursor.request.aggregate_metric ?? 'count'
        max_scan_blocks = paginationCursor.request.max_scan_blocks
        scan_order = paginationCursor.request.scan_order
        first_nonce = paginationCursor.request.first_nonce
        last_nonce = paginationCursor.request.last_nonce
        field_preset = paginationCursor.request.field_preset
        response_format = paginationCursor.request.response_format
        include_logs = paginationCursor.request.include_logs
        include_traces = paginationCursor.request.include_traces
        include_state_diffs = paginationCursor.request.include_state_diffs
        include_l2_fields = paginationCursor.request.include_l2_fields
      }
      const effectiveResponseFormat = resolveDefaultResponseFormat(response_format, {
        preserveFullIf: include_logs || include_traces || include_state_diffs,
      })

      // Resolve timeframe or use explicit blocks
      const resolvedBlocks = paginationCursor
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
      const resolvedFromBlock = resolvedBlocks.from_block
      const resolvedToBlock = resolvedBlocks.to_block

      const normalizedFromAddressFilters = normalizeAddresses(from_addresses, chainType) ?? []
      const normalizedToAddressFilters = normalizeAddresses(to_addresses, chainType) ?? []
      let fromTokenSymbolResolutions: TokenSymbolResolution[] = []
      let toTokenSymbolResolutions: TokenSymbolResolution[] = []
      let unresolvedFromTokenSymbols: string[] = []
      let unresolvedToTokenSymbols: string[] = []
      let resolvedFromTokenSymbolAddresses: string[] = []
      let resolvedToTokenSymbolAddresses: string[] = []
      let fromTokenSymbolLookup: TokenListLookupMetadata | undefined
      let toTokenSymbolLookup: TokenListLookupMetadata | undefined
      if (!paginationCursor && from_token_symbols && from_token_symbols.length > 0) {
        const resolvedSymbols = await resolveTokenSymbolsForQuery({
          dataset,
          symbols: from_token_symbols,
          maxMatchesPerSymbol: max_token_symbol_matches,
        })
        fromTokenSymbolResolutions = resolvedSymbols.resolutions
        unresolvedFromTokenSymbols = resolvedSymbols.unresolved_symbols
        resolvedFromTokenSymbolAddresses = resolvedSymbols.addresses
        fromTokenSymbolLookup = resolvedSymbols.lookup
        if (resolvedFromTokenSymbolAddresses.length === 0 && normalizedFromAddressFilters.length === 0) {
          throw new Error(
            `No token-list matches found for from_token_symbols: ${from_token_symbols.map((symbol) => quoteUntrusted(symbol)).join(', ')}. Use portal_resolve_entity to inspect matches or pass from_addresses directly.`,
          )
        }
      }
      if (!paginationCursor && to_token_symbols && to_token_symbols.length > 0) {
        const resolvedSymbols = await resolveTokenSymbolsForQuery({
          dataset,
          symbols: to_token_symbols,
          maxMatchesPerSymbol: max_token_symbol_matches,
        })
        toTokenSymbolResolutions = resolvedSymbols.resolutions
        unresolvedToTokenSymbols = resolvedSymbols.unresolved_symbols
        resolvedToTokenSymbolAddresses = resolvedSymbols.addresses
        toTokenSymbolLookup = resolvedSymbols.lookup
        if (resolvedToTokenSymbolAddresses.length === 0 && normalizedToAddressFilters.length === 0) {
          throw new Error(
            `No token-list matches found for to_token_symbols: ${to_token_symbols.map((symbol) => quoteUntrusted(symbol)).join(', ')}. Use portal_resolve_entity to inspect matches or pass to_addresses directly.`,
          )
        }
      }
      const normalizedFrom = uniqueStrings([...normalizedFromAddressFilters, ...resolvedFromTokenSymbolAddresses])
      const normalizedTo = uniqueStrings([...normalizedToAddressFilters, ...resolvedToTokenSymbolAddresses])
      const fromFilters = normalizedFrom.length > 0 ? normalizedFrom : undefined
      const toFilters = normalizedTo.length > 0 ? normalizedTo : undefined
      const normalizedSighash = Array.from(
        new Set([...(sighash ?? []), ...resolveMethodSighashes(method)].map((value) => value.toLowerCase())),
      )
      const normalizedTransactionHash = transaction_hash?.trim().toLowerCase()
      if (normalizedTransactionHash !== undefined && !/^0x[0-9a-f]{64}$/.test(normalizedTransactionHash)) {
        throw new ActionableError(
          `Invalid transaction_hash: ${quoteUntrusted(transaction_hash ?? '')}. Expected a 32-byte 0x-prefixed hex hash.`,
          ['Pass a 66-character transaction hash such as 0x... and narrow the block range or timeframe.'],
          { field: 'transaction_hash' },
          { code: 'invalid_request', origin: 'client_input', retryable: false },
        )
      }
      const normalizedTransactionType = normalizeTransactionType(transaction_type)
      const normalizedTransactionStatus = normalizeTransactionStatus(transaction_status)
      const normalizedMinValueWei = normalizeBigIntFilter(min_value_wei, 'min_value_wei')
      const normalizedMinGasUsed = normalizeBigIntFilter(min_gas_used, 'min_gas_used')
      const normalizedMinEffectiveGasPriceWei = normalizeBigIntFilter(
        min_effective_gas_price_wei,
        'min_effective_gas_price_wei',
      )
      const effectiveOrderBy = order_by ?? 'chronological'
      const effectiveAggregateMetric = aggregate_metric ?? 'count'
      const hasClientFilters =
        normalizedTransactionHash !== undefined ||
        normalizedTransactionType !== undefined ||
        normalizedTransactionStatus !== undefined ||
        contract_creation !== undefined ||
        normalizedMinValueWei !== undefined ||
        normalizedMinGasUsed !== undefined ||
        normalizedMinEffectiveGasPriceWei !== undefined ||
        effectiveOrderBy !== 'chronological' ||
        aggregate_by !== undefined
      const effectiveScanOrder: 'earliest' | 'latest' =
        scan_order ??
        (normalizedTransactionHash !== undefined
          ? from_block !== undefined && to_block === undefined
            ? 'earliest'
            : 'latest'
          : hasClientFilters && effectiveOrderBy === 'chronological'
            ? 'earliest'
            : 'latest')
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
      const hasFilters = !!(
        fromFilters ||
        toFilters ||
        normalizedSighash.length > 0 ||
        first_nonce !== undefined ||
        last_nonce !== undefined ||
        hasClientFilters
      )

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
      if (fromFilters) txFilter.from = fromFilters
      if (toFilters) txFilter.to = toFilters
      if (normalizedSighash.length > 0) txFilter.sighash = normalizedSighash
      if (first_nonce !== undefined) txFilter.firstNonce = first_nonce
      if (last_nonce !== undefined) txFilter.lastNonce = last_nonce
      if (include_logs) txFilter.logs = true
      if (include_traces) txFilter.traces = true
      if (include_state_diffs) txFilter.stateDiffs = true

      // Use field preset to control response size. A summary adds up gas, which
      // the 'minimal' preset does not request, so a minimal summary reported a
      // confident total_gas of 0 over transactions that burned real gas. Same
      // defect and same fix as portal_evm_query_traces: a summary reads at
      // least the standard field set.
      const effectiveFieldPreset =
        effectiveResponseFormat === 'summary' && (field_preset || 'standard') === 'minimal'
          ? 'standard'
          : field_preset || 'standard'
      const presetFields = getTransactionFields(effectiveFieldPreset)
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
        type: true,
        status: true,
        contractAddress: true,
      }
      if (
        normalizedMinGasUsed !== undefined ||
        effectiveOrderBy === 'gas_used_desc' ||
        (aggregate_by !== undefined && effectiveAggregateMetric === 'gas_used')
      ) {
        fields.transaction = {
          ...(fields.transaction as Record<string, boolean>),
          gasUsed: true,
        }
      }
      if (
        normalizedMinEffectiveGasPriceWei !== undefined ||
        effectiveOrderBy === 'effective_gas_price_desc' ||
        (aggregate_by !== undefined && effectiveAggregateMetric === 'effective_gas_price')
      ) {
        fields.transaction = {
          ...(fields.transaction as Record<string, boolean>),
          effectiveGasPrice: true,
        }
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
      const adaptiveChunkSize = hasFilters
        ? 500
        : Math.max(
            10,
            Math.min(40, fetchLimit * (effectiveResponseFormat === 'summary' ? 4 : field_preset === 'minimal' ? 5 : 3)),
          )
      const portalUrl = `${PORTAL_URL}/datasets/${dataset}/stream`
      const scanPath = effectiveScanOrder === 'earliest' || hasClientFilters
      const recentFetch = scanPath
        ? undefined
        : await portalFetchRecentRecordsWithScan(portalUrl, query, {
            itemKeys: ['transactions'],
            limit: fetchLimit,
            chunkSize: adaptiveChunkSize,
          })
      const results = recentFetch?.records ?? []
      const recentScan = recentFetch?.scan

      const scanResult = scanPath
        ? await fetchTransactionsByScanOrder({
            url: portalUrl,
            query,
            fromBlock: resolvedFromBlock,
            toBlock: pageToBlock,
            limit,
            chunkSize:
              normalizedTransactionHash && !fromFilters && !toFilters
                ? 50
                : normalizedTransactionType !== undefined
                  ? 100
                  : adaptiveChunkSize,
            scanOrder: effectiveScanOrder,
            orderBy: effectiveOrderBy,
            maxScanBlocks: Math.max(
              1,
              Math.min(
                max_scan_blocks ??
                  (normalizedTransactionHash && !fromFilters && !toFilters ? 1000 : aggregate_by ? 1000 : 10000),
                endBlock - resolvedFromBlock + 1,
              ),
            ),
            clientFilters: {
              transactionHash: normalizedTransactionHash,
              transactionType: normalizedTransactionType,
              transactionStatus: normalizedTransactionStatus,
              contractCreation: contract_creation,
              minValueWei: normalizedMinValueWei,
              minGasUsed: normalizedMinGasUsed,
              minEffectiveGasPriceWei: normalizedMinEffectiveGasPriceWei,
            },
            candidateLimit: normalizedTransactionHash ? 1 : aggregate_by ? Math.max(limit * 200, 5000) : undefined,
            offset: paginationCursor?.skip_inclusive_block ?? 0,
          })
        : undefined
      const allTxs = scanResult
        ? scanResult.items
        : orderTransactionsForOutput(
            flattenTransactionsWithBlockContext(results) as EvmTransactionItem[],
            effectiveOrderBy,
          )
      const page = scanResult
        ? {
            pageItems: scanResult.items,
            hasMore: scanResult.hasMore,
            nextBoundary: undefined,
          }
        : paginateAscendingItems(
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
      const cursorRequest: QueryTransactionsRequest = {
        ...(timeframe ? { timeframe } : {}),
        ...(from_timestamp !== undefined ? { from_timestamp } : {}),
        ...(to_timestamp !== undefined ? { to_timestamp } : {}),
        limit,
        finalized_only,
        ...(fromFilters ? { from_addresses: fromFilters } : {}),
        ...(toFilters ? { to_addresses: toFilters } : {}),
        ...(from_token_symbols ? { from_token_symbols } : {}),
        ...(to_token_symbols ? { to_token_symbols } : {}),
        ...(max_token_symbol_matches !== undefined ? { max_token_symbol_matches } : {}),
        ...(normalizedSighash.length > 0 ? { sighash: normalizedSighash } : {}),
        ...(method ? { method } : {}),
        ...(normalizedTransactionHash ? { transaction_hash: normalizedTransactionHash } : {}),
        ...(normalizedTransactionType !== undefined ? { transaction_type: normalizedTransactionType } : {}),
        ...(normalizedTransactionStatus !== undefined ? { transaction_status: normalizedTransactionStatus } : {}),
        ...(contract_creation !== undefined ? { contract_creation } : {}),
        ...(min_value_wei !== undefined ? { min_value_wei } : {}),
        ...(min_gas_used !== undefined ? { min_gas_used } : {}),
        ...(min_effective_gas_price_wei !== undefined ? { min_effective_gas_price_wei } : {}),
        order_by: effectiveOrderBy,
        ...(aggregate_by ? { aggregate_by } : {}),
        aggregate_metric: effectiveAggregateMetric,
        ...(max_scan_blocks !== undefined ? { max_scan_blocks } : {}),
        scan_order: effectiveScanOrder,
        ...(first_nonce !== undefined ? { first_nonce } : {}),
        ...(last_nonce !== undefined ? { last_nonce } : {}),
        field_preset,
        response_format: effectiveResponseFormat,
        include_logs,
        include_traces,
        include_state_diffs,
        include_l2_fields,
      }
      const nextCursor =
        scanResult && page.hasMore
          ? encodeRecentPageCursor<QueryTransactionsRequest>({
              tool: 'portal_evm_query_transactions',
              dataset,
              request: cursorRequest,
              window_from_block: resolvedFromBlock,
              window_to_block: endBlock,
              page_to_block: endBlock,
              skip_inclusive_block: scanResult.offset + page.pageItems.length,
            })
          : !scanResult && page.hasMore && page.nextBoundary
            ? encodeRecentPageCursor<QueryTransactionsRequest>({
                tool: 'portal_evm_query_transactions',
                dataset,
                request: cursorRequest,
                window_from_block: resolvedFromBlock,
                window_to_block: endBlock,
                page_to_block: page.nextBoundary.page_to_block,
                skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
              })
            : undefined

      const notices = [
        ...getTimestampWindowNotices(resolvedBlocks),
        ...getValidationNotices(validation),
        ...buildTokenResolutionNotices(fromTokenSymbolResolutions, unresolvedFromTokenSymbols, 'from_token_symbols'),
        ...buildTokenResolutionNotices(toTokenSymbolResolutions, unresolvedToTokenSymbols, 'to_token_symbols'),
        ...buildTokenListLookupNotices(fromTokenSymbolLookup),
        ...buildTokenListLookupNotices(toTokenSymbolLookup),
      ]
      if (aggregate_by) {
        const aggregateRows = aggregateTransactions(
          scanResult?.candidates ?? allTxs,
          aggregate_by,
          effectiveAggregateMetric,
          limit,
        )
        const aggregateKey = aggregate_by === 'sender' ? 'top_senders' : 'top_receivers'
        if (scanResult?.candidateLimitReached) {
          notices.push(
            `Aggregation stopped after ${scanResult.candidateCount.toLocaleString()} candidate transactions. The ranking is partial for the requested window and must not be treated as a complete top-${limit}; narrow the window or add filters for a complete ranking.`,
          )
        } else if (scanResult?.hasUnscannedBlocks) {
          notices.push(
            `Aggregation is bounded to ${scanResult.candidateCount.toLocaleString()} scanned candidate transactions across blocks ${scanResult.scannedFromBlock}-${scanResult.scannedToBlock}; narrow the window or raise max_scan_blocks for deeper coverage.`,
          )
        }
        const boundedSearchNotice =
          scanResult && !scanResult.candidateLimitReached
            ? buildBoundedSearchNotice(scanResult, 'EVM transaction aggregation')
            : undefined
        if (boundedSearchNotice) notices.push(boundedSearchNotice)

        const aggregatePayload = {
          [aggregateKey]: aggregateRows,
          summary: {
            aggregate_by,
            aggregate_metric: effectiveAggregateMetric,
            scanned_transactions: scanResult?.candidateCount ?? allTxs.length,
            scanned_blocks: scanResult?.scannedBlocks,
            window_complete: scanResult ? !scanResult.hasUnscannedBlocks : (recentScan?.exhausted ?? true),
            candidate_limit_reached: scanResult?.candidateLimitReached ?? false,
          },
          tables: [
            buildTableDescriptor({
              id: aggregateKey,
              dataKey: aggregateKey,
              title: scanResult?.hasUnscannedBlocks
                ? aggregate_by === 'sender'
                  ? 'Partial Sender Ranking'
                  : 'Partial Receiver Ranking'
                : aggregate_by === 'sender'
                  ? 'Top Senders'
                  : 'Top Receivers',
              rowCount: aggregateRows.length,
              keyField: 'address',
              defaultSort: {
                key:
                  effectiveAggregateMetric === 'count'
                    ? 'transaction_count'
                    : effectiveAggregateMetric === 'value'
                      ? 'total_value_wei'
                      : effectiveAggregateMetric === 'gas_used'
                        ? 'total_gas_used'
                        : 'max_effective_gas_price_wei',
                direction: 'desc',
              },
              columns: [
                { key: 'rank', label: '#', kind: 'rank', align: 'right' },
                {
                  key: 'address',
                  label: aggregate_by === 'sender' ? 'Sender' : 'Receiver',
                  kind: 'dimension',
                  format: 'address',
                },
                { key: 'transaction_count', label: 'Txs', kind: 'metric', format: 'integer', align: 'right' },
                {
                  key: 'total_value_wei',
                  label: 'Total value (wei)',
                  kind: 'metric',
                  format: 'integer',
                  align: 'right',
                },
                { key: 'total_gas_used', label: 'Total gas used', kind: 'metric', format: 'integer', align: 'right' },
                {
                  key: 'max_effective_gas_price_wei',
                  label: 'Max effective gas price (wei)',
                  kind: 'metric',
                  format: 'integer',
                  align: 'right',
                },
              ],
              dense: true,
            }),
          ],
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
          pageToBlock: scanResult && effectiveScanOrder === 'earliest' ? scanResult.scannedToBlock : pageToBlock,
          items: scanResult?.candidates ?? allTxs,
          getBlockNumber,
          hasMore: false,
          windowComplete: scanResult ? !scanResult.hasUnscannedBlocks : (recentScan?.exhausted ?? true),
        })

        return formatResult(
          aggregatePayload,
          `${scanResult?.hasUnscannedBlocks ? 'Partial ranking' : 'Ranked'} ${aggregateRows.length} ${aggregate_by === 'sender' ? 'senders' : 'receivers'} by ${effectiveAggregateMetric} from ${scanResult?.candidateCount ?? allTxs.length} scanned transactions.`,
          {
            toolName: 'portal_evm_query_transactions',
            notices,
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
                scan_order: effectiveScanOrder,
                order_by: effectiveOrderBy,
                range_kind: resolvedBlocks.range_kind,
                notes: [
                  from_token_symbols && from_token_symbols.length > 0
                    ? 'from_token_symbols were resolved from open token-list data and merged into from_addresses.'
                    : undefined,
                  to_token_symbols && to_token_symbols.length > 0
                    ? 'to_token_symbols were resolved from open token-list data and merged into to_addresses.'
                    : undefined,
                  `Aggregated by ${aggregate_by} using ${effectiveAggregateMetric}.`,
                  `Scanned up to ${max_scan_blocks ?? 1000} blocks or ${Math.max(limit * 200, 5000).toLocaleString()} candidate transactions for bounded aggregation.`,
                ].filter((note): note is string => Boolean(note)),
                normalized_output: true,
              }),
              ...(scanResult ? buildBoundedSearchExecution(scanResult) : {}),
              ...(scanResult
                ? {
                    candidate_limit: scanResult.candidateLimit,
                    candidate_limit_reached: scanResult.candidateLimitReached,
                  }
                : {}),
            },
            metadata: {
              network: dataset,
              dataset,
              from_block: resolvedFromBlock,
              to_block: pageToBlock,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      // Apply response format (summary/compact/full)
      const formattedData = applyResponseFormat(page.pageItems, effectiveResponseFormat, 'transactions')
      if (nextCursor) {
        notices.push(buildCursorDirectionNotice(effectiveScanOrder))
      }
      if (scanResult && page.hasMore) {
        notices.push(
          `More matching transactions exist beyond the returned page for scanned blocks ${scanResult.scannedFromBlock}-${scanResult.scannedToBlock}; continue with _pagination.next_cursor.`,
        )
      }
      const exactHashMatched = Boolean(normalizedTransactionHash && page.pageItems.length > 0)
      const boundedSearchNotice =
        scanResult && !exactHashMatched ? buildBoundedSearchNotice(scanResult, 'EVM transaction scan') : undefined
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
        pageToBlock: scanResult && effectiveScanOrder === 'earliest' ? scanResult.scannedToBlock : pageToBlock,
        items: page.pageItems,
        getBlockNumber,
        hasMore: page.hasMore,
        windowComplete: exactHashMatched
          ? true
          : scanResult
            ? !scanResult.hasUnscannedBlocks
            : (recentScan?.exhausted ?? true),
      })

      const message =
        effectiveResponseFormat === 'summary'
          ? `Transaction summary for ${page.pageItems.length} transactions${page.hasMore ? ' (preview page)' : ''}`
          : scanResult
            ? `Retrieved ${page.pageItems.length} transactions by scanning ${effectiveScanOrder === 'earliest' ? 'forward' : 'backward'} from the ${effectiveScanOrder === 'earliest' ? 'start' : 'end'} of the window${effectiveOrderBy !== 'chronological' ? ` and ranking by ${effectiveOrderBy}` : ''}`
            : `Retrieved ${page.pageItems.length} transactions${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
        toolName: 'portal_evm_query_transactions',
        notices,
        pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
        ordering: buildChronologicalPageOrdering({
          sortedBy: 'block_number',
          tieBreakers: ['transactionIndex', 'hash'],
          ...(effectiveScanOrder === 'earliest'
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
            scan_order: effectiveScanOrder,
            order_by: effectiveOrderBy,
            range_kind: resolvedBlocks.range_kind,
            notes: [
              from_token_symbols && from_token_symbols.length > 0
                ? 'from_token_symbols were resolved from open token-list data and merged into from_addresses.'
                : undefined,
              to_token_symbols && to_token_symbols.length > 0
                ? 'to_token_symbols were resolved from open token-list data and merged into to_addresses.'
                : undefined,
              normalizedTransactionType !== undefined
                ? `Filtered client-side to transaction type ${normalizedTransactionType} (0x${normalizedTransactionType.toString(16)}).`
                : undefined,
              normalizedTransactionStatus !== undefined
                ? `Filtered client-side to ${normalizedTransactionStatus === 1 ? 'successful' : 'failed'} transactions.`
                : undefined,
              contract_creation !== undefined
                ? `Filtered client-side to ${contract_creation ? 'contract-creation' : 'non-contract-creation'} transactions.`
                : undefined,
              effectiveOrderBy !== 'chronological'
                ? `Ranked ${scanResult?.candidateCount ?? page.pageItems.length} scanned candidates by ${effectiveOrderBy}.`
                : undefined,
              include_logs || include_traces || include_state_diffs
                ? 'Expanded transaction context was requested with include flags.'
                : `Using ${field_preset} field preset.`,
              !hasFilters && adaptiveChunkSize < 100
                ? `Used smaller ${adaptiveChunkSize}-block recent chunks to keep unfiltered live previews responsive.`
                : undefined,
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
