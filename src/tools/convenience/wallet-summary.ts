import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { createQueryCache, stableCacheKey } from '../../cache/query-cache.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { buildTableDescriptor } from '../../helpers/chart-metadata.js'
import {
  buildTokenListLookupNotices,
  getTokenMetadataMapForDatasetWithStatus,
} from '../../helpers/entity-resolution.js'
import {
  ActionableError,
  RequestCancelledError,
  createUnsupportedChainError,
  sanitizeText,
} from '../../helpers/errors.js'
import {
  EXACT_DECIMAL_ZERO,
  type ExactDecimal,
  addExactDecimals,
  compareExactDecimals,
  divideExactDecimals,
  formatExactDecimal,
  formatIntegerUnitsExact,
  multiplyExactDecimals,
  parseExactDecimal,
} from '../../helpers/exact-decimal.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import {
  formatResult,
  formatTimestamp,
  formatTokenAmount,
  formatTransactionFields,
  hexToBigInt,
  humanizeLabel,
} from '../../helpers/format.js'
import {
  accumulateHyperliquidFee,
  createHyperliquidFeeAccumulator,
  summarizeHyperliquidFees,
} from '../../helpers/hyperliquid-fees.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import {
  normalizeBitcoinInputResult,
  normalizeBitcoinOutputResult,
  normalizeEvmTransactionResult,
  normalizeHyperliquidFillResult,
  normalizeSolanaTransactionResult,
} from '../../helpers/normalized-results.js'
import { decodeCursor, encodeCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildWalletPipesRecipe } from '../../helpers/pipes-recipe.js'
import { runWithPortalRequestDeadline } from '../../helpers/request-context.js'
import { type ResponseFormat, resolveDefaultResponseFormat } from '../../helpers/response-modes.js'
import { buildQueryFreshness, buildSectionCoverage } from '../../helpers/result-metadata.js'
import {
  type TimestampInput,
  describeTimeWindowInput,
  estimateBlockTime,
  getTimestampWindowNotices,
  parseTimeframeToSeconds,
  resolveTimeframeOrBlocks,
} from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import {
  buildMetricCard,
  buildPortalUi,
  buildRankedBarsPanel,
  buildStatListPanel,
  buildTablePanel,
  buildTimelinePanel,
} from '../../helpers/ui-metadata.js'
import { untrustedLabel } from '../../helpers/untrusted-text.js'
import {
  isValidBitcoinAddress,
  isValidEvmAddress,
  isValidHyperliquidAddress,
  isValidSolanaAddress,
  normalizeBitcoinAddressForPortal,
  normalizeEvmAddress,
} from '../../helpers/validation.js'

// ============================================================================
// Tool: Get Wallet Summary (Convenience Wrapper)
// ============================================================================

const WALLET_QUERY_TIMEOUT_MS = 8_000
const WALLET_QUERY_RETRIES = 0
const WALLET_SECTION_DEADLINE_MS = 10_000
const WALLET_TOOL_DEADLINE_MS = 25_000
const SAFE_WALLET_PAGE_SIZE = 4
const RETAINED_WALLET_LIMIT_MAX = 10

export type WalletCompleteness = {
  kind: 'wallet_result'
  page_complete: true
  result_complete: boolean
  window_complete: boolean
  has_more: boolean
  sections_complete: boolean
  failed_sections: string[]
  state: 'complete' | 'cursor_page' | 'partial_window' | 'section_partial'
}

export function buildWalletCompleteness(params: {
  hasMore: boolean
  windowComplete: boolean
  failedSections?: string[]
}): WalletCompleteness {
  const failedSections = Array.from(new Set(params.failedSections ?? []))
  const sectionsComplete = failedSections.length === 0
  const resultComplete = params.windowComplete && sectionsComplete && !params.hasMore
  const state: WalletCompleteness['state'] = !sectionsComplete
    ? 'section_partial'
    : params.hasMore
      ? 'cursor_page'
      : !params.windowComplete
        ? 'partial_window'
        : 'complete'
  return {
    kind: 'wallet_result',
    page_complete: true,
    result_complete: resultComplete,
    window_complete: params.windowComplete,
    has_more: params.hasMore,
    sections_complete: sectionsComplete,
    failed_sections: failedSections,
    state,
  }
}

/**
 * One-call wallet activity summary.
 * Combines multiple queries into a single comprehensive view:
 * - Recent transactions sent
 * - Recent transactions received
 * - Token transfers (ERC20)
 * - NFT transfers (ERC721/1155)
 */

type WalletBoundaryCursor = {
  page_to_block: number
  skip_inclusive_block: number
}

type WalletSummaryCursor = {
  tool: 'portal_get_wallet_summary'
  dataset: string
  address: string
  timeframe: string
  mode: 'fast' | 'deep'
  response_format: ResponseFormat
  include_tokens: boolean
  include_nfts: boolean
  limit_per_type: number
  window_from_block: number
  window_to_block: number
  sections: {
    transactions?: WalletBoundaryCursor | null
    token_transfers?: WalletBoundaryCursor | null
    nft_transfers?: WalletBoundaryCursor | null
    outputs?: WalletBoundaryCursor | null
    inputs?: WalletBoundaryCursor | null
    fills?: WalletBoundaryCursor | null
  }
}

type WalletSectionName = 'transactions' | 'token_transfers' | 'nft_transfers'

type WalletSectionPage<T> = {
  pageItems: T[]
  hasMore: boolean
  nextBoundary: WalletBoundaryCursor | null
  notices?: string[]
}

const WALLET_SECTION_CACHE_TTL_MS = 30_000
const WALLET_SECTION_CACHE_MAX_ENTRIES = 48

const walletSectionQueryCache = createQueryCache<unknown[]>({
  ttl: WALLET_SECTION_CACHE_TTL_MS,
  maxEntries: WALLET_SECTION_CACHE_MAX_ENTRIES,
})

type WalletTransactionItem = Record<string, unknown> & {
  block_number?: number
  transactionIndex?: number
  from?: string
  tx_hash?: string
  timestamp?: number
  timestamp_human?: string
  fee?: number | string
}

type WalletLogItem = Record<string, unknown> & {
  block_number?: number
  log_index?: number
}

type WalletCounterpartyRow = {
  address: string
  activity_count: number
  sent_count: number
  received_count: number
  record_types: string[]
}

type WalletFlowMovement = {
  direction: 'in' | 'out'
  asset_type: 'native' | 'token' | 'btc' | 'fee' | 'hyperliquid_coin'
  asset: string
  amount: string
  amount_decimal?: string
  amount_raw?: string
  amount_decimals?: number
  amount_numeric?: number
  counterparty?: string
  tx_hash?: string
  block_number?: number
  timestamp?: number
  timestamp_human?: string
  record_type: string
}

type WalletAssetFlowRow = {
  asset_type: string
  asset: string
  asset_id?: string
  symbol?: string
  inbound_count: number
  outbound_count: number
  inbound_amount: string
  outbound_amount: string
  net_amount: string
  inbound_amount_decimal?: string
  outbound_amount_decimal?: string
  net_amount_decimal?: string
  inbound_amount_raw?: string
  outbound_amount_raw?: string
  net_amount_raw?: string
  amount_decimals?: number
  net_direction: 'in' | 'out' | 'flat'
}

type WalletFlowCounterpartyRow = {
  address: string
  activity_count: number
  inbound_count: number
  outbound_count: number
  native_received_eth?: string
  native_sent_eth?: string
  token_received_count?: number
  token_sent_count?: number
  record_types: string[]
}

function getBlockNumber(item: { block_number?: number }) {
  return typeof item.block_number === 'number' ? item.block_number : undefined
}

function getTransactionIndex(item: WalletTransactionItem): number {
  if (typeof item.transactionIndex === 'number') {
    return item.transactionIndex
  }
  if (typeof item.transactionIndex === 'string') {
    const parsed = Number(item.transactionIndex)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function getLogIndex(item: WalletLogItem): number {
  if (typeof item.log_index === 'number') {
    return item.log_index
  }
  if (typeof item.log_index === 'string') {
    const parsed = Number(item.log_index)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function sortTransactions(items: WalletTransactionItem[]) {
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

    return String(left['hash'] ?? '').localeCompare(String(right['hash'] ?? ''))
  })
}

function sortLogs(items: WalletLogItem[]) {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) {
      return leftBlock - rightBlock
    }

    const leftIndex = getLogIndex(left)
    const rightIndex = getLogIndex(right)
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex
    }

    return String(left['transaction_hash'] ?? '').localeCompare(String(right['transaction_hash'] ?? ''))
  })
}

function describeWalletWindow(timeframe: string) {
  if (timeframe.includes('->')) {
    return timeframe
  }
  return /^\d+$/.test(timeframe) ? `last ${timeframe} blocks` : describeTimeWindowInput(timeframe)
}

function createWalletSummaryCursor(params: Omit<WalletSummaryCursor, 'tool'>) {
  return encodeCursor({
    tool: 'portal_get_wallet_summary',
    ...params,
  })
}

function buildSectionPagination(returned: number, hasMore: boolean) {
  return {
    returned,
    has_more: hasMore,
  }
}

async function fetchCachedWalletSection(params: {
  dataset: string
  section: WalletSectionName
  query: Record<string, unknown>
  itemKeys: string[]
  limit: number
  chunkSize: number
  concurrency: number
  initialSequentialChunks: number
}) {
  const { dataset, section, query, itemKeys, limit, chunkSize, concurrency, initialSequentialChunks } = params
  const cacheKey = stableCacheKey('wallet-section', {
    dataset,
    section,
    query,
    itemKeys,
    limit,
    chunkSize,
    concurrency,
    initialSequentialChunks,
  })
  const { value } = await runWithPortalRequestDeadline(
    WALLET_SECTION_DEADLINE_MS,
    () =>
      walletSectionQueryCache.getOrLoad(cacheKey, async () =>
        portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
          itemKeys,
          limit,
          chunkSize,
          concurrency,
          initialSequentialChunks,
          timeout: WALLET_QUERY_TIMEOUT_MS,
          retries: WALLET_QUERY_RETRIES,
        }),
      ),
    { tool: 'portal_get_wallet_summary', stage: section },
  )
  return value
}

/* Rows carry their direction relative to the wallet and, for token
   transfers, a numeric amount and asset, so a renderer can show what moved
   without interpreting the row. */
function annotateWalletDirection<
  T extends {
    sender?: string
    recipient?: string
    record_type?: string
    value?: unknown
    value_decimal?: unknown
    token_symbol?: string
    direction?: unknown
  },
>(item: T, wallet: string) {
  const subject = wallet.toLowerCase()
  const sender = String(item.sender ?? '').toLowerCase()
  const recipient = String(item.recipient ?? '').toLowerCase()
  const direction =
    typeof item.direction === 'string'
      ? item.direction
      : sender === subject && recipient === subject
        ? 'self'
        : sender === subject
          ? 'out'
          : recipient === subject
            ? 'in'
            : undefined
  const transfer = item.record_type === 'token_transfer'
  return {
    ...item,
    ...(direction ? { direction } : {}),
    /* value is the exact human amount with its symbol ("2.5 USDC");
       amount_value is its numeric part for renderers, value_decimal stays
       the raw token units. */
    ...(transfer && typeof item.value === 'string' && /^-?\d/.test(item.value)
      ? { amount: item.value, amount_value: item.value.split(' ')[0] }
      : {}),
    ...(transfer && item.token_symbol ? { asset: item.token_symbol } : {}),
  }
}

function compactWalletTransactionItem(tx: WalletTransactionItem) {
  const txHash =
    typeof tx['hash'] === 'string'
      ? String(tx['hash'])
      : typeof tx['tx_hash'] === 'string'
        ? String(tx['tx_hash'])
        : undefined
  const timestamp = typeof tx['timestamp'] === 'number' ? Number(tx['timestamp']) : undefined

  return {
    chain_kind: 'evm',
    record_type: 'transaction',
    primary_id: txHash,
    tx_hash: txHash,
    sender: typeof tx['from'] === 'string' ? String(tx['from']) : undefined,
    recipient: typeof tx['to'] === 'string' ? String(tx['to']) : undefined,
    block_number: getBlockNumber(tx),
    transactionIndex: getTransactionIndex(tx),
    ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
    ...(tx['value'] !== undefined ? { value: tx['value'] } : {}),
    ...(tx['nonce'] !== undefined ? { nonce: tx['nonce'] } : {}),
    ...(tx['status'] !== undefined ? { status: tx['status'] } : {}),
  }
}

function compactWalletTokenTransferItem(item: WalletLogItem) {
  const txHash = typeof item['transaction_hash'] === 'string' ? String(item['transaction_hash']) : undefined
  const logIndex = typeof item['log_index'] === 'number' ? Number(item['log_index']) : undefined
  const timestamp = typeof item['timestamp'] === 'number' ? Number(item['timestamp']) : undefined

  return {
    chain_kind: 'evm',
    record_type: 'token_transfer',
    primary_id: txHash && logIndex !== undefined ? `${txHash}:${logIndex}` : txHash,
    tx_hash: txHash,
    sender: typeof item['from'] === 'string' ? String(item['from']) : undefined,
    recipient: typeof item['to'] === 'string' ? String(item['to']) : undefined,
    block_number: getBlockNumber(item),
    ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
    token_address: typeof item['token_address'] === 'string' ? String(item['token_address']) : undefined,
    token_name: typeof item['token_name'] === 'string' ? String(item['token_name']) : undefined,
    token_symbol: typeof item['token_symbol'] === 'string' ? String(item['token_symbol']) : undefined,
    token_decimals: typeof item['token_decimals'] === 'number' ? Number(item['token_decimals']) : undefined,
    value: item['value'],
    value_raw: item['value_raw'],
    value_decimal: item['value_decimal'],
    direction: item['direction'],
  }
}

function compactWalletNftTransferItem(item: WalletLogItem) {
  const txHash = typeof item['transaction_hash'] === 'string' ? String(item['transaction_hash']) : undefined
  const logIndex = typeof item['log_index'] === 'number' ? Number(item['log_index']) : undefined
  const timestamp = typeof item['timestamp'] === 'number' ? Number(item['timestamp']) : undefined

  return {
    chain_kind: 'evm',
    record_type: 'nft_transfer',
    primary_id: txHash && logIndex !== undefined ? `${txHash}:${logIndex}` : txHash,
    tx_hash: txHash,
    block_number: getBlockNumber(item),
    ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
    contract_address: typeof item['contract_address'] === 'string' ? String(item['contract_address']) : undefined,
    token_id: item['token_id'],
  }
}

function buildEvmWalletActivityTable(rowCount: number) {
  return buildTableDescriptor({
    id: 'activity',
    dataKey: 'activity.items',
    rowCount,
    title: 'Wallet activity',
    subtitle: 'Normalized wallet activity rows across the selected window',
    keyField: 'primary_id',
    defaultSort: { key: 'timestamp', direction: 'asc' },
    dense: true,
    columns: [
      { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
      { key: 'record_type', label: 'Type', kind: 'dimension' },
      { key: 'direction', label: 'Direction', kind: 'dimension' },
      { key: 'amount', label: 'Amount', kind: 'metric', align: 'right' },
      { key: 'sender', label: 'Sender', kind: 'dimension', format: 'address' },
      { key: 'recipient', label: 'Recipient', kind: 'dimension', format: 'address' },
      { key: 'tx_hash', label: 'Tx hash', kind: 'dimension', format: 'identifier' },
      { key: 'block_number', label: 'Block', kind: 'metric', format: 'integer', align: 'right' },
    ],
  })
}

function buildWalletActivityTable(title: string, rowCount: number) {
  return buildTableDescriptor({
    id: 'activity',
    dataKey: 'activity.items',
    rowCount,
    title,
    subtitle: 'Normalized wallet activity rows across the selected window',
    keyField: 'primary_id',
    defaultSort: { key: 'timestamp', direction: 'asc' },
    dense: true,
    columns: [
      { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
      { key: 'record_type', label: 'Type', kind: 'dimension' },
      { key: 'primary_id', label: 'Primary ID', kind: 'dimension', format: 'identifier' },
      { key: 'sender', label: 'Sender', kind: 'dimension', format: 'address' },
      { key: 'recipient', label: 'Recipient', kind: 'dimension', format: 'address' },
      { key: 'block_number', label: 'Block', kind: 'metric', format: 'integer', align: 'right' },
    ],
  })
}

function buildWalletAssetFlowsTable(rowCount: number) {
  return buildTableDescriptor({
    id: 'asset_flows',
    dataKey: 'fund_flow.asset_flows',
    rowCount,
    title: 'Asset flow',
    subtitle: 'Inbound, outbound, and net movement by asset in the selected wallet view',
    keyField: 'asset',
    defaultSort: { key: 'inbound_count', direction: 'desc' },
    dense: true,
    columns: [
      { key: 'asset', label: 'Asset', kind: 'dimension' },
      { key: 'inbound_count', label: 'Inbound events', kind: 'metric', format: 'integer', align: 'right' },
      { key: 'outbound_count', label: 'Outbound events', kind: 'metric', format: 'integer', align: 'right' },
      { key: 'inbound_amount', label: 'Inbound amount', kind: 'metric', align: 'right' },
      { key: 'outbound_amount', label: 'Outbound amount', kind: 'metric', align: 'right' },
      { key: 'net_amount', label: 'Net', kind: 'metric', align: 'right' },
      { key: 'net_direction', label: 'Net direction', kind: 'dimension' },
    ],
  })
}

function buildWalletFlowCounterpartiesTable(rowCount: number) {
  return buildTableDescriptor({
    id: 'flow_counterparties',
    dataKey: 'fund_flow.movement_counterparties',
    rowCount,
    title: 'Asset movement counterparties',
    subtitle: 'Counterparties ranked only by observed inbound and outbound asset movements',
    keyField: 'address',
    defaultSort: { key: 'activity_count', direction: 'desc' },
    dense: true,
    columns: [
      { key: 'address', label: 'Counterparty', kind: 'dimension', format: 'address' },
      { key: 'activity_count', label: 'Movement events', kind: 'metric', format: 'integer', align: 'right' },
      { key: 'inbound_count', label: 'Inbound', kind: 'metric', format: 'integer', align: 'right' },
      { key: 'outbound_count', label: 'Outbound', kind: 'metric', format: 'integer', align: 'right' },
      {
        key: 'native_received_eth',
        label: 'Native received',
        kind: 'metric',
        format: 'decimal',
        align: 'right',
        unit: 'ETH',
      },
      { key: 'native_sent_eth', label: 'Native sent', kind: 'metric', format: 'decimal', align: 'right', unit: 'ETH' },
    ],
  })
}

function buildWalletLargestMovementsTable(rowCount: number) {
  return buildTableDescriptor({
    id: 'largest_movements',
    dataKey: 'fund_flow.largest_movements',
    rowCount,
    title: 'Largest movements within each asset',
    subtitle: 'Amounts are ranked only against movements of the same asset and must not be compared across assets',
    keyField: 'tx_hash',
    defaultSort: { key: 'amount_decimal', direction: 'desc' },
    dense: true,
    columns: [
      { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
      { key: 'direction', label: 'Direction', kind: 'dimension' },
      { key: 'asset', label: 'Asset', kind: 'dimension' },
      { key: 'amount', label: 'Amount', kind: 'metric', align: 'right' },
      { key: 'counterparty', label: 'Counterparty', kind: 'dimension', format: 'address' },
      { key: 'tx_hash', label: 'Tx hash', kind: 'dimension', format: 'identifier' },
    ],
  })
}

function buildBitcoinOutputsTable(title: string, rowCount: number) {
  return buildTableDescriptor({
    id: 'bitcoin_outputs',
    dataKey: 'bitcoin.recent_outputs',
    rowCount,
    title,
    subtitle: 'Recent outputs sent to the wallet address',
    keyField: 'primary_id',
    defaultSort: { key: 'timestamp', direction: 'desc' },
    dense: true,
    columns: [
      { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
      { key: 'tx_hash', label: 'Tx hash', kind: 'dimension', format: 'identifier' },
      { key: 'value', label: 'Value (BTC)', kind: 'metric', format: 'decimal', unit: 'BTC', align: 'right' },
      { key: 'outputIndex', label: 'Output index', kind: 'dimension' },
    ],
  })
}

function buildBitcoinInputsTable(title: string, rowCount: number) {
  return buildTableDescriptor({
    id: 'bitcoin_inputs',
    dataKey: 'bitcoin.recent_inputs',
    rowCount,
    title,
    subtitle: 'Recent inputs spent by the wallet address',
    keyField: 'primary_id',
    defaultSort: { key: 'timestamp', direction: 'desc' },
    dense: true,
    columns: [
      { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
      { key: 'tx_hash', label: 'Tx hash', kind: 'dimension', format: 'identifier' },
      { key: 'prevoutValue', label: 'Value (BTC)', kind: 'metric', format: 'decimal', unit: 'BTC', align: 'right' },
      { key: 'inputIndex', label: 'Input index', kind: 'dimension' },
    ],
  })
}

function buildTopCounterparties(
  items: Record<string, unknown>[],
  walletAddress: string,
  limit: number = 5,
): WalletCounterpartyRow[] {
  const normalizedWallet = walletAddress.toLowerCase()
  const counterparties = new Map<
    string,
    { activityCount: number; sentCount: number; receivedCount: number; recordTypes: Set<string> }
  >()

  for (const item of items) {
    const sender = typeof item.sender === 'string' ? item.sender.toLowerCase() : undefined
    const recipient = typeof item.recipient === 'string' ? item.recipient.toLowerCase() : undefined
    const recordType = typeof item.record_type === 'string' ? item.record_type : undefined

    const seenInItem = new Set<string>()
    if (sender && sender !== normalizedWallet) {
      seenInItem.add(sender)
    }
    if (recipient && recipient !== normalizedWallet) {
      seenInItem.add(recipient)
    }

    for (const counterparty of seenInItem) {
      const existing = counterparties.get(counterparty) ?? {
        activityCount: 0,
        sentCount: 0,
        receivedCount: 0,
        recordTypes: new Set<string>(),
      }

      existing.activityCount += 1
      if (sender === normalizedWallet && recipient === counterparty) {
        existing.sentCount += 1
      }
      if (recipient === normalizedWallet && sender === counterparty) {
        existing.receivedCount += 1
      }
      if (recordType) {
        existing.recordTypes.add(recordType)
      }

      counterparties.set(counterparty, existing)
    }
  }

  return Array.from(counterparties.entries())
    .map(([address, value]) => ({
      address,
      activity_count: value.activityCount,
      sent_count: value.sentCount,
      received_count: value.receivedCount,
      record_types: Array.from(value.recordTypes).sort(),
    }))
    .sort((left, right) => {
      if (right.activity_count !== left.activity_count) {
        return right.activity_count - left.activity_count
      }
      if (right.sent_count !== left.sent_count) {
        return right.sent_count - left.sent_count
      }
      if (right.received_count !== left.received_count) {
        return right.received_count - left.received_count
      }
      return left.address.localeCompare(right.address)
    })
    .slice(0, limit)
}

export function parseNumericAmount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/,/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function parseBigIntAmount(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return 0n
}

function formatDecimalAmount(value: bigint, decimals: number, symbol?: string): string {
  const exact = formatDecimalAmountExact(value, decimals)
  const label = untrustedLabel(symbol)
  return label ? `${exact} ${label}` : exact
}

export function formatDecimalAmountExact(value: bigint, decimals: number): string {
  return formatIntegerUnitsExact(value, decimals)
}

function rankMovementsWithinAssets(
  movements: WalletFlowMovement[],
  perAssetLimit = 3,
  totalLimit = 10,
): WalletFlowMovement[] {
  const byAsset = new Map<string, WalletFlowMovement[]>()
  for (const movement of movements) {
    const exact = parseExactDecimal(movement.amount_decimal)
    if (!exact || exact.coefficient <= 0n) continue
    const key = `${movement.asset_type}:${movement.asset}`
    const existing = byAsset.get(key) ?? []
    existing.push(movement)
    byAsset.set(key, existing)
  }
  return Array.from(byAsset.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, assetMovements]) =>
      assetMovements
        .sort((left, right) =>
          compareExactDecimals(
            parseExactDecimal(right.amount_decimal) ?? EXACT_DECIMAL_ZERO,
            parseExactDecimal(left.amount_decimal) ?? EXACT_DECIMAL_ZERO,
          ),
        )
        .slice(0, perAssetLimit),
    )
    .slice(0, totalLimit)
}

function addCounterpartyFlow(
  counterparties: Map<
    string,
    {
      inboundCount: number
      outboundCount: number
      nativeReceivedEth: ExactDecimal
      nativeSentEth: ExactDecimal
      tokenReceivedCount: number
      tokenSentCount: number
      recordTypes: Set<string>
    }
  >,
  address: string | undefined,
  direction: 'in' | 'out',
  recordType: string,
  opts?: { nativeEth?: ExactDecimal; tokenEvent?: boolean },
) {
  if (!address) return
  const normalized = address.toLowerCase()
  const existing = counterparties.get(normalized) ?? {
    inboundCount: 0,
    outboundCount: 0,
    nativeReceivedEth: EXACT_DECIMAL_ZERO,
    nativeSentEth: EXACT_DECIMAL_ZERO,
    tokenReceivedCount: 0,
    tokenSentCount: 0,
    recordTypes: new Set<string>(),
  }

  if (direction === 'in') {
    existing.inboundCount += 1
    existing.nativeReceivedEth = addExactDecimals(existing.nativeReceivedEth, opts?.nativeEth ?? EXACT_DECIMAL_ZERO)
    if (opts?.tokenEvent) existing.tokenReceivedCount += 1
  } else {
    existing.outboundCount += 1
    existing.nativeSentEth = addExactDecimals(existing.nativeSentEth, opts?.nativeEth ?? EXACT_DECIMAL_ZERO)
    if (opts?.tokenEvent) existing.tokenSentCount += 1
  }
  existing.recordTypes.add(recordType)
  counterparties.set(normalized, existing)
}

function buildFlowCounterpartyRows(
  counterparties: Map<
    string,
    {
      inboundCount: number
      outboundCount: number
      nativeReceivedEth: ExactDecimal
      nativeSentEth: ExactDecimal
      tokenReceivedCount: number
      tokenSentCount: number
      recordTypes: Set<string>
    }
  >,
  limit = 10,
): WalletFlowCounterpartyRow[] {
  return Array.from(counterparties.entries())
    .map(([address, value]) => ({
      address,
      activity_count: value.inboundCount + value.outboundCount,
      inbound_count: value.inboundCount,
      outbound_count: value.outboundCount,
      native_received_eth: formatExactDecimal(value.nativeReceivedEth),
      native_sent_eth: formatExactDecimal(value.nativeSentEth),
      token_received_count: value.tokenReceivedCount,
      token_sent_count: value.tokenSentCount,
      record_types: Array.from(value.recordTypes).sort(),
    }))
    .sort((left, right) => {
      if (right.activity_count !== left.activity_count) return right.activity_count - left.activity_count
      if (right.outbound_count !== left.outbound_count) return right.outbound_count - left.outbound_count
      return left.address.localeCompare(right.address)
    })
    .slice(0, limit)
}

function buildEvmFundFlow(params: {
  walletAddress: string
  transactions: WalletTransactionItem[]
  tokenTransfers: WalletLogItem[]
}) {
  const wallet = params.walletAddress.toLowerCase()
  let nativeReceivedEth = EXACT_DECIMAL_ZERO
  let nativeSentEth = EXACT_DECIMAL_ZERO
  let nativeInboundCount = 0
  let nativeOutboundCount = 0
  let inboundEvents = 0
  let outboundEvents = 0
  const counterparties = new Map<
    string,
    {
      inboundCount: number
      outboundCount: number
      nativeReceivedEth: ExactDecimal
      nativeSentEth: ExactDecimal
      tokenReceivedCount: number
      tokenSentCount: number
      recordTypes: Set<string>
    }
  >()
  const tokenAssets = new Map<
    string,
    {
      assetId: string
      symbol?: string
      decimals: number
      inbound: bigint
      outbound: bigint
      inboundCount: number
      outboundCount: number
    }
  >()
  const movements: WalletFlowMovement[] = []

  for (const tx of params.transactions) {
    const sender = typeof tx.from === 'string' ? tx.from.toLowerCase() : undefined
    const recipient = typeof tx.to === 'string' ? tx.to.toLowerCase() : undefined
    const valueEth = parseExactDecimal(tx.value_eth)
    if (!valueEth || valueEth.coefficient <= 0n) continue

    const direction = sender === wallet ? 'out' : recipient === wallet ? 'in' : undefined
    if (!direction) continue
    const counterparty = direction === 'out' ? recipient : sender
    if (direction === 'in') {
      nativeReceivedEth = addExactDecimals(nativeReceivedEth, valueEth)
      nativeInboundCount += 1
      inboundEvents += 1
    } else {
      nativeSentEth = addExactDecimals(nativeSentEth, valueEth)
      nativeOutboundCount += 1
      outboundEvents += 1
    }
    addCounterpartyFlow(counterparties, counterparty, direction, 'transaction', { nativeEth: valueEth })
    movements.push({
      direction,
      asset_type: 'native',
      asset: 'ETH',
      amount: `${formatExactDecimal(valueEth)} ETH`,
      amount_decimal: formatExactDecimal(valueEth),
      counterparty,
      tx_hash: typeof tx.hash === 'string' ? tx.hash : typeof tx.tx_hash === 'string' ? tx.tx_hash : undefined,
      block_number: getBlockNumber(tx),
      timestamp: typeof tx.timestamp === 'number' ? tx.timestamp : undefined,
      timestamp_human: typeof tx.timestamp === 'number' ? formatTimestamp(tx.timestamp) : undefined,
      record_type: 'transaction',
    })
  }

  for (const transfer of params.tokenTransfers) {
    const sender = typeof transfer.from === 'string' ? transfer.from.toLowerCase() : undefined
    const recipient = typeof transfer.to === 'string' ? transfer.to.toLowerCase() : undefined
    const direction =
      transfer.direction === 'out' || sender === wallet
        ? 'out'
        : transfer.direction === 'in' || recipient === wallet
          ? 'in'
          : undefined
    if (!direction) continue

    const tokenAddress =
      typeof transfer.token_address === 'string' ? transfer.token_address.toLowerCase() : 'unknown-token'
    const symbol = typeof transfer.token_symbol === 'string' ? transfer.token_symbol : undefined
    const decimals = typeof transfer.token_decimals === 'number' ? transfer.token_decimals : 18
    const amountRaw = parseBigIntAmount(transfer.value_decimal)
    const asset = tokenAssets.get(tokenAddress) ?? {
      assetId: tokenAddress,
      symbol,
      decimals,
      inbound: 0n,
      outbound: 0n,
      inboundCount: 0,
      outboundCount: 0,
    }
    if (direction === 'in') {
      asset.inbound += amountRaw
      asset.inboundCount += 1
      inboundEvents += 1
    } else {
      asset.outbound += amountRaw
      asset.outboundCount += 1
      outboundEvents += 1
    }
    tokenAssets.set(tokenAddress, asset)

    const counterparty = direction === 'out' ? recipient : sender
    addCounterpartyFlow(counterparties, counterparty, direction, 'token_transfer', { tokenEvent: true })
    movements.push({
      direction,
      asset_type: 'token',
      asset: symbol ?? tokenAddress,
      amount: formatDecimalAmount(amountRaw, decimals, symbol),
      amount_decimal: formatDecimalAmountExact(amountRaw, decimals),
      amount_raw: amountRaw.toString(),
      amount_decimals: decimals,
      counterparty,
      tx_hash: typeof transfer.transaction_hash === 'string' ? transfer.transaction_hash : undefined,
      block_number: getBlockNumber(transfer),
      timestamp: typeof transfer.timestamp === 'number' ? transfer.timestamp : undefined,
      timestamp_human: typeof transfer.timestamp === 'number' ? formatTimestamp(transfer.timestamp) : undefined,
      record_type: 'token_transfer',
    })
  }

  const assetFlows: WalletAssetFlowRow[] = [
    ...(nativeReceivedEth.coefficient > 0n || nativeSentEth.coefficient > 0n
      ? [
          {
            asset_type: 'native',
            asset: 'ETH',
            symbol: 'ETH',
            inbound_count: nativeInboundCount,
            outbound_count: nativeOutboundCount,
            inbound_amount: `${formatExactDecimal(nativeReceivedEth)} ETH`,
            outbound_amount: `${formatExactDecimal(nativeSentEth)} ETH`,
            net_amount: `${formatExactDecimal(addExactDecimals(nativeReceivedEth, { coefficient: -nativeSentEth.coefficient, scale: nativeSentEth.scale }))} ETH`,
            inbound_amount_decimal: formatExactDecimal(nativeReceivedEth),
            outbound_amount_decimal: formatExactDecimal(nativeSentEth),
            net_amount_decimal: formatExactDecimal(
              addExactDecimals(nativeReceivedEth, {
                coefficient: -nativeSentEth.coefficient,
                scale: nativeSentEth.scale,
              }),
            ),
            amount_decimals: 18,
            net_direction:
              compareExactDecimals(nativeReceivedEth, nativeSentEth) > 0
                ? ('in' as const)
                : compareExactDecimals(nativeSentEth, nativeReceivedEth) > 0
                  ? ('out' as const)
                  : ('flat' as const),
          },
        ]
      : []),
    ...Array.from(tokenAssets.values()).map((asset) => {
      const net = asset.inbound - asset.outbound
      const inboundExact = formatDecimalAmountExact(asset.inbound, asset.decimals)
      const outboundExact = formatDecimalAmountExact(asset.outbound, asset.decimals)
      const netExact = formatDecimalAmountExact(net, asset.decimals)
      return {
        asset_type: 'token',
        asset: asset.symbol ?? asset.assetId,
        asset_id: asset.assetId,
        symbol: asset.symbol,
        inbound_count: asset.inboundCount,
        outbound_count: asset.outboundCount,
        inbound_amount: formatDecimalAmount(asset.inbound, asset.decimals, asset.symbol),
        outbound_amount: formatDecimalAmount(asset.outbound, asset.decimals, asset.symbol),
        net_amount: formatDecimalAmount(net, asset.decimals, asset.symbol),
        inbound_amount_decimal: inboundExact,
        outbound_amount_decimal: outboundExact,
        net_amount_decimal: netExact,
        inbound_amount_raw: asset.inbound.toString(),
        outbound_amount_raw: asset.outbound.toString(),
        net_amount_raw: net.toString(),
        amount_decimals: asset.decimals,
        net_direction: net > 0n ? ('in' as const) : net < 0n ? ('out' as const) : ('flat' as const),
      }
    }),
  ].sort((left, right) => right.inbound_count + right.outbound_count - (left.inbound_count + left.outbound_count))

  const sortedMovements = rankMovementsWithinAssets(movements)
  const movementAssets = new Set(sortedMovements.map((movement) => `${movement.asset_type}:${movement.asset}`))

  const flowCounterparties = buildFlowCounterpartyRows(counterparties, 10)
  const topCounterparty = flowCounterparties[0]

  return {
    definition:
      'Asset movement only. Includes positive native-value transfers and token transfers; excludes zero-value contract calls, which remain in activity.items.',
    ranking_definition:
      'largest_movements contains up to three largest observed movements per asset. Amounts from different assets are not comparable.',
    summary: {
      inbound_events: inboundEvents,
      outbound_events: outboundEvents,
      native_received_eth: formatExactDecimal(nativeReceivedEth),
      native_sent_eth: formatExactDecimal(nativeSentEth),
      native_net_eth: formatExactDecimal(
        addExactDecimals(nativeReceivedEth, { coefficient: -nativeSentEth.coefficient, scale: nativeSentEth.scale }),
      ),
      asset_count: assetFlows.length,
      top_movement_counterparty: topCounterparty?.address,
      ...(movementAssets.size === 1 ? { largest_movement: sortedMovements[0] } : {}),
      largest_movement_scope: movementAssets.size === 1 ? 'single_asset' : 'per_asset_only',
    },
    asset_flows: assetFlows,
    movement_counterparties: flowCounterparties,
    largest_movements: sortedMovements,
    next_pivots: [
      ...(topCounterparty
        ? [
            {
              goal: 'Investigate the top counterparty',
              tool: 'portal_get_wallet_summary',
              network_field: 'overview.network',
              address: topCounterparty.address,
            },
          ]
        : []),
      ...(sortedMovements[0]?.tx_hash
        ? [
            {
              goal: 'Inspect the largest movement transaction',
              tool: 'portal_evm_query_transactions',
              transaction_hash: sortedMovements[0].tx_hash,
            },
          ]
        : []),
    ],
  }
}

function buildSimpleAssetFlow(params: {
  assetType: WalletAssetFlowRow['asset_type']
  asset: string
  inboundCount: number
  outboundCount: number
  inboundAmount: string
  outboundAmount: string
  netAmount: string
  netDirection: WalletAssetFlowRow['net_direction']
}): WalletAssetFlowRow {
  return {
    asset_type: params.assetType,
    asset: params.asset,
    inbound_count: params.inboundCount,
    outbound_count: params.outboundCount,
    inbound_amount: params.inboundAmount,
    outbound_amount: params.outboundAmount,
    net_amount: params.netAmount,
    net_direction: params.netDirection,
  }
}

export function applyWalletSummaryResponseFormat<T extends Record<string, unknown>>(
  summary: T,
  responseFormat: ResponseFormat,
): T {
  const activity =
    summary.activity && typeof summary.activity === 'object' && !Array.isArray(summary.activity)
      ? (summary.activity as Record<string, unknown>)
      : undefined
  const fundFlow =
    summary.fund_flow && typeof summary.fund_flow === 'object' && !Array.isArray(summary.fund_flow)
      ? (summary.fund_flow as Record<string, unknown>)
      : undefined

  if (responseFormat === 'compact') {
    const activityItems = Array.isArray(activity?.items) ? activity.items : undefined
    const relationships =
      summary.relationships && typeof summary.relationships === 'object' && !Array.isArray(summary.relationships)
        ? (summary.relationships as Record<string, unknown>)
        : undefined

    return {
      ...summary,
      ...(activity
        ? {
            activity: {
              ...activity,
              ...(activityItems
                ? {
                    items: activityItems,
                  }
                : {}),
            },
          }
        : {}),
      ...(relationships
        ? {
            relationships: {
              ...relationships,
              activity_counterparties: Array.isArray(relationships.activity_counterparties)
                ? relationships.activity_counterparties.slice(0, 5)
                : relationships.activity_counterparties,
            },
          }
        : {}),
      ...(fundFlow
        ? {
            fund_flow: {
              ...fundFlow,
              asset_flows: Array.isArray(fundFlow.asset_flows)
                ? fundFlow.asset_flows.slice(0, 5)
                : fundFlow.asset_flows,
              movement_counterparties: Array.isArray(fundFlow.movement_counterparties)
                ? fundFlow.movement_counterparties.slice(0, 5)
                : fundFlow.movement_counterparties,
              largest_movements: Array.isArray(fundFlow.largest_movements)
                ? fundFlow.largest_movements.slice(0, 5)
                : fundFlow.largest_movements,
            },
          }
        : {}),
    }
  }

  if (responseFormat !== 'summary') return summary

  return {
    ...summary,
    ...(activity ? { activity: { count: activity.count } } : {}),
    ...(fundFlow
      ? {
          fund_flow: {
            ...fundFlow,
            asset_flows: Array.isArray(fundFlow.asset_flows) ? fundFlow.asset_flows.slice(0, 5) : fundFlow.asset_flows,
            movement_counterparties: Array.isArray(fundFlow.movement_counterparties)
              ? fundFlow.movement_counterparties.slice(0, 5)
              : fundFlow.movement_counterparties,
            largest_movements: Array.isArray(fundFlow.largest_movements)
              ? fundFlow.largest_movements.slice(0, 5)
              : fundFlow.largest_movements,
          },
        }
      : {}),
  }
}

export function bitcoinValueToSats(value: unknown): bigint {
  let text =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isFinite(value)
        ? value.toFixed(8)
        : ''
  if (/e/i.test(text)) {
    const numeric = Number(text)
    text = Number.isFinite(numeric) ? numeric.toFixed(8) : ''
  }
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(text)
  if (!match) {
    throw new ActionableError(
      'Portal returned a Bitcoin value that cannot be represented exactly in satoshis.',
      ['Retry the request. If it repeats, report the affected Bitcoin dataset and block window.'],
      { value: text.slice(0, 64) },
      { code: 'incomplete_result', origin: 'upstream', retryable: true },
    )
  }
  const magnitude = BigInt(match[2]) * 100_000_000n + BigInt((match[3] ?? '').padEnd(8, '0') || '0')
  return match[1] ? -magnitude : magnitude
}

export function formatSatsAsBtc(value: bigint): string {
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  const integer = absolute / 100_000_000n
  const fraction = (absolute % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')
  return fraction ? `${sign}${integer}.${fraction}` : `${sign}${integer}`
}

function buildWalletUi(params: {
  title: string
  subtitle: string
  activityCountPath?: string
  primaryValuePath?: string
  primaryLabel?: string
  primaryFormat?: 'integer' | 'decimal' | 'currency_usd' | 'btc'
  primaryUnit?: string
  secondaryCards?: ReturnType<typeof buildMetricCard>[]
  panels?: Array<
    | ReturnType<typeof buildTablePanel>
    | ReturnType<typeof buildTimelinePanel>
    | ReturnType<typeof buildStatListPanel>
    | ReturnType<typeof buildRankedBarsPanel>
  >
  followUpActions?: Array<{ label: string; intent: 'continue' | 'show_raw' | 'drilldown'; target?: string }>
  notices?: string[]
}) {
  return buildPortalUi({
    version: 'portal_ui_v1',
    layout: 'dashboard',
    density: 'compact',
    design_intent: 'activity_investigator',
    headline: {
      title: params.title,
      subtitle: params.subtitle,
    },
    metric_cards: [
      ...(params.activityCountPath
        ? [
            buildMetricCard({
              id: 'activity-count',
              label: 'Activity',
              value_path: params.activityCountPath,
              format: 'integer',
              emphasis: 'primary',
            }),
          ]
        : []),
      ...(params.primaryValuePath
        ? [
            buildMetricCard({
              id: 'primary-value',
              label: params.primaryLabel ?? 'Primary',
              value_path: params.primaryValuePath,
              ...(params.primaryFormat ? { format: params.primaryFormat } : {}),
              ...(params.primaryUnit ? { unit: params.primaryUnit } : {}),
            }),
          ]
        : []),
      ...(params.secondaryCards ?? []),
    ],
    panels: params.panels ?? [
      buildTimelinePanel({
        id: 'wallet-timeline',
        kind: 'timeline_panel',
        title: 'Activity timeline',
        subtitle: 'Chronological wallet activity with timestamps and normalized labels.',
        data_key: 'activity.items',
        timestamp_key: 'timestamp_human',
        title_key: 'primary_id',
        subtitle_keys: ['record_type', 'sender', 'recipient'],
        badge_key: 'record_type',
        emphasis: 'primary',
      }),
      buildTablePanel({
        id: 'wallet-table',
        kind: 'table_panel',
        title: 'Activity table',
        subtitle: 'Exact normalized rows for the selected wallet window.',
        table_id: 'activity',
      }),
    ],
    follow_up_actions: params.followUpActions,
    ...(params.notices ? { notices: params.notices } : {}),
  })
}

function buildWalletLlmOverrides(vm: 'evm' | 'solana' | 'bitcoin' | 'hyperliquid') {
  const answerSequenceByVm: Record<typeof vm, string[]> = {
    evm: [
      'overview',
      'completeness',
      'fund_flow.summary',
      'fund_flow.asset_flows',
      'fund_flow.movement_counterparties',
      'activity.count',
      'evm.transactions.count',
      'relationships.activity_counterparties',
      'assets.token_transfers',
      'assets.nft_transfers',
      'activity.items',
    ],
    solana: [
      'overview',
      'completeness',
      'fund_flow.summary',
      'activity.count',
      'solana.fee_summary.total_fees_lamports',
      'solana.fee_summary.avg_fee_lamports',
      'activity.items',
    ],
    bitcoin: [
      'overview',
      'completeness',
      'fund_flow.summary',
      'fund_flow.asset_flows',
      'activity.count',
      'assets.total_btc_received',
      'assets.total_btc_spent',
      'bitcoin.outputs_count',
      'bitcoin.inputs_count',
      'activity.items',
    ],
    hyperliquid: [
      'overview',
      'completeness',
      'fund_flow.summary',
      'activity.count',
      'hyperliquid.fee_summary.fees_status',
      'hyperliquid.fee_summary.total_fees_usd',
      'hyperliquid.fee_summary.fees_by_token',
      'assets.volume_by_coin',
      'activity.items',
    ],
  }

  const parserNotesByVm: Record<typeof vm, string[]> = {
    evm: [
      'Start with fund_flow.summary and fund_flow.asset_flows, then mention activity.count, counterparties, and EVM transaction/token counts.',
      'activity.items is the normalized cross-chain wallet feed; fund_flow.next_pivots and fund_flow.movement_counterparties contain the most useful EVM asset-movement drill-downs.',
    ],
    solana: [
      'Start with overview and activity.count, then mention the fee summary before drilling into activity.items.',
      'activity.items is the normalized transaction feed; solana.fee_summary is the VM-specific wallet section.',
    ],
    bitcoin: [
      'Start with overview and activity.count, then mention BTC received and spent totals plus input and output counts.',
      'activity.items mixes normalized inputs and outputs; bitcoin contains the UTXO-style wallet breakdown.',
    ],
    hyperliquid: [
      'Check hyperliquid.fee_summary.fees_status before citing USD fees. Use signed fees_by_token when the USD total is unavailable; negative fees are rebates.',
      'Start with overview and activity.count, then mention fee_summary and volume_by_coin before listing individual fills.',
      'activity.items is the normalized fill feed; assets.volume_by_coin is the best section for what this wallet traded.',
    ],
  }

  return {
    answer_sequence: answerSequenceByVm[vm],
    parser_notes: [
      ...parserNotesByVm[vm],
      'If _pagination.has_more is true, treat the wallet response as a preview page rather than a complete lifetime history.',
    ],
  }
}

export function registerGetWalletSummaryTool(server: McpServer) {
  const FAST_MODE_BLOCK_CAP = 3000

  registerPortalTool(
    server,
    'portal_get_wallet_summary',
    buildToolDescription('portal_get_wallet_summary'),
    {
      network: z.string().optional().describe('Network name or alias. Optional when continuing with cursor.'),
      address: z.string().optional().describe('Wallet address to analyze. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .default('1000')
        .describe("Look-back period as timeframe or block count. Examples: '1h', '24h', '7d', '3d', '1000'."),
      from_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".',
        ),
      to_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".',
        ),
      include_tokens: z.boolean().optional().default(true).describe('Include ERC20 token transfers'),
      include_nfts: z.boolean().optional().default(false).describe('Include NFT transfers (ERC721/1155)'),
      limit_per_type: z
        .number()
        .int()
        .min(1)
        .max(RETAINED_WALLET_LIMIT_MAX)
        .optional()
        .default(5)
        .describe(
          'Requested items per category (default: 5). Values up to the retained compatibility maximum of 10 are accepted, while each category is safely capped at 4 rows and remains cursorable.',
        ),
      mode: z
        .enum(['fast', 'deep'])
        .optional()
        .default('deep')
        .describe(
          'Execution depth. Defaults to complete requested-window analysis; the optional fast value is only for explicitly bounded previews.',
        ),
      response_format: z
        .enum(['full', 'compact', 'summary'])
        .optional()
        .describe(
          "Response format: defaults to 'compact' for a readable wallet investigation. Use 'summary' for headline flow only or 'full' for all returned activity rows.",
        ),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({
      network,
      address,
      timeframe,
      from_timestamp,
      to_timestamp,
      include_tokens,
      include_nfts,
      limit_per_type,
      mode,
      response_format,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeCursor<WalletSummaryCursor>(cursor, 'portal_get_wallet_summary')
        : undefined
      const requestedDataset = network ? await resolveDataset(network) : undefined
      let dataset = paginationCursor?.dataset ?? requestedDataset
      if (!dataset) {
        throw new ActionableError('network is required unless you are continuing with cursor.', [
          'Provide network for a fresh wallet summary.',
          'Reuse _pagination.next_cursor from a previous response to continue paging.',
        ])
      }
      const chainType = detectChainType(dataset)
      const networkLabel = humanizeLabel(dataset) ?? dataset

      if (address) {
        const valid =
          chainType === 'evm'
            ? isValidEvmAddress(address)
            : chainType === 'solana'
              ? isValidSolanaAddress(address)
              : chainType === 'bitcoin'
                ? isValidBitcoinAddress(address)
                : chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds'
                  ? isValidHyperliquidAddress(address)
                  : true
        if (!valid) {
          throw new ActionableError(
            `Invalid ${chainType} wallet address.`,
            [
              `Provide a valid address for ${networkLabel}.`,
              'Omit cursor to start a new wallet query after correcting the address.',
            ],
            { network: dataset },
            { code: 'invalid_request', origin: 'client_input', retryable: false },
          )
        }
        if (chainType === 'evm' || chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
          address = address.toLowerCase()
        } else if (chainType === 'bitcoin') {
          address = normalizeBitcoinAddressForPortal(address)
        }
      }

      if (chainType === 'substrate' || chainType === 'tron') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_wallet_summary',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin', 'hyperliquidFills'],
          suggestions:
            chainType === 'tron'
              ? [
                  'Use portal_get_network_info for Tron availability and freshness.',
                  'Use portal_debug_resolve_time_to_block for Tron timestamp-to-block lookups.',
                  'Use portal_tron_query_transactions with from_addresses or to_addresses for TRX sent or received by the wallet, and portal_tron_query_logs with topic1 or topic2 set to the wallet for TRC-20 transfers.',
                ]
              : [
                  'Use portal_debug_query_blocks plus a Substrate-specific event or call query for now.',
                  'Add a dedicated Substrate wallet summary once address and account filters are productized for Substrate networks.',
                ],
        })
      }

      if (chainType !== 'evm') {
        if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
          throw new ActionableError('This cursor belongs to a different network.', [
            'Reuse the cursor with the same network and wallet address.',
            'Omit cursor to start a fresh wallet summary.',
          ])
        }
        if (paginationCursor && address && paginationCursor.address !== address) {
          throw new ActionableError('This cursor belongs to a different wallet address.', [
            'Reuse the cursor with the same wallet address as the previous response.',
            'Omit cursor to start a fresh wallet summary.',
          ])
        }
        if (paginationCursor) {
          address = paginationCursor.address
          timeframe = paginationCursor.timeframe
          mode = paginationCursor.mode
          limit_per_type = paginationCursor.limit_per_type
          response_format = paginationCursor.response_format
        }
        const requestedLimitPerType = limit_per_type
        limit_per_type = Math.min(limit_per_type, SAFE_WALLET_PAGE_SIZE)
        return await buildNonEvmWalletSummary({
          dataset,
          chainType,
          address,
          timeframe,
          from_timestamp,
          to_timestamp,
          mode,
          limit_per_type,
          response_format,
          queryStartTime,
          paginationCursor,
          compatibilityNotices:
            requestedLimitPerType > limit_per_type
              ? [
                  `Accepted the retained limit_per_type ${requestedLimitPerType} for installed-client compatibility and returned safe ${limit_per_type}-row category pages. Continue with _pagination.next_cursor for older activity.`,
                ]
              : [],
        })
      }

      const requestedAddress = address ? normalizeEvmAddress(address) : undefined
      const normalizedAddress = paginationCursor?.address ?? requestedAddress
      if (!normalizedAddress) {
        throw new ActionableError('address is required unless you are continuing with cursor.', [
          'Provide address for a fresh wallet summary.',
          'Reuse _pagination.next_cursor from a previous response to continue paging.',
        ])
      }

      if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
        throw new ActionableError(
          'This cursor belongs to a different network.',
          [
            'Reuse the cursor with the same network and wallet address.',
            'Omit cursor to start a fresh wallet summary.',
          ],
          {
            cursor_dataset: paginationCursor.dataset,
            requested_dataset: requestedDataset,
          },
        )
      }
      if (paginationCursor && requestedAddress && paginationCursor.address !== requestedAddress) {
        throw new ActionableError(
          'This cursor belongs to a different wallet address.',
          [
            'Reuse the cursor with the same wallet address as the previous response.',
            'Omit cursor to start a fresh wallet summary.',
          ],
          {
            cursor_address: paginationCursor.address,
            requested_address: requestedAddress,
          },
        )
      }

      if (paginationCursor) {
        timeframe = paginationCursor.timeframe
        mode = paginationCursor.mode
        include_tokens = paginationCursor.include_tokens
        include_nfts = paginationCursor.include_nfts
        limit_per_type = paginationCursor.limit_per_type
        response_format = paginationCursor.response_format
      }
      const requestedLimitPerType = limit_per_type
      limit_per_type = Math.min(limit_per_type, SAFE_WALLET_PAGE_SIZE)

      const effectiveResponseFormat = resolveDefaultResponseFormat(response_format as ResponseFormat | undefined)

      const pipesRecipe = buildWalletPipesRecipe({
        network: dataset,
        address: normalizedAddress,
        timeframe,
        mode,
        include_tokens,
        include_nfts,
      })

      // Resolve block range — numeric values are exact block counts,
      // time-based values use Portal's /timestamps/ API
      let fromBlock: number
      let windowToBlock: number
      let head = paginationCursor ? await getBlockHead(dataset) : undefined
      let resolvedWindow:
        | { range_kind: string; from_lookup?: never; to_lookup?: never }
        | Awaited<ReturnType<typeof resolveTimeframeOrBlocks>>
      let windowDescription = timeframe

      if (paginationCursor) {
        fromBlock = paginationCursor.window_from_block
        windowToBlock = paginationCursor.window_to_block
        windowDescription = paginationCursor.timeframe
        resolvedWindow = {
          range_kind: /^\d+$/.test(timeframe) ? 'block_range' : 'timeframe',
        }
      } else {
        const isBlockCount = /^\d+$/.test(timeframe)
        if (isBlockCount && from_timestamp === undefined && to_timestamp === undefined) {
          head = await getBlockHead(dataset)
          const blockRange = parseInt(timeframe, 10)
          windowToBlock = head.number
          fromBlock = Math.max(0, windowToBlock - blockRange)
          resolvedWindow = {
            range_kind: 'block_range',
          }
        } else {
          const resolved = await resolveTimeframeOrBlocks({
            dataset,
            ...(from_timestamp !== undefined || to_timestamp !== undefined
              ? {
                  from_timestamp: from_timestamp as TimestampInput | undefined,
                  to_timestamp: to_timestamp as TimestampInput | undefined,
                }
              : { timeframe }),
          })
          fromBlock = resolved.from_block
          windowToBlock = resolved.to_block
          resolvedWindow = resolved
          head = await getBlockHead(dataset)
          if (from_timestamp !== undefined || to_timestamp !== undefined) {
            const fromLabel =
              resolved.from_lookup?.normalized_input ??
              (from_timestamp !== undefined ? String(from_timestamp) : 'start')
            const toLabel =
              resolved.to_lookup?.normalized_input ?? (to_timestamp !== undefined ? String(to_timestamp) : 'now')
            windowDescription = `${fromLabel} -> ${toLabel}`
          }
        }
      }

      const requestedFromBlock = fromBlock
      if (!paginationCursor && mode === 'fast') {
        const requestedRange = windowToBlock - fromBlock + 1
        if (requestedRange > FAST_MODE_BLOCK_CAP) {
          fromBlock = Math.max(fromBlock, windowToBlock - FAST_MODE_BLOCK_CAP + 1)
        }
      }

      const includeL2 = isL2Chain(dataset)
      const sectionCursors = paginationCursor?.sections ?? {
        transactions: undefined,
        token_transfers: include_tokens ? undefined : null,
        nft_transfers: include_nfts ? undefined : null,
      }

      // Query 1: Transactions
      // Use minimal transaction fields for summary (avoid context bloat)
      const txFields: Record<string, boolean> = {
        transactionIndex: true,
        hash: true,
        from: true,
        to: true,
        value: true,
        nonce: true,
        gas: true,
        gasPrice: true,
        gasUsed: true,
        effectiveGasPrice: true,
        type: true,
        status: true,
        sighash: true,
        contractAddress: true,
      }

      if (includeL2) {
        txFields.l1Fee = true
        txFields.l1GasUsed = true
      }

      const paddedAddress = '0x' + normalizedAddress.slice(2).padStart(64, '0')

      const fetchTransactionsSection = async (): Promise<WalletSectionPage<WalletTransactionItem>> => {
        if (sectionCursors.transactions === null) {
          return {
            pageItems: [],
            hasMore: false,
            nextBoundary: null,
          }
        }

        const txCursor = sectionCursors.transactions ?? undefined
        const txQuery = {
          type: 'evm',
          fromBlock,
          toBlock: txCursor?.page_to_block ?? windowToBlock,
          fields: {
            block: { number: true, timestamp: true },
            transaction: txFields,
          },
          transactions: [{ from: [normalizedAddress] }, { to: [normalizedAddress] }],
        }

        const txFetchLimit = limit_per_type + (txCursor?.skip_inclusive_block ?? 0) + 1
        const txResults = await fetchCachedWalletSection({
          dataset,
          section: 'transactions',
          query: txQuery,
          itemKeys: ['transactions'],
          limit: txFetchLimit,
          chunkSize: 1_000,
          concurrency: 6,
          initialSequentialChunks: 1,
        })

        const pagedTransactions = paginateAscendingItems(
          sortTransactions(
            txResults.flatMap((block: unknown) => {
              const typedBlock = block as {
                number?: number
                timestamp?: number
                header?: { number?: number; timestamp?: number }
                transactions?: Record<string, unknown>[]
              }
              const blockNumber = typedBlock.number ?? typedBlock.header?.number
              const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

              return (typedBlock.transactions || []).map(
                (tx) =>
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
                  ) as WalletTransactionItem,
              )
            }),
          ),
          limit_per_type,
          getBlockNumber,
          txCursor,
        )

        return {
          pageItems: pagedTransactions.pageItems,
          hasMore: pagedTransactions.hasMore,
          nextBoundary: pagedTransactions.hasMore ? (pagedTransactions.nextBoundary ?? null) : null,
        }
      }

      const fetchTokenTransfersSection = async (): Promise<WalletSectionPage<WalletLogItem>> => {
        if (!include_tokens || sectionCursors.token_transfers === null) {
          return {
            pageItems: [],
            hasMore: false,
            nextBoundary: null,
          }
        }

        const tokenCursor = sectionCursors.token_transfers ?? undefined
        const tokenQuery = {
          type: 'evm',
          fromBlock,
          toBlock: tokenCursor?.page_to_block ?? windowToBlock,
          fields: {
            block: { number: true, timestamp: true },
            log: buildEvmLogFields(),
          },
          logs: [
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
              topic1: [paddedAddress],
            },
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
              topic2: [paddedAddress],
            },
          ],
        }

        const tokenFetchLimit = limit_per_type + (tokenCursor?.skip_inclusive_block ?? 0) + 1
        const tokenResults = await fetchCachedWalletSection({
          dataset,
          section: 'token_transfers',
          query: tokenQuery,
          itemKeys: ['logs'],
          limit: tokenFetchLimit,
          chunkSize: 1_000,
          concurrency: 6,
          initialSequentialChunks: 1,
        })

        let tokenMetadataByAddress = new Map<string, { symbol?: string; name?: string; decimals?: number }>()
        const tokenMetadataNotices: string[] = []
        try {
          const tokenMetadataResult = await getTokenMetadataMapForDatasetWithStatus(dataset)
          tokenMetadataByAddress = tokenMetadataResult.metadata
          tokenMetadataNotices.push(...buildTokenListLookupNotices(tokenMetadataResult.lookup))
        } catch (error) {
          if (error instanceof RequestCancelledError) throw error
          console.error('Failed to fetch token-list metadata:', error)
          tokenMetadataNotices.push(
            'Token-list metadata enrichment failed; token transfer values use 18 decimals unless a known token match was already cached.',
          )
        }

        const pagedTokens = paginateAscendingItems(
          sortLogs(
            tokenResults.flatMap((block: unknown) => {
              const typedBlock = block as {
                header?: { number: number; timestamp: number }
                logs?: Array<{
                  transactionHash: string
                  logIndex: number
                  address: string
                  topics?: string[]
                  data: string
                }>
              }

              return (typedBlock.logs || []).map((log) => {
                const tokenAddress = log.address.toLowerCase()
                const rawValue = log.data
                const tokenInfo = tokenMetadataByAddress.get(tokenAddress)
                const decimals = tokenInfo?.decimals ?? 18
                const formattedValue = formatTokenAmount(rawValue, decimals, tokenInfo?.symbol)

                return {
                  block_number: typedBlock.header?.number,
                  timestamp: typedBlock.header?.timestamp,
                  timestamp_human: typedBlock.header?.timestamp
                    ? formatTimestamp(typedBlock.header.timestamp)
                    : undefined,
                  transaction_hash: log.transactionHash,
                  log_index: log.logIndex,
                  token_address: tokenAddress,
                  token_name: tokenInfo?.name,
                  token_symbol: tokenInfo?.symbol,
                  token_decimals: decimals,
                  from: '0x' + (log.topics?.[1]?.slice(-40) || ''),
                  to: '0x' + (log.topics?.[2]?.slice(-40) || ''),
                  value_raw: rawValue,
                  value: formattedValue,
                  value_decimal: hexToBigInt(rawValue).toString(),
                  direction: '0x' + (log.topics?.[1]?.slice(-40) || '') === normalizedAddress ? 'out' : 'in',
                } as WalletLogItem
              })
            }),
          ),
          limit_per_type,
          getBlockNumber,
          tokenCursor,
        )

        return {
          pageItems: pagedTokens.pageItems,
          hasMore: pagedTokens.hasMore,
          nextBoundary: pagedTokens.hasMore ? (pagedTokens.nextBoundary ?? null) : null,
          notices: tokenMetadataNotices,
        }
      }

      const fetchNftTransfersSection = async (): Promise<WalletSectionPage<WalletLogItem>> => {
        if (!include_nfts || sectionCursors.nft_transfers === null) {
          return {
            pageItems: [],
            hasMore: false,
            nextBoundary: null,
          }
        }

        const nftCursor = sectionCursors.nft_transfers ?? undefined
        const nftQuery = {
          type: 'evm',
          fromBlock,
          toBlock: nftCursor?.page_to_block ?? windowToBlock,
          fields: {
            block: { number: true, timestamp: true },
            log: buildEvmLogFields(),
          },
          logs: [
            {
              topic0: [
                EVENT_SIGNATURES.TRANSFER_ERC721,
                EVENT_SIGNATURES.TRANSFER_SINGLE,
                EVENT_SIGNATURES.TRANSFER_BATCH,
              ],
              topic1: [paddedAddress],
            },
            {
              topic0: [
                EVENT_SIGNATURES.TRANSFER_ERC721,
                EVENT_SIGNATURES.TRANSFER_SINGLE,
                EVENT_SIGNATURES.TRANSFER_BATCH,
              ],
              topic2: [paddedAddress],
            },
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_SINGLE, EVENT_SIGNATURES.TRANSFER_BATCH],
              topic3: [paddedAddress],
            },
          ],
        }

        const nftFetchLimit = limit_per_type + (nftCursor?.skip_inclusive_block ?? 0) + 1
        const nftResults = await fetchCachedWalletSection({
          dataset,
          section: 'nft_transfers',
          query: nftQuery,
          itemKeys: ['logs'],
          limit: nftFetchLimit,
          chunkSize: 1_000,
          concurrency: 6,
          initialSequentialChunks: 1,
        })

        const pagedNfts = paginateAscendingItems(
          sortLogs(
            nftResults.flatMap((block: unknown) => {
              const typedBlock = block as {
                header?: { number: number; timestamp: number }
                logs?: Array<{
                  transactionHash: string
                  logIndex: number
                  address: string
                  topics?: string[]
                  data: string
                }>
              }

              return (typedBlock.logs || []).map(
                (log) =>
                  ({
                    block_number: typedBlock.header?.number,
                    timestamp: typedBlock.header?.timestamp,
                    transaction_hash: log.transactionHash,
                    log_index: log.logIndex,
                    contract_address: log.address,
                    token_id: log.topics?.[3],
                    data: log.data,
                  }) as WalletLogItem,
              )
            }),
          ),
          limit_per_type,
          getBlockNumber,
          nftCursor,
        )

        return {
          pageItems: pagedNfts.pageItems,
          hasMore: pagedNfts.hasMore,
          nextBoundary: pagedNfts.hasMore ? (pagedNfts.nextBoundary ?? null) : null,
        }
      }

      const [transactionOutcome, tokenOutcome, nftOutcome] = await Promise.allSettled([
        fetchTransactionsSection(),
        fetchTokenTransfersSection(),
        fetchNftTransfersSection(),
      ])

      const activeSectionOutcomes = [
        {
          key: 'transactions',
          label: 'transactions',
          enabled: sectionCursors.transactions !== null,
          outcome: transactionOutcome,
        },
        {
          key: 'token_transfers',
          label: 'token transfers',
          enabled: include_tokens && sectionCursors.token_transfers !== null,
          outcome: tokenOutcome,
        },
        {
          key: 'nft_transfers',
          label: 'NFT transfers',
          enabled: include_nfts && sectionCursors.nft_transfers !== null,
          outcome: nftOutcome,
        },
      ] as const
      const cancelledSection = activeSectionOutcomes.find(
        (section) => section.outcome.status === 'rejected' && section.outcome.reason instanceof RequestCancelledError,
      )
      if (cancelledSection?.outcome.status === 'rejected') throw cancelledSection.outcome.reason

      const failedActiveSections = activeSectionOutcomes.filter(
        (section) => section.enabled && section.outcome.status === 'rejected',
      )
      const enabledSectionCount = activeSectionOutcomes.filter((section) => section.enabled).length
      if (
        failedActiveSections.length === enabledSectionCount &&
        failedActiveSections[0]?.outcome.status === 'rejected'
      ) {
        throw failedActiveSections[0].outcome.reason
      }

      const sectionFailures: Array<{ key: string; label: string; message: string }> = []
      const resolveSection = <T>(
        key: string,
        label: string,
        outcome: PromiseSettledResult<WalletSectionPage<T>>,
      ): WalletSectionPage<T> => {
        if (outcome.status === 'fulfilled') return outcome.value
        const message = sanitizeText(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason))
        sectionFailures.push({ key, label, message: message.slice(0, 180) })
        return {
          pageItems: [],
          hasMore: false,
          nextBoundary: null,
          notices: [`The ${label} section was unavailable for this response: ${message.slice(0, 180)}`],
        }
      }

      const transactionSection = resolveSection('transactions', 'transactions', transactionOutcome)
      const tokenSection = resolveSection('token_transfers', 'token transfers', tokenOutcome)
      const nftSection = resolveSection('nft_transfers', 'NFT transfers', nftOutcome)

      const transactions = transactionSection.pageItems
      const txHasMore = transactionSection.hasMore
      const txNextBoundary = transactionSection.nextBoundary

      const tokenTransfers = tokenSection.pageItems
      const tokenHasMore = tokenSection.hasMore
      const tokenNextBoundary = tokenSection.nextBoundary

      const nftTransfers = nftSection.pageItems
      const nftHasMore = nftSection.hasMore
      const nftNextBoundary = nftSection.nextBoundary

      const hasMore = txHasMore || tokenHasMore || nftHasMore
      const walletWindowComplete = fromBlock <= requestedFromBlock && sectionFailures.length === 0
      const walletCompleteness = buildWalletCompleteness({
        hasMore,
        windowComplete: walletWindowComplete,
        failedSections: sectionFailures.map((failure) => failure.key),
      })
      const nextCursor = hasMore
        ? createWalletSummaryCursor({
            dataset,
            address: normalizedAddress,
            timeframe: windowDescription,
            mode,
            response_format: effectiveResponseFormat,
            include_tokens,
            include_nfts,
            limit_per_type,
            window_from_block: fromBlock,
            window_to_block: windowToBlock,
            sections: {
              transactions: txNextBoundary,
              ...(include_tokens ? { token_transfers: tokenNextBoundary } : {}),
              ...(include_nfts ? { nft_transfers: nftNextBoundary } : {}),
            },
          })
        : undefined

      const notices: string[] = []
      if (requestedLimitPerType > limit_per_type) {
        notices.push(
          `Accepted the retained limit_per_type ${requestedLimitPerType} for installed-client compatibility and returned safe ${limit_per_type}-row category pages. Continue with _pagination.next_cursor for older activity.`,
        )
      }
      notices.push(...(transactionSection.notices ?? []))
      notices.push(...(tokenSection.notices ?? []))
      notices.push(...(nftSection.notices ?? []))
      const limitedItems: string[] = []
      if (hasMore) {
        if (txHasMore) limitedItems.push('transactions')
        if (tokenHasMore) limitedItems.push('token transfers')
        if (nftHasMore) limitedItems.push('NFT transfers')
        notices.push(
          `Showing the latest ${limit_per_type} ${limitedItems.join(', ')} in this page. Call the same tool again with _pagination.next_cursor to load older wallet activity.`,
        )
      }
      if (!paginationCursor && mode === 'fast' && fromBlock > requestedFromBlock) {
        notices.push(
          `Analyzed the most recent ${FAST_MODE_BLOCK_CAP.toLocaleString()} blocks in the requested wallet window because the caller requested a bounded preview.`,
        )
      }

      /* The same facts for people reading a rendered App, without tool
         parameter names. The notices above stay written for tool callers. */
      const userNotices = [
        ...notices.filter(
          (notice) => !notice.startsWith('Accepted the retained') && !notice.startsWith('Showing the latest'),
        ),
        ...(hasMore
          ? [
              `Showing the latest ${limit_per_type} ${limitedItems.join(' and ')} in this page. Load older wallet activity to continue.`,
            ]
          : []),
      ]

      const compactTransactions = transactions.map(compactWalletTransactionItem)
      const compactTokenTransfers = tokenTransfers.map(compactWalletTokenTransferItem)
      const compactNftTransfers = nftTransfers.map(compactWalletNftTransferItem)
      const combinedActivity = [...compactTransactions, ...compactTokenTransfers, ...compactNftTransfers]
        .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0))
        .map((item) => annotateWalletDirection(item, normalizedAddress))
      const topCounterparties = buildTopCounterparties(combinedActivity, normalizedAddress)
      const fundFlow = buildEvmFundFlow({
        walletAddress: normalizedAddress,
        transactions,
        tokenTransfers,
      })
      const tables = [
        buildEvmWalletActivityTable(combinedActivity.length),
        ...(fundFlow.asset_flows.length > 0 ? [buildWalletAssetFlowsTable(fundFlow.asset_flows.length)] : []),
        ...(fundFlow.movement_counterparties.length > 0
          ? [buildWalletFlowCounterpartiesTable(fundFlow.movement_counterparties.length)]
          : []),
        ...(fundFlow.largest_movements.length > 0
          ? [buildWalletLargestMovementsTable(fundFlow.largest_movements.length)]
          : []),
      ]
      const panels = [
        buildTimelinePanel({
          id: 'wallet-timeline',
          kind: 'timeline_panel',
          title: 'Activity timeline',
          subtitle: 'Every row in this page, oldest first, with direction and amount where an asset moved.',
          data_key: 'activity.items',
          timestamp_key: 'timestamp_human',
          title_key: 'record_type',
          subtitle_keys: ['sender', 'recipient'],
          direction_key: 'direction',
          value_key: 'amount_value',
          value_format: 'decimal',
          unit_key: 'asset',
          badge_key: 'record_type',
          emphasis: 'primary',
        }),
        ...(fundFlow.movement_counterparties.length > 0
          ? [
              buildRankedBarsPanel({
                id: 'wallet-flow-counterparties',
                kind: 'ranked_bars_panel',
                title: 'Asset movement counterparties',
                subtitle: 'Addresses ranked by observed asset movements with this wallet.',
                data_key: 'fund_flow.movement_counterparties',
                category_key: 'address',
                value_key: 'activity_count',
                value_format: 'integer',
              }),
            ]
          : []),
        buildTablePanel({
          id: 'wallet-table',
          kind: 'table_panel',
          title: 'Activity table',
          subtitle: 'Exact rows for the selected wallet window.',
          table_id: 'activity',
        }),
        ...(fundFlow.asset_flows.length > 0
          ? [
              buildTablePanel({
                id: 'wallet-asset-flow',
                kind: 'table_panel',
                title: 'Asset flow',
                subtitle: 'Inbound, outbound, and net observed movement by asset.',
                table_id: 'asset_flows',
              }),
            ]
          : []),
        ...(fundFlow.largest_movements.length > 0
          ? [
              buildTablePanel({
                id: 'wallet-largest-movements',
                kind: 'table_panel',
                title: 'Largest movements within each asset',
                subtitle: 'Exact largest observed movements, ranked only within the same asset.',
                table_id: 'largest_movements',
              }),
            ]
          : []),
      ]

      const summary: Record<string, unknown> = {
        overview: {
          network: dataset,
          vm: 'evm',
          address: normalizedAddress,
          from_block: requestedFromBlock,
          to_block: windowToBlock,
          analyzed_from_block: fromBlock,
          description: windowDescription,
          result_state: walletCompleteness.state,
        },
        completeness: walletCompleteness,
        section_status: {
          transactions: sectionFailures.some((failure) => failure.key === 'transactions') ? 'unavailable' : 'available',
          token_transfers: !include_tokens
            ? 'omitted'
            : sectionFailures.some((failure) => failure.key === 'token_transfers')
              ? 'unavailable'
              : 'available',
          nft_transfers: !include_nfts
            ? 'omitted'
            : sectionFailures.some((failure) => failure.key === 'nft_transfers')
              ? 'unavailable'
              : 'available',
        },
        activity: {
          count: combinedActivity.length,
          items: combinedActivity,
        },
        fund_flow: fundFlow,
        relationships: {
          activity_counterparties: topCounterparties,
          activity_counterparty_count: topCounterparties.length,
          definition: 'Counterparties observed across transaction and transfer activity rows in this page.',
        },
        assets: {
          ...(include_tokens && !sectionFailures.some((failure) => failure.key === 'token_transfers')
            ? { token_transfers: compactTokenTransfers.length }
            : {}),
          ...(include_nfts && !sectionFailures.some((failure) => failure.key === 'nft_transfers')
            ? { nft_transfers: compactNftTransfers.length }
            : {}),
        },
        evm: {
          transactions: {
            count: compactTransactions.length,
            sent: transactions.filter((tx) => String(tx.from || '').toLowerCase() === normalizedAddress).length,
            received: transactions.filter((tx) => String(tx.from || '').toLowerCase() !== normalizedAddress).length,
          },
          token_transfers: include_tokens
            ? {
                count: compactTokenTransfers.length,
              }
            : null,
          nft_transfers: include_nfts
            ? {
                count: compactNftTransfers.length,
              }
            : null,
        },
        tables,
      }

      const topFlowCounterparty = fundFlow.summary.top_movement_counterparty
        ? ` Top asset-movement counterparty: ${fundFlow.summary.top_movement_counterparty}.`
        : ''
      const partialPrefix =
        sectionFailures.length > 0
          ? `Partial wallet summary; ${sectionFailures.map((failure) => failure.label).join(', ')} unavailable. `
          : ''
      const message = hasMore
        ? `${partialPrefix}Wallet flow for ${normalizedAddress}: ${fundFlow.summary.inbound_events} inbound and ${fundFlow.summary.outbound_events} outbound movement events from ${describeWalletWindow(windowDescription)} (preview page capped at ${limit_per_type}; continue with cursor for older rows).${topFlowCounterparty}`
        : `${partialPrefix}Wallet flow for ${normalizedAddress}: ${fundFlow.summary.inbound_events} inbound and ${fundFlow.summary.outbound_events} outbound movement events from ${describeWalletWindow(windowDescription)}.${topFlowCounterparty}`

      return formatResult(applyWalletSummaryResponseFormat(summary, effectiveResponseFormat), message, {
        toolName: 'portal_get_wallet_summary',
        notices,
        pagination: {
          type: 'cursor',
          page_size: limit_per_type,
          returned: transactions.length + tokenTransfers.length + nftTransfers.length,
          has_more: hasMore,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
          sections: {
            transactions: buildSectionPagination(transactions.length, txHasMore),
            ...(include_tokens ? { token_transfers: buildSectionPagination(tokenTransfers.length, tokenHasMore) } : {}),
            ...(include_nfts ? { nft_transfers: buildSectionPagination(nftTransfers.length, nftHasMore) } : {}),
          },
        },
        freshness: buildQueryFreshness({
          finality: 'latest',
          headBlockNumber: head?.number ?? windowToBlock,
          windowToBlock,
          resolvedWindow,
        }),
        coverage: buildSectionCoverage({
          windowFromBlock: requestedFromBlock,
          windowToBlock,
          hasMore,
          windowComplete: walletWindowComplete,
          failedSections: sectionFailures.map((failure) => failure.key),
          sections: {
            transactions: buildSectionPagination(transactions.length, txHasMore),
            ...(include_tokens ? { token_transfers: buildSectionPagination(tokenTransfers.length, tokenHasMore) } : {}),
            ...(include_nfts ? { nft_transfers: buildSectionPagination(nftTransfers.length, nftHasMore) } : {}),
          },
        }),
        execution: buildExecutionMetadata({
          mode,
          response_format: effectiveResponseFormat,
          result_scope: hasMore
            ? 'preview_page'
            : fromBlock > requestedFromBlock || sectionFailures.length > 0
              ? 'partial_window'
              : 'complete_window',
          requested_blocks: Math.max(0, windowToBlock - requestedFromBlock + 1),
          analyzed_blocks: Math.max(0, windowToBlock - fromBlock + 1),
          estimated_scan_blocks: Math.max(0, windowToBlock - fromBlock + 1),
          estimated_runtime_class:
            windowToBlock - fromBlock + 1 <= 3_000
              ? 'interactive'
              : windowToBlock - fromBlock + 1 <= 50_000
                ? 'long_window'
                : 'expensive',
          recommended_window:
            'Use timeframe="30m" for a bounded interactive EVM triage window, or continue with the cursor for more rows in this window.',
          from_block: fromBlock,
          to_block: windowToBlock,
          range_kind: resolvedWindow.range_kind,
          limit: limit_per_type,
          notes: [
            include_tokens ? 'Token-transfer section included.' : 'Token-transfer section omitted.',
            include_nfts ? 'NFT section included.' : 'NFT section omitted.',
            ...sectionFailures.map((failure) => `${failure.label} unavailable: ${failure.message}`),
          ],
        }),
        pipes: pipesRecipe,
        ui: buildWalletUi({
          notices: userNotices,
          title: normalizedAddress,
          subtitle: `${describeWalletWindow(windowDescription)} on ${networkLabel}`,
          activityCountPath: 'activity.count',
          primaryValuePath: 'evm.transactions.count',
          primaryLabel: 'Transactions',
          primaryFormat: 'integer',
          secondaryCards: [
            buildMetricCard({
              id: 'counterparties',
              label: 'Counterparties',
              value_path: 'relationships.activity_counterparty_count',
              format: 'integer',
            }),
            ...(include_tokens && !sectionFailures.some((failure) => failure.key === 'token_transfers')
              ? [
                  buildMetricCard({
                    id: 'token-transfers',
                    label: 'Token transfers',
                    value_path: 'assets.token_transfers',
                    format: 'integer',
                  }),
                ]
              : []),
            ...(include_nfts && !sectionFailures.some((failure) => failure.key === 'nft_transfers')
              ? [
                  buildMetricCard({
                    id: 'nft-transfers',
                    label: 'NFT transfers',
                    value_path: 'assets.nft_transfers',
                    format: 'integer',
                  }),
                ]
              : []),
          ],
          panels,
          followUpActions: [
            ...(nextCursor
              ? [
                  {
                    label: 'Load older wallet activity',
                    intent: 'continue' as const,
                    target: '_pagination.next_cursor',
                  },
                ]
              : []),
            { label: 'Show raw activity rows', intent: 'show_raw', target: 'activity.items' },
          ],
        }),
        llm: buildWalletLlmOverrides('evm'),
        metadata: {
          network: dataset,
          dataset,
          from_block: fromBlock,
          to_block: windowToBlock,
          query_start_time: queryStartTime,
        },
      })
    },
    { deadlineMs: WALLET_TOOL_DEADLINE_MS },
  )
}

async function buildNonEvmWalletSummary(params: {
  dataset: string
  chainType: ReturnType<typeof detectChainType>
  address?: string
  timeframe: string
  from_timestamp?: string | number
  to_timestamp?: string | number
  mode: 'fast' | 'deep'
  limit_per_type: number
  response_format?: ResponseFormat
  queryStartTime: number
  paginationCursor?: WalletSummaryCursor
  compatibilityNotices?: string[]
}) {
  const {
    dataset,
    chainType,
    address,
    timeframe,
    from_timestamp,
    to_timestamp,
    mode,
    limit_per_type,
    response_format,
    queryStartTime,
    paginationCursor,
    compatibilityNotices = [],
  } = params
  const effectiveResponseFormat = resolveDefaultResponseFormat(response_format)
  const networkLabel = humanizeLabel(dataset) ?? dataset
  const pipesRecipe = buildWalletPipesRecipe({
    network: dataset,
    address: address ?? 'unknown-wallet',
    timeframe,
    mode,
  })
  if (!address) {
    throw new ActionableError('address is required for wallet summary.', [
      'Provide address for a fresh wallet summary.',
    ])
  }

  const head = await getBlockHead(dataset)
  const useInteractiveHyperliquidEstimate =
    mode === 'fast' &&
    (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') &&
    from_timestamp === undefined &&
    to_timestamp === undefined &&
    !/^\d+$/.test(timeframe)
  const estimatedBlockTime = estimateBlockTime(dataset, chainType)
  const estimatedBlockCount = useInteractiveHyperliquidEstimate
    ? Math.max(1, Math.floor(parseTimeframeToSeconds(timeframe) / estimatedBlockTime))
    : 0
  const resolvedWindow = paginationCursor
    ? {
        from_block: paginationCursor.window_from_block,
        to_block: paginationCursor.window_to_block,
        range_kind: /^\d+$/.test(timeframe) ? ('block_range' as const) : ('timeframe' as const),
      }
    : useInteractiveHyperliquidEstimate
      ? {
          from_block: Math.max(0, head.number - estimatedBlockCount + 1),
          to_block: head.number,
          range_kind: 'timeframe' as const,
          estimated_timeframe: {
            resolution: 'estimated' as const,
            dataset,
            from_block: Math.max(0, head.number - estimatedBlockCount + 1),
            to_block: head.number,
            estimated_block_time_seconds: estimatedBlockTime,
            reason: 'interactive_fast_path' as const,
          },
        }
      : from_timestamp !== undefined || to_timestamp !== undefined || !/^\d+$/.test(timeframe)
        ? await resolveTimeframeOrBlocks({
            dataset,
            ...(from_timestamp !== undefined || to_timestamp !== undefined
              ? {
                  from_timestamp: from_timestamp as TimestampInput | undefined,
                  to_timestamp: to_timestamp as TimestampInput | undefined,
                }
              : { timeframe }),
          })
        : {
            from_block: Math.max(0, head.number - parseInt(timeframe, 10)),
            to_block: head.number,
            range_kind: 'block_range' as const,
          }

  const requestedFromBlock = resolvedWindow.from_block
  const toBlock = resolvedWindow.to_block
  let fromBlock = requestedFromBlock
  const notices = [
    'This non-EVM wallet summary currently returns a cross-chain overview rather than the richer EVM multi-section scan.',
    ...compatibilityNotices,
    ...getTimestampWindowNotices(resolvedWindow),
  ]

  if (mode === 'fast') {
    const fastBlockCap =
      chainType === 'solana'
        ? 250
        : chainType === 'bitcoin'
          ? 200
          : chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds'
            ? 2_000
            : undefined

    if (fastBlockCap !== undefined && toBlock - fromBlock + 1 > fastBlockCap) {
      fromBlock = Math.max(fromBlock, toBlock - fastBlockCap + 1)
      notices.push(
        `Analyzed the most recent ${fastBlockCap.toLocaleString()} blocks in the requested wallet window because the caller requested a bounded preview.`,
      )
    }
  }

  if (chainType === 'solana') {
    const transactionCursor = paginationCursor?.sections.transactions ?? undefined
    const txQuery = {
      type: 'solana',
      fromBlock,
      toBlock: transactionCursor?.page_to_block ?? toBlock,
      fields: {
        block: { number: true, timestamp: true },
        transaction: {
          transactionIndex: true,
          signatures: true,
          fee: true,
          feePayer: true,
          err: true,
        },
      },
      transactions: [{ feePayer: [address] }],
    }

    const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, txQuery, {
      itemKeys: ['transactions'],
      limit: limit_per_type + (transactionCursor?.skip_inclusive_block ?? 0) + 1,
      chunkSize: Math.max(100, Math.min(500, limit_per_type * 50)),
      concurrency: 6,
      initialSequentialChunks: 1,
      timeout: WALLET_QUERY_TIMEOUT_MS,
      retries: WALLET_QUERY_RETRIES,
    })

    const allItems = sortTransactions(
      results.flatMap((block: any) => {
        const blockNumber = block.number ?? block.header?.number
        const timestamp = block.timestamp ?? block.header?.timestamp
        return (block.transactions || []).map((tx: any) => {
          const signature =
            Array.isArray(tx.signatures) && typeof tx.signatures[0] === 'string' ? tx.signatures[0] : undefined

          // Portal can attach large transaction context even when a narrow field
          // selection was requested. Build the wallet row from the explicit
          // contract instead of spreading that unbounded upstream object into an
          // MCP response.
          return normalizeSolanaTransactionResult({
            ...(signature ? { signature } : {}),
            ...(typeof tx.transactionIndex === 'number' ? { transactionIndex: tx.transactionIndex } : {}),
            ...(typeof tx.fee === 'number' || typeof tx.fee === 'string' ? { fee: tx.fee } : {}),
            ...(typeof tx.feePayer === 'string' ? { feePayer: tx.feePayer } : {}),
            // A Solana runtime error can be a deeply nested object. Wallet
            // summaries only promise transaction outcome, so expose the exact
            // success/failure fact without copying an unbounded error payload.
            success: tx.err === null || tx.err === undefined,
            ...(blockNumber !== undefined ? { block_number: blockNumber, slot_number: blockNumber } : {}),
            ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
          })
        })
      }) as WalletTransactionItem[],
    )
    const transactionPage = paginateAscendingItems(allItems, limit_per_type, getBlockNumber, transactionCursor)
    const items = transactionPage.pageItems.map((item) => {
      const feeLamports = parseBigIntAmount(item.fee)
      return {
        ...item,
        fee: feeLamports.toString(),
        fee_lamports: feeLamports.toString(),
      }
    })
    const hasMore = transactionPage.hasMore
    const solanaWindowComplete = fromBlock <= requestedFromBlock
    const solanaCompleteness = buildWalletCompleteness({ hasMore, windowComplete: solanaWindowComplete })
    const nextCursor = hasMore
      ? createWalletSummaryCursor({
          dataset,
          address,
          timeframe,
          mode,
          response_format: effectiveResponseFormat,
          include_tokens: false,
          include_nfts: false,
          limit_per_type,
          window_from_block: requestedFromBlock,
          window_to_block: toBlock,
          sections: {
            transactions: transactionPage.nextBoundary ?? null,
          },
        })
      : undefined
    if (nextCursor) {
      notices.push('Older Solana wallet transactions are available via _pagination.next_cursor.')
    }
    const totalFees = items.reduce((sum, item) => sum + parseBigIntAmount(item.fee), 0n)
    const averageFee =
      items.length > 0
        ? divideExactDecimals({ coefficient: totalFees, scale: 0 }, { coefficient: BigInt(items.length), scale: 0 }, 18)
        : { value: '0', rounded: false }
    const feeMovements = rankMovementsWithinAssets(
      items.map((item) => {
        const feeLamports = parseBigIntAmount(item.fee)
        return {
          direction: 'out' as const,
          asset_type: 'fee' as const,
          asset: 'SOL fees',
          amount: `${feeLamports.toString()} lamports`,
          amount_decimal: feeLamports.toString(),
          amount_raw: feeLamports.toString(),
          amount_decimals: 0,
          tx_hash: typeof item.tx_hash === 'string' ? item.tx_hash : undefined,
          block_number: getBlockNumber(item),
          timestamp: typeof item.timestamp === 'number' ? item.timestamp : undefined,
          timestamp_human: typeof item.timestamp_human === 'string' ? item.timestamp_human : undefined,
          record_type: 'transaction',
        }
      }),
      5,
      5,
    )
    const fundFlow = {
      definition: 'Solana fee movement only. Transaction activity remains available in activity.items.',
      ranking_definition: 'largest_movements ranks lamport fees only; all rows use the same SOL fee asset.',
      summary: {
        inbound_events: 0,
        outbound_events: items.length,
        fee_outflow_lamports: totalFees.toString(),
        asset_count: 1,
        scope: 'Solana wallet flow currently covers fee-payer transactions and fee outflow for this address.',
      },
      asset_flows: [
        buildSimpleAssetFlow({
          assetType: 'fee',
          asset: 'SOL fees',
          inboundCount: 0,
          outboundCount: items.length,
          inboundAmount: '0 lamports',
          outboundAmount: `${totalFees.toString()} lamports`,
          netAmount: `-${totalFees.toString()} lamports`,
          netDirection: totalFees > 0n ? 'out' : 'flat',
        }),
      ],
      movement_counterparties: [],
      largest_movements: feeMovements,
      next_pivots: items[0]?.tx_hash
        ? [
            {
              goal: 'Inspect a Solana transaction',
              tool: 'portal_solana_query_transactions',
              tx_hash: items[0].tx_hash,
            },
          ]
        : [],
    }

    return formatResult(
      applyWalletSummaryResponseFormat(
        {
          overview: {
            network: dataset,
            vm: 'solana',
            address,
            from_block: requestedFromBlock,
            to_block: toBlock,
            analyzed_from_block: fromBlock,
            recent_activity_count: items.length,
            result_state: solanaCompleteness.state,
          },
          completeness: solanaCompleteness,
          activity: {
            count: items.length,
            items,
          },
          fund_flow: fundFlow,
          assets: {
            token_balance_changes: [],
          },
          solana: {
            fee_summary: {
              total_fees_lamports: totalFees.toString(),
              avg_fee_lamports: averageFee.value ?? '0',
              avg_fee_rounded: averageFee.rounded,
            },
          },
          tables: [
            buildWalletActivityTable('Wallet activity', items.length),
            buildWalletAssetFlowsTable(fundFlow.asset_flows.length),
            buildWalletLargestMovementsTable(fundFlow.largest_movements.length),
          ],
        },
        effectiveResponseFormat,
      ),
      `Wallet flow for ${address} on ${networkLabel}: ${items.length} recent Solana transactions and ${totalFees.toString()} lamports in observed fees.${nextCursor ? ' This is a preview page; continue with the cursor for older rows.' : ''}`,
      {
        toolName: 'portal_get_wallet_summary',
        notices,
        pagination: {
          type: 'cursor',
          page_size: limit_per_type,
          returned: items.length,
          has_more: hasMore,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
          sections: {
            transactions: buildSectionPagination(items.length, hasMore),
          },
        },
        freshness: buildQueryFreshness({
          finality: 'latest',
          headBlockNumber: head.number,
          windowToBlock: toBlock,
          resolvedWindow,
        }),
        execution: buildExecutionMetadata({
          mode,
          response_format: effectiveResponseFormat,
          result_scope: hasMore
            ? 'preview_page'
            : fromBlock > requestedFromBlock
              ? 'partial_window'
              : 'complete_window',
          requested_blocks: Math.max(0, toBlock - requestedFromBlock + 1),
          analyzed_blocks: Math.max(0, toBlock - fromBlock + 1),
          estimated_scan_blocks: Math.max(0, toBlock - fromBlock + 1),
          estimated_runtime_class:
            toBlock - fromBlock + 1 <= 2_000
              ? 'interactive'
              : toBlock - fromBlock + 1 <= 100_000
                ? 'long_window'
                : 'expensive',
          recommended_window: 'Use timeframe="15m" for a bounded interactive Solana triage window.',
          from_block: fromBlock,
          to_block: toBlock,
          range_kind: resolvedWindow.range_kind,
          normalized_output: true,
        }),
        pipes: pipesRecipe,
        ui: buildWalletUi({
          title: address,
          subtitle: `${describeWalletWindow(timeframe)} on ${networkLabel}`,
          activityCountPath: 'activity.count',
          primaryValuePath: 'solana.fee_summary.total_fees_lamports',
          primaryLabel: 'Total fees',
          primaryFormat: 'decimal',
          secondaryCards: [
            buildMetricCard({
              id: 'avg-fee',
              label: 'Average fee',
              value_path: 'solana.fee_summary.avg_fee_lamports',
              format: 'decimal',
            }),
          ],
          followUpActions: [
            ...(nextCursor
              ? [
                  {
                    label: 'Load older wallet activity',
                    intent: 'continue' as const,
                    target: '_pagination.next_cursor',
                  },
                ]
              : []),
            { label: 'Show raw activity rows', intent: 'show_raw', target: 'activity.items' },
          ],
        }),
        llm: buildWalletLlmOverrides('solana'),
        coverage: buildSectionCoverage({
          windowFromBlock: requestedFromBlock,
          windowToBlock: toBlock,
          hasMore,
          windowComplete: solanaWindowComplete,
          sections: {
            activity: buildSectionPagination(items.length, hasMore),
          },
        }),
        metadata: {
          network: dataset,
          dataset,
          from_block: fromBlock,
          to_block: toBlock,
          query_start_time: queryStartTime,
        },
      },
    )
  }

  if (chainType === 'bitcoin') {
    const outputCursor = paginationCursor?.sections.outputs ?? undefined
    const inputCursor = paginationCursor?.sections.inputs ?? undefined
    const outputsExhausted = Boolean(paginationCursor && paginationCursor.sections.outputs === null)
    const inputsExhausted = Boolean(paginationCursor && paginationCursor.sections.inputs === null)
    const [outputBlocks, inputBlocks] = await Promise.all([
      outputsExhausted
        ? Promise.resolve([])
        : portalFetchRecentRecords(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            {
              type: 'bitcoin',
              fromBlock,
              toBlock: outputCursor?.page_to_block ?? toBlock,
              fields: {
                block: { number: true, timestamp: true },
                output: { transactionIndex: true, outputIndex: true, value: true, scriptPubKeyAddress: true },
                transaction: { transactionIndex: true, hash: true },
              },
              outputs: [{ scriptPubKeyAddress: [address], transaction: true }],
            },
            {
              itemKeys: ['outputs'],
              countItems: (record) => {
                const outputs = (record as { outputs?: Array<{ scriptPubKeyAddress?: string }> })?.outputs
                return Array.isArray(outputs)
                  ? outputs.filter((output) => output.scriptPubKeyAddress === address).length
                  : 0
              },
              limit: limit_per_type + (outputCursor?.skip_inclusive_block ?? 0) + 1,
              chunkSize: 100,
              concurrency: 2,
              timeout: WALLET_QUERY_TIMEOUT_MS,
              retries: WALLET_QUERY_RETRIES,
            },
          ),
      inputsExhausted
        ? Promise.resolve([])
        : portalFetchRecentRecords(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            {
              type: 'bitcoin',
              fromBlock,
              toBlock: inputCursor?.page_to_block ?? toBlock,
              fields: {
                block: { number: true, timestamp: true },
                input: {
                  transactionIndex: true,
                  inputIndex: true,
                  prevoutValue: true,
                  prevoutScriptPubKeyAddress: true,
                },
                transaction: { transactionIndex: true, hash: true },
              },
              inputs: [{ prevoutScriptPubKeyAddress: [address], transaction: true }],
            },
            {
              itemKeys: ['inputs'],
              countItems: (record) => {
                const inputs = (record as { inputs?: Array<{ prevoutScriptPubKeyAddress?: string }> })?.inputs
                return Array.isArray(inputs)
                  ? inputs.filter((input) => input.prevoutScriptPubKeyAddress === address).length
                  : 0
              },
              limit: limit_per_type + (inputCursor?.skip_inclusive_block ?? 0) + 1,
              chunkSize: 100,
              concurrency: 2,
              timeout: WALLET_QUERY_TIMEOUT_MS,
              retries: WALLET_QUERY_RETRIES,
            },
          ),
    ])

    const matchingOutputs = outputBlocks
      .flatMap((block: any) => {
        const transactionHashes = new Map<number, string>(
          (block.transactions || [])
            .filter((tx: any) => typeof tx.transactionIndex === 'number' && typeof tx.hash === 'string')
            .map((tx: any) => [tx.transactionIndex, tx.hash]),
        )
        const blockNumber = block.number ?? block.header?.number
        const timestamp = block.timestamp ?? block.header?.timestamp
        return (block.outputs || [])
          .filter((output: any) => output.scriptPubKeyAddress === address)
          .map((output: any) =>
            normalizeBitcoinOutputResult({
              ...(typeof output.transactionIndex === 'number' ? { transactionIndex: output.transactionIndex } : {}),
              ...(typeof output.outputIndex === 'number' ? { outputIndex: output.outputIndex } : {}),
              ...(typeof output.value === 'number' || typeof output.value === 'string' ? { value: output.value } : {}),
              ...(typeof output.scriptPubKeyAddress === 'string'
                ? { scriptPubKeyAddress: output.scriptPubKeyAddress }
                : {}),
              ...(typeof output.transactionIndex === 'number' && transactionHashes.has(output.transactionIndex)
                ? { txid: transactionHashes.get(output.transactionIndex) }
                : {}),
              ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
              ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
            }),
          )
      })
      .sort(
        (left: any, right: any) =>
          Number(left.block_number || 0) - Number(right.block_number || 0) ||
          Number(left.transactionIndex || 0) - Number(right.transactionIndex || 0) ||
          Number(left.outputIndex || 0) - Number(right.outputIndex || 0),
      )
    const matchingInputs = inputBlocks
      .flatMap((block: any) => {
        const transactionHashes = new Map<number, string>(
          (block.transactions || [])
            .filter((tx: any) => typeof tx.transactionIndex === 'number' && typeof tx.hash === 'string')
            .map((tx: any) => [tx.transactionIndex, tx.hash]),
        )
        const blockNumber = block.number ?? block.header?.number
        const timestamp = block.timestamp ?? block.header?.timestamp
        return (block.inputs || [])
          .filter((input: any) => input.prevoutScriptPubKeyAddress === address)
          .map((input: any) =>
            normalizeBitcoinInputResult({
              ...(typeof input.transactionIndex === 'number' ? { transactionIndex: input.transactionIndex } : {}),
              ...(typeof input.inputIndex === 'number' ? { inputIndex: input.inputIndex } : {}),
              ...(typeof input.prevoutValue === 'number' || typeof input.prevoutValue === 'string'
                ? { prevoutValue: input.prevoutValue }
                : {}),
              ...(typeof input.prevoutScriptPubKeyAddress === 'string'
                ? { prevoutScriptPubKeyAddress: input.prevoutScriptPubKeyAddress }
                : {}),
              ...(typeof input.transactionIndex === 'number' && transactionHashes.has(input.transactionIndex)
                ? { txid: transactionHashes.get(input.transactionIndex) }
                : {}),
              ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
              ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
            }),
          )
      })
      .sort(
        (left: any, right: any) =>
          Number(left.block_number || 0) - Number(right.block_number || 0) ||
          Number(left.transactionIndex || 0) - Number(right.transactionIndex || 0) ||
          Number(left.inputIndex || 0) - Number(right.inputIndex || 0),
      )
    const outputPage = paginateAscendingItems<any>(matchingOutputs, limit_per_type, getBlockNumber, outputCursor)
    const inputPage = paginateAscendingItems<any>(matchingInputs, limit_per_type, getBlockNumber, inputCursor)
    const outputsHaveMore = outputPage.hasMore
    const inputsHaveMore = inputPage.hasMore
    const bitcoinHasMore = outputsHaveMore || inputsHaveMore
    const bitcoinWindowComplete = fromBlock <= requestedFromBlock
    const bitcoinCompleteness = buildWalletCompleteness({
      hasMore: bitcoinHasMore,
      windowComplete: bitcoinWindowComplete,
    })
    const outputs = outputPage.pageItems.map((item) => {
      const valueSats = bitcoinValueToSats(item.value)
      const valueBtc = formatSatsAsBtc(valueSats)
      return { ...item, value: valueBtc, value_btc: valueBtc, value_sats: valueSats.toString() }
    })
    const inputs = inputPage.pageItems.map((item) => {
      const valueSats = bitcoinValueToSats(item.prevoutValue)
      const valueBtc = formatSatsAsBtc(valueSats)
      return {
        ...item,
        prevoutValue: valueBtc,
        prevout_value_btc: valueBtc,
        prevout_value_sats: valueSats.toString(),
      }
    })
    const nextCursor = bitcoinHasMore
      ? createWalletSummaryCursor({
          dataset,
          address,
          timeframe,
          mode,
          response_format: effectiveResponseFormat,
          include_tokens: false,
          include_nfts: false,
          limit_per_type,
          window_from_block: requestedFromBlock,
          window_to_block: toBlock,
          sections: {
            transactions: null,
            outputs: outputsHaveMore ? (outputPage.nextBoundary ?? null) : null,
            inputs: inputsHaveMore ? (inputPage.nextBoundary ?? null) : null,
          },
        })
      : undefined
    const totalInSats = outputs.reduce<bigint>((sum, item) => sum + bitcoinValueToSats(item.value), 0n)
    const totalOutSats = inputs.reduce<bigint>((sum, item) => sum + bitcoinValueToSats(item.prevoutValue), 0n)
    const netSats = totalInSats - totalOutSats
    const totalInBtc = formatSatsAsBtc(totalInSats)
    const totalOutBtc = formatSatsAsBtc(totalOutSats)
    const netBtc = formatSatsAsBtc(netSats)
    const bitcoinMovements: WalletFlowMovement[] = rankMovementsWithinAssets(
      [
        ...outputs.map((item) => ({
          direction: 'in' as const,
          asset_type: 'btc' as const,
          asset: 'BTC',
          amount: `${String(item.value || '0')} BTC`,
          amount_decimal: String(item.value || '0'),
          amount_raw: String(item.value_sats || '0'),
          amount_decimals: 8,
          counterparty: typeof item.sender === 'string' ? item.sender : undefined,
          tx_hash: typeof item.tx_hash === 'string' ? item.tx_hash : undefined,
          block_number: getBlockNumber(item),
          timestamp: typeof item.timestamp === 'number' ? item.timestamp : undefined,
          timestamp_human: typeof item.timestamp_human === 'string' ? item.timestamp_human : undefined,
          record_type: 'output',
        })),
        ...inputs.map((item) => ({
          direction: 'out' as const,
          asset_type: 'btc' as const,
          asset: 'BTC',
          amount: `${String(item.prevoutValue || '0')} BTC`,
          amount_decimal: String(item.prevoutValue || '0'),
          amount_raw: String(item.prevout_value_sats || '0'),
          amount_decimals: 8,
          counterparty: typeof item.recipient === 'string' ? item.recipient : undefined,
          tx_hash: typeof item.tx_hash === 'string' ? item.tx_hash : undefined,
          block_number: getBlockNumber(item),
          timestamp: typeof item.timestamp === 'number' ? item.timestamp : undefined,
          timestamp_human: typeof item.timestamp_human === 'string' ? item.timestamp_human : undefined,
          record_type: 'input',
        })),
      ],
      10,
      10,
    )
    const fundFlow = {
      definition: 'Bitcoin asset movement derived from wallet-involved outputs and spent prevouts in the current page.',
      ranking_definition: 'largest_movements ranks exact BTC amounts; every row uses the same BTC asset.',
      summary: {
        inbound_events: outputs.length,
        outbound_events: inputs.length,
        received_btc: totalInBtc,
        spent_btc: totalOutBtc,
        net_btc: netBtc,
        received_sats: totalInSats.toString(),
        spent_sats: totalOutSats.toString(),
        net_sats: netSats.toString(),
        asset_count: 1,
      },
      asset_flows: [
        buildSimpleAssetFlow({
          assetType: 'btc',
          asset: 'BTC',
          inboundCount: outputs.length,
          outboundCount: inputs.length,
          inboundAmount: `${totalInBtc} BTC`,
          outboundAmount: `${totalOutBtc} BTC`,
          netAmount: `${netBtc} BTC`,
          netDirection: netSats > 0n ? 'in' : netSats < 0n ? 'out' : 'flat',
        }),
      ],
      movement_counterparties: [],
      largest_movements: bitcoinMovements.slice(0, 10),
      next_pivots: bitcoinMovements[0]?.tx_hash
        ? [
            {
              goal: 'Inspect the largest Bitcoin movement',
              tool: 'portal_bitcoin_query_transactions',
              tx_hash: bitcoinMovements[0].tx_hash,
            },
          ]
        : [],
    }

    return formatResult(
      applyWalletSummaryResponseFormat(
        {
          overview: {
            network: dataset,
            vm: 'bitcoin',
            address,
            from_block: requestedFromBlock,
            to_block: toBlock,
            analyzed_from_block: fromBlock,
            result_state: bitcoinCompleteness.state,
          },
          completeness: bitcoinCompleteness,
          activity: {
            count: outputs.length + inputs.length,
            items: [...outputs, ...inputs].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)),
            ...(bitcoinHasMore
              ? {
                  items_sampled: true,
                  item_sample_size: outputs.length + inputs.length,
                }
              : {}),
          },
          fund_flow: fundFlow,
          assets: {
            total_btc_received: totalInBtc,
            total_btc_spent: totalOutBtc,
            total_btc_received_sats: totalInSats.toString(),
            total_btc_spent_sats: totalOutSats.toString(),
          },
          bitcoin: {
            outputs_count: outputs.length,
            inputs_count: inputs.length,
            recent_outputs: outputs,
            recent_inputs: inputs,
          },
          tables: [
            buildWalletActivityTable('Wallet activity', outputs.length + inputs.length),
            buildWalletAssetFlowsTable(fundFlow.asset_flows.length),
            buildWalletLargestMovementsTable(fundFlow.largest_movements.length),
            buildBitcoinOutputsTable('Recent outputs', outputs.length),
            buildBitcoinInputsTable('Recent inputs', inputs.length),
          ],
        },
        effectiveResponseFormat,
      ),
      `Wallet flow for ${address} on ${networkLabel}: ${outputs.length} inbound outputs, ${inputs.length} outbound inputs, net ${netBtc} BTC (${netSats.toString()} sats).${nextCursor ? ' This is a preview page; continue with the cursor for older rows.' : ''}`,
      {
        toolName: 'portal_get_wallet_summary',
        notices,
        pagination: {
          type: 'cursor',
          page_size: limit_per_type,
          returned: outputs.length + inputs.length,
          has_more: bitcoinHasMore,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
          sections: {
            outputs: buildSectionPagination(outputs.length, outputsHaveMore),
            inputs: buildSectionPagination(inputs.length, inputsHaveMore),
          },
        },
        freshness: buildQueryFreshness({
          finality: 'latest',
          headBlockNumber: head.number,
          windowToBlock: toBlock,
          resolvedWindow,
        }),
        execution: buildExecutionMetadata({
          mode,
          response_format: effectiveResponseFormat,
          result_scope: fromBlock > requestedFromBlock ? 'partial_window' : 'complete_window',
          requested_blocks: Math.max(0, toBlock - requestedFromBlock + 1),
          analyzed_blocks: Math.max(0, toBlock - fromBlock + 1),
          estimated_scan_blocks: Math.max(0, toBlock - fromBlock + 1),
          estimated_runtime_class:
            toBlock - fromBlock + 1 <= 250
              ? 'interactive'
              : toBlock - fromBlock + 1 <= 2_000
                ? 'long_window'
                : 'expensive',
          recommended_window: 'Use timeframe="24h" or a cursor continuation for bounded Bitcoin triage.',
          from_block: fromBlock,
          to_block: toBlock,
          range_kind: resolvedWindow.range_kind,
          normalized_output: true,
        }),
        pipes: pipesRecipe,
        ui: buildWalletUi({
          title: address,
          subtitle: `${describeWalletWindow(timeframe)} on ${networkLabel}`,
          activityCountPath: 'activity.count',
          primaryValuePath: 'assets.total_btc_received',
          primaryLabel: 'BTC received',
          primaryFormat: 'btc',
          primaryUnit: 'BTC',
          secondaryCards: [
            buildMetricCard({
              id: 'btc-spent',
              label: 'BTC spent',
              value_path: 'assets.total_btc_spent',
              format: 'btc',
              unit: 'BTC',
            }),
            buildMetricCard({
              id: 'outputs',
              label: 'Outputs',
              value_path: 'bitcoin.outputs_count',
              format: 'integer',
            }),
            buildMetricCard({ id: 'inputs', label: 'Inputs', value_path: 'bitcoin.inputs_count', format: 'integer' }),
          ],
          panels: [
            buildTimelinePanel({
              id: 'wallet-timeline',
              kind: 'timeline_panel',
              title: 'Activity timeline',
              subtitle: 'Chronological Bitcoin activity for this wallet.',
              data_key: 'activity.items',
              timestamp_key: 'timestamp_human',
              title_key: 'primary_id',
              subtitle_keys: ['record_type', 'tx_hash'],
              badge_key: 'record_type',
              emphasis: 'primary',
            }),
            buildTablePanel({
              id: 'wallet-table',
              kind: 'table_panel',
              title: 'Wallet activity',
              subtitle: 'Normalized inputs and outputs for this wallet window.',
              table_id: 'activity',
            }),
            buildTablePanel({
              id: 'wallet-outputs',
              kind: 'table_panel',
              title: 'Recent outputs',
              subtitle: 'Most recent outputs sent to the wallet.',
              table_id: 'bitcoin_outputs',
            }),
            buildTablePanel({
              id: 'wallet-inputs',
              kind: 'table_panel',
              title: 'Recent inputs',
              subtitle: 'Most recent inputs spent by the wallet.',
              table_id: 'bitcoin_inputs',
            }),
          ],
          followUpActions: [
            ...(nextCursor
              ? [
                  {
                    label: 'Load older wallet activity',
                    intent: 'continue' as const,
                    target: '_pagination.next_cursor',
                  },
                ]
              : []),
            { label: 'Show raw activity rows', intent: 'show_raw', target: 'activity.items' },
          ],
        }),
        llm: buildWalletLlmOverrides('bitcoin'),
        coverage: buildSectionCoverage({
          windowFromBlock: requestedFromBlock,
          windowToBlock: toBlock,
          hasMore: bitcoinHasMore,
          windowComplete: bitcoinWindowComplete,
          sections: {
            activity: buildSectionPagination(outputs.length + inputs.length, bitcoinHasMore),
          },
        }),
        metadata: {
          network: dataset,
          dataset,
          from_block: fromBlock,
          to_block: toBlock,
          query_start_time: queryStartTime,
        },
      },
    )
  }

  const fillCursor = paginationCursor?.sections.fills ?? undefined
  const fillBlocks = await portalFetchRecentRecords(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    {
      type: 'hyperliquidFills',
      fromBlock,
      toBlock: fillCursor?.page_to_block ?? toBlock,
      fields: {
        block: { number: true, timestamp: true },
        fill: {
          fillIndex: true,
          user: true,
          coin: true,
          px: true,
          sz: true,
          fee: true,
          feeToken: true,
          dir: true,
          side: true,
          hash: true,
          time: true,
        },
      },
      fills: [{ user: [address.toLowerCase()] }],
    },
    {
      itemKeys: ['fills'],
      limit: limit_per_type + (fillCursor?.skip_inclusive_block ?? 0) + 1,
      chunkSize: Math.max(500, Math.min(2_000, limit_per_type * 200)),
      maxBytes: 25 * 1024 * 1024,
      timeout: WALLET_QUERY_TIMEOUT_MS,
      retries: WALLET_QUERY_RETRIES,
    },
  )

  const allFills = fillBlocks
    .flatMap((block: any) =>
      (block.fills || []).map((fill: any) => {
        const timestamp = block.timestamp ?? block.header?.timestamp
        return normalizeHyperliquidFillResult({
          ...(typeof fill.fillIndex === 'number' || typeof fill.fillIndex === 'string'
            ? { fillIndex: fill.fillIndex }
            : {}),
          ...(typeof fill.user === 'string' ? { user: fill.user } : {}),
          ...(typeof fill.coin === 'string' ? { coin: fill.coin } : {}),
          ...(typeof fill.px === 'number' || typeof fill.px === 'string' ? { px: fill.px } : {}),
          ...(typeof fill.sz === 'number' || typeof fill.sz === 'string' ? { sz: fill.sz } : {}),
          ...(typeof fill.fee === 'number' || typeof fill.fee === 'string' ? { fee: fill.fee } : {}),
          ...(typeof fill.feeToken === 'string' ? { feeToken: fill.feeToken } : {}),
          ...(typeof fill.dir === 'string' ? { dir: fill.dir } : {}),
          ...(typeof fill.side === 'string' ? { side: fill.side } : {}),
          ...(typeof fill.hash === 'string' ? { hash: fill.hash } : {}),
          ...(typeof fill.time === 'number' || typeof fill.time === 'string' ? { time: fill.time } : {}),
          block_number: block.number ?? block.header?.number,
          ...(timestamp !== undefined ? { block_timestamp: timestamp } : {}),
          ...(timestamp !== undefined ? { timestamp_human: formatTimestamp(timestamp) } : {}),
        })
      }),
    )
    .sort(
      (left: any, right: any) =>
        Number(left.block_number || 0) - Number(right.block_number || 0) ||
        Number(left.fillIndex || 0) - Number(right.fillIndex || 0) ||
        String(left.primary_id || '').localeCompare(String(right.primary_id || '')),
    )
  const fillPage = paginateAscendingItems(allFills, limit_per_type, getBlockNumber, fillCursor)
  const fills = fillPage.pageItems
  const hasMore = fillPage.hasMore
  const hyperliquidWindowComplete = fromBlock <= requestedFromBlock
  const hyperliquidCompleteness = buildWalletCompleteness({
    hasMore,
    windowComplete: hyperliquidWindowComplete,
  })
  const nextCursor = hasMore
    ? createWalletSummaryCursor({
        dataset,
        address,
        timeframe,
        mode,
        response_format: effectiveResponseFormat,
        include_tokens: false,
        include_nfts: false,
        limit_per_type,
        window_from_block: requestedFromBlock,
        window_to_block: toBlock,
        sections: {
          transactions: null,
          fills: fillPage.nextBoundary ?? null,
        },
      })
    : undefined
  if (nextCursor) {
    notices.push('Older Hyperliquid fills are available via _pagination.next_cursor.')
  }
  const byCoin = new Map<string, ExactDecimal>()
  const feeTotals = createHyperliquidFeeAccumulator()
  fills.forEach((fill: any) => {
    const coin = String(fill.coin || 'UNKNOWN')
    const price = parseExactDecimal(fill.px)
    const size = parseExactDecimal(fill.sz)
    if (price && size) {
      byCoin.set(coin, addExactDecimals(byCoin.get(coin) ?? EXACT_DECIMAL_ZERO, multiplyExactDecimals(price, size)))
    }
    accumulateHyperliquidFee(feeTotals, fill)
  })
  const feeSummary = summarizeHyperliquidFees(feeTotals)
  const totalFees = feeSummary.fees_status === 'available' ? feeSummary.fees_by_token[0].total_fees : null
  if (feeSummary.fee_notice) notices.push(feeSummary.fee_notice)
  const sideBreakdown = fills.reduce((acc: Record<string, number>, fill: any) => {
    const side = String(fill.side || 'unknown')
    acc[side] = (acc[side] || 0) + 1
    return acc
  }, {})
  const coinFlows = Array.from(byCoin.entries())
    .sort((left, right) => compareExactDecimals(right[1], left[1]))
    .map(([coin, volume]) =>
      buildSimpleAssetFlow({
        assetType: 'hyperliquid_coin',
        asset: coin,
        inboundCount: 0,
        outboundCount: 0,
        inboundAmount: `$0`,
        outboundAmount: `$0`,
        netAmount: `$${formatExactDecimal(volume)} traded`,
        netDirection: 'flat',
      }),
    )
  const fillMovements = fills.map((fill: any) => {
    const price = parseExactDecimal(fill.px)
    const size = parseExactDecimal(fill.sz)
    const volume = price && size ? multiplyExactDecimals(price, size) : EXACT_DECIMAL_ZERO
    const volumeExact = formatExactDecimal(volume)
    return {
      direction: String(fill.side || '')
        .toLowerCase()
        .includes('sell')
        ? ('out' as const)
        : ('in' as const),
      asset_type: 'hyperliquid_coin' as const,
      asset: String(fill.coin || 'UNKNOWN'),
      amount: `$${volumeExact}`,
      amount_decimal: volumeExact,
      tx_hash: typeof fill.hash === 'string' ? fill.hash : undefined,
      block_number: getBlockNumber(fill),
      timestamp: typeof fill.timestamp === 'number' ? fill.timestamp : undefined,
      timestamp_human: typeof fill.timestamp_human === 'string' ? fill.timestamp_human : undefined,
      record_type: 'fill',
    }
  })
  const largestFills = rankMovementsWithinAssets(fillMovements)
  const totalTradedVolume = Array.from(byCoin.values()).reduce(
    (sum, value) => addExactDecimals(sum, value),
    EXACT_DECIMAL_ZERO,
  )
  const fundFlow = {
    definition:
      'Hyperliquid trading activity only. Amounts are exact price-times-size notional values for fills in the current page.',
    ranking_definition: 'largest_movements contains up to three largest USD-notional fills per coin.',
    summary: {
      fill_events: fills.length,
      traded_volume_usd: formatExactDecimal(totalTradedVolume),
      total_fees: totalFees,
      ...feeSummary,
      coins_touched: byCoin.size,
      side_breakdown: sideBreakdown,
    },
    asset_flows: coinFlows,
    movement_counterparties: [],
    largest_movements: largestFills.slice(0, 10),
    next_pivots: largestFills[0]?.tx_hash
      ? [
          {
            goal: 'Inspect the largest Hyperliquid fill hash',
            tool: 'portal_hyperliquid_query_fills',
            hash: largestFills[0].tx_hash,
          },
        ]
      : [],
  }

  return formatResult(
    applyWalletSummaryResponseFormat(
      {
        overview: {
          network: dataset,
          vm: 'hyperliquid',
          address,
          from_block: requestedFromBlock,
          to_block: toBlock,
          analyzed_from_block: fromBlock,
          result_state: hyperliquidCompleteness.state,
        },
        completeness: hyperliquidCompleteness,
        activity: {
          count: fills.length,
          items: fills,
        },
        fund_flow: fundFlow,
        assets: {
          traded_coin_count: byCoin.size,
          volume_by_coin: Array.from(byCoin.entries())
            .sort((left, right) => compareExactDecimals(right[1], left[1]))
            .map(([coin, volume]) => ({ coin, volume_usd: formatExactDecimal(volume) })),
        },
        hyperliquid: {
          fee_summary: {
            total_fees: totalFees,
            ...feeSummary,
          },
          side_breakdown: sideBreakdown,
        },
        tables: [
          buildWalletActivityTable('Wallet activity', fills.length),
          buildWalletAssetFlowsTable(fundFlow.asset_flows.length),
          buildWalletLargestMovementsTable(fundFlow.largest_movements.length),
          buildTableDescriptor({
            id: 'volume_by_coin',
            dataKey: 'assets.volume_by_coin',
            rowCount: byCoin.size,
            title: 'Volume by coin',
            subtitle: 'Coin-level notional volume for this wallet in the selected window',
            keyField: 'coin',
            defaultSort: { key: 'volume_usd', direction: 'desc' },
            dense: true,
            columns: [
              { key: 'coin', label: 'Coin', kind: 'dimension' },
              {
                key: 'volume_usd',
                label: 'Volume',
                kind: 'metric',
                format: 'currency_usd',
                unit: 'USD',
                align: 'right',
              },
            ],
          }),
        ],
      },
      effectiveResponseFormat,
    ),
    `Wallet flow for ${address} on ${networkLabel}: ${fills.length} recent fills across ${byCoin.size} coins, $${fundFlow.summary.traded_volume_usd} observed notional volume.${nextCursor ? ' This is a preview page; continue with the cursor for older rows.' : ''}`,
    {
      toolName: 'portal_get_wallet_summary',
      notices,
      pagination: {
        type: 'cursor',
        page_size: limit_per_type,
        returned: fills.length,
        has_more: hasMore,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
        sections: {
          fills: buildSectionPagination(fills.length, hasMore),
        },
      },
      freshness: buildQueryFreshness({
        finality: 'latest',
        headBlockNumber: head.number,
        windowToBlock: toBlock,
        resolvedWindow,
      }),
      execution: buildExecutionMetadata({
        mode,
        response_format: effectiveResponseFormat,
        result_scope: hasMore ? 'preview_page' : fromBlock > requestedFromBlock ? 'partial_window' : 'complete_window',
        requested_blocks: Math.max(0, toBlock - requestedFromBlock + 1),
        analyzed_blocks: Math.max(0, toBlock - fromBlock + 1),
        estimated_scan_blocks: Math.max(0, toBlock - fromBlock + 1),
        estimated_runtime_class:
          toBlock - fromBlock + 1 <= 2_000
            ? 'interactive'
            : toBlock - fromBlock + 1 <= 500_000
              ? 'long_window'
              : 'expensive',
        recommended_window: 'Use timeframe="1h" for a smaller Hyperliquid trader triage window.',
        from_block: fromBlock,
        to_block: toBlock,
        range_kind: resolvedWindow.range_kind,
        normalized_output: true,
      }),
      pipes: pipesRecipe,
      ui: buildWalletUi({
        title: address,
        subtitle: `${describeWalletWindow(timeframe)} on ${networkLabel}`,
        activityCountPath: 'activity.count',
        primaryValuePath: 'hyperliquid.fee_summary.total_fees_usd',
        primaryLabel: 'Net fees (USD)',
        primaryFormat: 'currency_usd',
        secondaryCards: [
          buildMetricCard({
            id: 'coins',
            label: 'Coins traded',
            value_path: 'assets.traded_coin_count',
            format: 'integer',
          }),
        ],
        panels: [
          buildTimelinePanel({
            id: 'wallet-timeline',
            kind: 'timeline_panel',
            title: 'Fill timeline',
            subtitle: 'Chronological fill activity with trader and coin context.',
            data_key: 'activity.items',
            timestamp_key: 'timestamp_human',
            title_key: 'primary_id',
            subtitle_keys: ['record_type', 'sender', 'coin'],
            badge_key: 'record_type',
            emphasis: 'primary',
          }),
          buildTablePanel({
            id: 'wallet-table',
            kind: 'table_panel',
            title: 'Fill activity table',
            subtitle: 'Exact normalized fill rows.',
            table_id: 'activity',
          }),
          buildStatListPanel({
            id: 'coin-volume',
            kind: 'stat_list_panel',
            title: 'Volume by coin',
            subtitle: 'Top coin exposure in the selected wallet window.',
            data_key: 'assets.volume_by_coin',
            label_key: 'coin',
            value_key: 'volume_usd',
            value_format: 'currency_usd',
            unit: 'USD',
          }),
        ],
        followUpActions: [
          ...(nextCursor
            ? [{ label: 'Load older wallet activity', intent: 'continue' as const, target: '_pagination.next_cursor' }]
            : []),
          { label: 'Show raw activity rows', intent: 'show_raw', target: 'activity.items' },
        ],
      }),
      llm: buildWalletLlmOverrides('hyperliquid'),
      coverage: buildSectionCoverage({
        windowFromBlock: requestedFromBlock,
        windowToBlock: toBlock,
        hasMore,
        windowComplete: hyperliquidWindowComplete,
        sections: {
          activity: buildSectionPagination(fills.length, hasMore),
        },
      }),
      metadata: {
        network: dataset,
        dataset,
        from_block: fromBlock,
        to_block: toBlock,
        query_start_time: queryStartTime,
      },
    },
  )
}
