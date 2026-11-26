// ============================================================================
// Result Formatting
// ============================================================================

import { Buffer } from 'node:buffer'

import {
  ACTIVITY_EXPLORER_RESOURCE_URI,
  ACTIVITY_EXPLORER_TOOLS,
  isActivityExplorerEnabled,
} from '../apps/activity-explorer.js'
import { gitCommit, npmVersion } from '../version.js'
import { ActionableError } from './errors.js'
import { formatIntegerUnitsExact } from './exact-decimal.js'
import type { LlmOverrides } from './llm-hints.js'
import { buildLlmHints } from './llm-hints.js'
import type { PipesRecipe } from './pipes-recipe.js'
import { getToolContract } from './tool-ux.js'
import type { UiFollowUpAction } from './ui-metadata.js'
import { UNTRUSTED_FIELDS, cleanProseFields, untrustedLabel } from './untrusted-text.js'

const MAX_RESPONSE_BYTES = 50_000

export interface FormatOptions {
  maxItems?: number
  warnOnTruncation?: boolean
  notices?: string[]
  pagination?: Record<string, unknown>
  ordering?: unknown
  freshness?: unknown
  coverage?: unknown
  toolName?: string
  execution?: Record<string, unknown>
  ui?: unknown
  llm?: LlmOverrides
  pipes?: PipesRecipe
  metadata?: {
    network?: string
    dataset?: string
    from_block?: number
    to_block?: number
    query_start_time?: number
  }
}

export interface ResponseMetadata {
  network?: string
  dataset?: string
  queried_blocks?: string
  response_time_ms?: number
  returned?: number
  has_more?: boolean
}

type RecordLike = Record<string, unknown>
type FormattedTextContent = { type: 'text'; text: string }

export interface FormattedToolResult {
  [key: string]: unknown
  content: FormattedTextContent[]
  structuredContent?: Record<string, unknown>
}

type FollowUpActionEnvelope = {
  label: string
  intent?: UiFollowUpAction['intent'] | string
  target?: string
  executable: boolean
  tool?: string
  arguments?: Record<string, unknown>
  cursor_path?: string
}

const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  'base-mainnet': 'Base',
  'ethereum-mainnet': 'Ethereum',
  'optimism-mainnet': 'Optimism',
  'arbitrum-one': 'Arbitrum',
  'solana-mainnet': 'Solana',
  'bitcoin-mainnet': 'Bitcoin',
  'hyperliquid-fills': 'Hyperliquid',
  'hyperliquid-replica-cmds': 'Hyperliquid Replica Commands',
  portal_list_networks: 'Find Networks',
  portal_get_network_info: 'Network Info',
  portal_get_head: 'Network Head',
  portal_resolve_entity: 'Entity Resolver',
  portal_get_recent_activity: 'Recent Activity',
  portal_get_wallet_summary: 'Wallet Summary',
  portal_get_time_series: 'Time Series',
  portal_evm_query_transactions: 'EVM Transactions',
  portal_evm_query_logs: 'EVM Logs',
  portal_evm_query_traces: 'EVM Traces',
  portal_evm_query_token_transfers: 'Token Transfers',
  portal_evm_get_contract_deployment: 'Contract Deployment',
  portal_evm_get_contract_activity: 'Contract Activity',
  portal_evm_get_analytics: 'EVM Analytics',
  portal_evm_get_ohlc: 'EVM OHLC',
  portal_solana_query_transactions: 'Solana Transactions',
  portal_solana_query_instructions: 'Solana Instructions',
  portal_solana_get_analytics: 'Solana Analytics',
  portal_bitcoin_query_transactions: 'Bitcoin Transactions',
  portal_bitcoin_get_analytics: 'Bitcoin Analytics',
  portal_substrate_query_events: 'Substrate Events',
  portal_substrate_query_calls: 'Substrate Calls',
  portal_substrate_get_analytics: 'Substrate Analytics',
  portal_hyperliquid_query_fills: 'Hyperliquid Fills',
  portal_hyperliquid_get_analytics: 'Hyperliquid Analytics',
  portal_hyperliquid_get_ohlc: 'Hyperliquid OHLC',
  portal_debug_query_blocks: 'Block Lookup',
  portal_debug_resolve_time_to_block: 'Timestamp Lookup',
  portal_debug_hyperliquid_query_replica_commands: 'Hyperliquid Commands',
  uniswap_v2_swap: 'Uniswap v2 swap',
  uniswap_v3_swap: 'Uniswap v3 swap',
  uniswap_v4_swap: 'Uniswap v4 swap',
  aerodrome_slipstream_swap: 'Aerodrome Slipstream swap',
  uniswap_v2_sync: 'Uniswap v2 Sync',
  transaction_count: 'Transaction count',
  unique_addresses: 'Unique addresses',
  avg_gas_price: 'Average gas price',
  gas_used: 'Gas used',
  block_utilization: 'Block utilization',
  transactions_per_block: 'Transactions per block',
  block_size_bytes: 'Block size',
  fees_btc: 'Fees',
  fill_count: 'Fill count',
  token0: 'Token 0',
  token1: 'Token 1',
  evm: 'EVM',
  ohlc: 'OHLC',
  btc: 'BTC',
  eth: 'ETH',
  usd: 'USD',
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertUniqueNormalizedIds(value: unknown, path = '$', visited = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null) return
  if (visited.has(value)) return
  visited.add(value)

  if (Array.isArray(value)) {
    const normalizedRows = value.filter(
      (entry): entry is RecordLike =>
        isRecord(entry) && typeof entry.chain_kind === 'string' && typeof entry.record_type === 'string',
    )
    if (normalizedRows.length > 0) {
      const ids = new Set<string>()
      for (const [index, row] of normalizedRows.entries()) {
        const id = typeof row.primary_id === 'string' ? row.primary_id.trim() : ''
        if (!id) {
          throw new ActionableError(
            `Normalized evidence at ${path}[${index}] has no stable primary_id.`,
            ['Retry after the server identity contract is repaired.'],
            { path, index },
            { code: 'incomplete_result', origin: 'server', retryable: false },
          )
        }
        if (ids.has(id)) {
          throw new ActionableError(
            `Normalized evidence at ${path} contains duplicate primary_id ${id}.`,
            ['Retry after the server identity contract is repaired.'],
            { path, primary_id: id },
            { code: 'incomplete_result', origin: 'server', retryable: false },
          )
        }
        ids.add(id)
      }
    }

    value.forEach((entry, index) => assertUniqueNormalizedIds(entry, `${path}[${index}]`, visited))
    return
  }

  for (const [key, entry] of Object.entries(value)) {
    assertUniqueNormalizedIds(entry, `${path}.${key}`, visited)
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function getByPath(value: unknown, path?: string): unknown {
  if (!path) return value

  const tokens = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((token) => token.trim())
    .filter(Boolean)

  let current: unknown = value
  for (const token of tokens) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[token]
  }

  return current
}

function isSafeExecutableArgumentValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return !/\bhttps?:\/\//i.test(value)
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isSafeExecutableArgumentValue(entry))
  }

  if (isRecord(value)) {
    return Object.entries(value).every(([key, entry]) => {
      if (/secret|token|api[_-]?key|authorization|password|cookie|url/i.test(key)) {
        return false
      }
      return isSafeExecutableArgumentValue(entry)
    })
  }

  return true
}

function getSafeExecutableArguments(value: unknown): RecordLike | undefined {
  if (!isRecord(value)) return undefined
  try {
    if (JSON.stringify(value).length > 8_000) return undefined
  } catch {
    return undefined
  }
  if (!isSafeExecutableArgumentValue(value)) return undefined
  return value
}

function isSafeCursorValue(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value.length <= 20_000
}

function decodeCursorTool(cursor: string): string | undefined {
  if (!isSafeCursorValue(cursor)) return undefined
  const [payload] = cursor.split('.')
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return undefined

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    return isRecord(decoded) && typeof decoded.tool === 'string' ? decoded.tool : undefined
  } catch {
    return undefined
  }
}

function buildExecutableContinuationAction(
  pagination: RecordLike | undefined,
  toolName: string | undefined,
): FollowUpActionEnvelope | undefined {
  const nextCursor = typeof pagination?.next_cursor === 'string' ? pagination.next_cursor : undefined
  if (!nextCursor || !toolName) return undefined

  const cursorTool = decodeCursorTool(nextCursor)
  if (cursorTool !== toolName) return undefined

  return {
    label: pagination?.continuation_scope === 'adjacent_window' ? 'Load previous window' : 'Load more results',
    intent: 'continue',
    target: '_pagination.next_cursor',
    executable: true,
    tool: toolName,
    arguments: { cursor: nextCursor },
    cursor_path: '_pagination.next_cursor',
  }
}

function isPaginationContinueAction(action: FollowUpActionEnvelope): boolean {
  return (
    action.intent === 'continue' &&
    (action.target === '_pagination.next_cursor' || action.cursor_path === '_pagination.next_cursor')
  )
}

function normalizeFollowUpAction(action: RecordLike): FollowUpActionEnvelope {
  const safeArguments = getSafeExecutableArguments(action.arguments)
  const executable = action.executable === true && typeof action.tool === 'string' && safeArguments !== undefined

  return {
    label: typeof action.label === 'string' && action.label.trim() ? action.label : 'Continue',
    ...(typeof action.intent === 'string' ? { intent: action.intent } : {}),
    ...(typeof action.target === 'string' ? { target: action.target } : {}),
    executable,
    ...(executable ? { tool: action.tool as string, arguments: safeArguments } : {}),
    ...(typeof action.cursor_path === 'string' ? { cursor_path: action.cursor_path } : {}),
  }
}

function withContinuationExecutableMetadata(
  action: FollowUpActionEnvelope,
  executableAction: FollowUpActionEnvelope | undefined,
): FollowUpActionEnvelope {
  if (!isPaginationContinueAction(action)) {
    return action
  }

  return {
    ...action,
    target: action.target ?? '_pagination.next_cursor',
    cursor_path: action.cursor_path ?? '_pagination.next_cursor',
    executable: executableAction?.executable === true,
    ...(executableAction?.executable === true && executableAction.tool ? { tool: executableAction.tool } : {}),
    ...(executableAction?.executable === true && executableAction.arguments
      ? { arguments: executableAction.arguments }
      : {}),
  }
}

function capitalizeWord(word: string): string {
  const lower = word.toLowerCase()
  if (DISPLAY_NAME_OVERRIDES[lower]) return DISPLAY_NAME_OVERRIDES[lower]
  if (
    ['api', 'btc', 'dex', 'eth', 'evm', 'ohlc', 'rpc', 'sol', 'sql', 'ui', 'usd', 'usdc', 'usdt', 'vm'].includes(lower)
  ) {
    return lower.toUpperCase()
  }
  if (/^[0-9]+[mhdw]$/.test(lower)) return lower
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function collectPayloadNotices(payload: RecordLike): string[] {
  return [
    ...asArray<string>(payload._notices),
    ...(typeof payload._notice === 'string' ? [payload._notice] : []),
  ].filter((notice) => notice.trim().length > 0)
}

function makeCompletenessAwareAnswer(answer: string, payload: RecordLike): string {
  const coverage = isRecord(payload._coverage) ? payload._coverage : undefined
  if (coverage?.window_complete !== false && coverage?.result_complete !== false) {
    return answer
  }

  const continuable = coverage?.continuation === 'cursor'
  const notice = collectPayloadNotices(payload).find((item) =>
    /\b(partial|incomplete|coverage|analyzed\b.*\brequested|sample|truncated|shortened|searched only)\b/i.test(item),
  )
  const suffixes: string[] = []
  /* An unread window is disclosed whether or not a cursor exists. Suppressing
     it on a page that had one left six tools reporting window_complete: false
     with an answer that never said so, which is the whole point of the field. */
  if (coverage?.window_complete === false) {
    if (!/\b(partial|incomplete|coverage|analyzed\b.*\brequested|only\b.*\brequested|searched only)\b/i.test(answer)) {
      suffixes.push(`Partial window: ${notice ?? 'coverage metadata marks this window as partially analyzed.'}`)
    }
  }

  if (coverage?.result_complete === false) {
    if (
      !/\b(preview|cursor|continue|more matching|older results|newer results|limited to|showing the best|bounded search)\b/i.test(
        answer,
      )
    ) {
      /* A result can be incomplete with nothing to continue from: a ranked list
         cut to `limit` has no cursor, and telling the caller to use one sends
         them after a field that is not in the response. A window that stopped
         short is a different problem, and a bigger limit would not read it. */
      suffixes.push(
        continuable
          ? 'Preview page: continue with the cursor for remaining rows.'
          : coverage?.window_complete === false
            ? 'Preview page: narrow the query or raise max_scan_blocks for the remaining rows.'
            : 'Preview page: raise the limit or narrow the query for the remaining rows.',
      )
    }
  }

  return suffixes.length > 0 ? `${answer} ${suffixes.join(' ')}` : answer
}

function freshnessProvesExactWindow(freshness: unknown): boolean {
  if (!isRecord(freshness)) return true
  if (freshness.kind === 'timestamp_lookup') return freshness.resolution !== 'estimated'
  if (freshness.estimated_timeframe !== undefined) return false
  const timestampBounds = freshness.timestamp_bounds
  if (!isRecord(timestampBounds)) return true

  return ['from', 'to'].every((key) => {
    const boundary = timestampBounds[key]
    return !isRecord(boundary) || boundary.resolution !== 'estimated'
  })
}

function reconcileCoverageWithFreshness(coverage: unknown, freshness: unknown): unknown {
  if (!isRecord(coverage) || freshnessProvesExactWindow(freshness)) return coverage
  return {
    ...coverage,
    window_complete: false,
  }
}

/*
 * _pagination is the only party that knows whether a cursor exists, and
 * _coverage.continuation is a claim about that cursor. Each tool used to make
 * the claim on its own, and three of them said 'cursor' on pages that carried
 * none, so a client following the contract stopped at a field that was not
 * there. The claim is derived here from the cursor itself: a remaining-rows
 * cursor makes the result incomplete and continuable, no cursor makes the
 * continuation 'none'. A cursor into an adjacent window is not a continuation
 * of this one and leaves the window's own completeness alone.
 */
function reconcileCoverageWithPagination(coverage: unknown, pagination: unknown): unknown {
  if (!isRecord(coverage)) return coverage
  if (typeof coverage.continuation !== 'string' && typeof coverage.result_complete !== 'boolean') return coverage
  const paginationRecord = isRecord(pagination) ? pagination : undefined
  const hasCursor = typeof paginationRecord?.next_cursor === 'string' && paginationRecord.next_cursor.length > 0
  const remainingCursor = hasCursor && paginationRecord?.continuation_scope !== 'adjacent_window'
  const resultComplete = remainingCursor ? false : coverage.result_complete !== false
  return {
    ...coverage,
    result_complete: resultComplete,
    continuation: !resultComplete && remainingCursor ? 'cursor' : 'none',
  }
}

/*
 * The gap diagnostics answer "did observed data cover these buckets", and
 * _coverage answers "can we prove this is the window that was asked for". Both
 * called the answer `window_complete`, and only _coverage was reconciled
 * against an estimated boundary, so one Bitcoin fee series carried
 * `_coverage.window_complete: false` beside `gap_diagnostics.window_complete:
 * true`. A reader cannot be expected to know which one is answering which
 * question, so a downgrade on one applies to the other.
 */
function reconcileGapDiagnosticsWithFreshness(diagnostics: unknown, freshness: unknown): unknown {
  if (!isRecord(diagnostics) || diagnostics.window_complete !== true || freshnessProvesExactWindow(freshness)) {
    return diagnostics
  }
  return { ...diagnostics, window_complete: false }
}

export function humanizeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const lower = trimmed.toLowerCase()
  if (DISPLAY_NAME_OVERRIDES[lower]) return DISPLAY_NAME_OVERRIDES[lower]
  if (/^0x[0-9a-f]{40,64}$/i.test(trimmed)) return trimmed

  const normalized = trimmed
    .replace(/[-_]+/g, ' ')
    .replace(/\bmainnet\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return trimmed
  return normalized
    .split(' ')
    .map((word) => capitalizeWord(word))
    .join(' ')
}

/**
 * Convert hex string to decimal number.
 */
export function hexToNumber(hex: string): number {
  if (!hex || hex === '0x' || hex === '0x0') return 0
  return parseInt(hex, 16)
}

/**
 * Convert hex string to bigint for values that can exceed Number.MAX_SAFE_INTEGER.
 */
export function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x' || hex === '0x0') return 0n
  return BigInt(hex)
}

/**
 * Convert hex string to decimal string.
 */
export function hexToDecimal(hex: string): string {
  if (!hex || hex === '0x' || hex === '0x0') {
    return '0'
  }

  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
  try {
    return BigInt('0x' + cleanHex).toString()
  } catch {
    return '0'
  }
}

/**
 * Convert wei (hex or bigint) to ETH with specified decimals.
 */
export function weiToEth(wei: string | bigint, decimals: number = 18): string {
  const weiValue = typeof wei === 'bigint' ? wei : /^-?\d+$/.test(wei.trim()) ? BigInt(wei.trim()) : hexToBigInt(wei)
  return formatIntegerUnitsExact(weiValue, decimals)
}

/**
 * Convert wei to Gwei for gas prices.
 */
export function weiToGwei(wei: string | bigint): string {
  const weiValue = typeof wei === 'bigint' ? wei : /^-?\d+$/.test(wei.trim()) ? BigInt(wei.trim()) : hexToBigInt(wei)
  return formatIntegerUnitsExact(weiValue, 9)
}

export function formatTokenAmount(value: string, decimals: number = 18, symbol?: string): string {
  const formatted = weiToEth(value, decimals)
  const label = untrustedLabel(symbol)
  return label ? `${formatted} ${label}` : formatted
}

export function formatTokenValue(
  hexValue: string,
  decimals: number = 18,
  symbol?: string,
): {
  raw: string
  decimal: string
  formatted: string
} {
  const decimal = hexToDecimal(hexValue)
  const bigIntValue = BigInt(decimal)
  let formatted = formatIntegerUnitsExact(bigIntValue, decimals)

  const label = untrustedLabel(symbol)
  if (label) formatted += ` ${label}`

  return {
    raw: hexValue,
    decimal,
    formatted,
  }
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return date.toISOString().replace('T', ' ').split('.')[0] + ' UTC'
}

export function normalizeUnixTimestamp(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined

  if (numeric === undefined || !Number.isFinite(numeric) || numeric <= 0) {
    return undefined
  }

  return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric)
}

export function formatTimestampRelative(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp

  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return formatTimestamp(timestamp)
}

export function formatGas(gasHex: string): {
  raw: string
  decimal: number
  formatted: string
} {
  const decimal = hexToNumber(gasHex)
  return {
    raw: gasHex,
    decimal,
    formatted: decimal.toLocaleString('en-US'),
  }
}

export function formatGasPrice(gasPriceHex: string): {
  raw: string
  gwei: string
  formatted: string
} {
  const gwei = weiToGwei(gasPriceHex)
  return {
    raw: gasPriceHex,
    gwei,
    formatted: `${gwei} Gwei`,
  }
}

export function formatGasAmount(hexValue: string): {
  raw: string
  decimal: string
  formatted_eth: string
  formatted_gwei: string
} {
  const decimal = hexToDecimal(hexValue)
  const bigIntValue = BigInt(decimal)
  const ethValue = Number(bigIntValue) / Number(BigInt(10) ** BigInt(18))
  const gweiValue = Number(bigIntValue) / Number(BigInt(10) ** BigInt(9))

  return {
    raw: hexValue,
    decimal,
    formatted_eth: `${ethValue.toFixed(6)} ETH`,
    formatted_gwei: `${gweiValue.toFixed(2)} Gwei`,
  }
}

export function formatValue(valueHex: string): {
  raw: string
  eth: string
  formatted: string
} {
  const eth = weiToEth(valueHex)
  return {
    raw: valueHex,
    eth,
    formatted: `${eth} ETH`,
  }
}

function isHexValue(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) && value.length > 4
}

function isAnyHexValue(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}

export function formatTransactionFields(tx: Record<string, unknown>): Record<string, unknown> {
  const result = { ...tx }

  if (isAnyHexValue(result.value)) {
    const ethValue = weiToEth(result.value as string)
    result.value_eth = ethValue
    delete result.value
  }

  for (const field of ['gasPrice', 'effectiveGasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    if (isHexValue(result[field])) {
      result[`${field}_gwei`] = weiToGwei(result[field] as string)
      delete result[field]
    }
  }

  for (const field of ['gas', 'gasUsed', 'cumulativeGasUsed']) {
    if (isHexValue(result[field])) {
      result[field] = hexToNumber(result[field] as string)
    }
  }

  for (const field of ['nonce', 'transactionIndex', 'type', 'status']) {
    if (isHexValue(result[field])) {
      result[field] = hexToNumber(result[field] as string)
    }
  }

  if (isHexValue(result.l1Fee)) {
    result.l1Fee_eth = weiToEth(result.l1Fee as string)
    delete result.l1Fee
  }
  if (isHexValue(result.l1GasUsed)) {
    result.l1GasUsed = hexToNumber(result.l1GasUsed as string)
  }
  if (isHexValue(result.l1GasPrice)) {
    result.l1GasPrice_gwei = weiToGwei(result.l1GasPrice as string)
    delete result.l1GasPrice
  }

  for (const field of ['v', 'r', 's', 'yParity', 'logsBloom']) {
    delete result[field]
  }

  return result
}

export function addValueConversions<T extends Record<string, unknown>>(
  obj: T,
  options: {
    tokenDecimals?: number
    tokenSymbol?: string
  } = {},
): T & {
  value_decimal?: string
  value_formatted?: string
  gas_decimal?: string
  gas_formatted?: string
} {
  const result = { ...obj }

  if (typeof obj.value === 'string' && obj.value.startsWith('0x')) {
    const converted = formatTokenValue(obj.value, options.tokenDecimals, options.tokenSymbol)
    return {
      ...result,
      value_decimal: converted.decimal,
      value_formatted: converted.formatted,
    }
  }

  if (typeof obj.gas === 'string' && obj.gas.startsWith('0x')) {
    const converted = formatGasAmount(obj.gas)
    return {
      ...result,
      gas_decimal: converted.decimal,
      gas_formatted: converted.formatted_gwei,
    }
  }

  return result
}

export function formatNumber(n: number): string {
  if (n === 0) return '0'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + 'T'
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e4) return sign + (abs / 1e3).toFixed(1) + 'K'
  if (abs >= 1000) return sign + abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (abs >= 1) return sign + abs.toFixed(2)
  if (abs >= 0.01) return sign + abs.toFixed(4)
  return sign + abs.toFixed(8)
}

export function formatUSD(n: number): string {
  if (n === 0) return '$0'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e12) return sign + '$' + (abs / 1e12).toFixed(2) + 'T'
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(1) + 'K'
  if (abs >= 0.01) return sign + '$' + abs.toFixed(2)
  if (abs >= 0.00000001) return sign + '$' + abs.toFixed(8).replace(/0+$/, '')
  return sign + '$' + abs.toExponential(4)
}

export function formatPct(n: number): string {
  return n.toFixed(1) + '%'
}

export function formatBTC(btc: number): string {
  if (btc === 0) return '0 BTC'
  if (Math.abs(btc) < 0.001) return Math.round(btc * 1e8).toLocaleString('en-US') + ' sats'
  return btc.toFixed(8) + ' BTC'
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return Math.round(seconds) + 's'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's'
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm'
  return Math.floor(seconds / 86400) + 'd ' + Math.floor((seconds % 86400) / 3600) + 'h'
}

export function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function formatAddress(address: string, label?: string): string {
  if (label) return `${label} (${shortenAddress(address)})`
  return address
}

function buildChatAnswer(payload: RecordLike): string | undefined {
  if (typeof payload._summary === 'string' && payload._summary.trim()) {
    return makeCompletenessAwareAnswer(payload._summary.trim(), payload)
  }

  const headline = isRecord(payload._ui) && isRecord(payload._ui.headline) ? payload._ui.headline : undefined
  const title = typeof headline?.title === 'string' ? headline.title : undefined
  const subtitle = typeof headline?.subtitle === 'string' ? headline.subtitle : undefined
  if (title && subtitle) return makeCompletenessAwareAnswer(`${title}: ${subtitle}`, payload)
  if (title) return makeCompletenessAwareAnswer(title, payload)
  if (subtitle) return makeCompletenessAwareAnswer(subtitle, payload)

  if (typeof payload.number === 'number') {
    return makeCompletenessAwareAnswer(`Current value: ${payload.number.toLocaleString('en-US')}.`, payload)
  }

  if (typeof payload.value === 'number' || typeof payload.value === 'string') {
    return makeCompletenessAwareAnswer(`Current value: ${String(payload.value)}.`, payload)
  }

  if (isRecord(payload.head) && typeof payload.head.number === 'number') {
    return makeCompletenessAwareAnswer(`Current head is ${payload.head.number.toLocaleString('en-US')}.`, payload)
  }

  if (Array.isArray(payload.items)) {
    return makeCompletenessAwareAnswer(
      `Returned ${payload.items.length.toLocaleString('en-US')} result${payload.items.length === 1 ? '' : 's'}.`,
      payload,
    )
  }

  const meta = isRecord(payload._meta) ? payload._meta : undefined
  const summary = isRecord(payload.summary) ? payload.summary : undefined
  const toolContract = isRecord(payload._tool_contract) ? payload._tool_contract : undefined
  const network = humanizeLabel(
    meta?.network ?? meta?.dataset ?? summary?.network ?? payload.network ?? payload.display_name,
  )
  const toolName = typeof toolContract?.name === 'string' ? toolContract.name : undefined
  const toolLabel = humanizeLabel(toolName?.replace(/^portal_/, ''))
  if (toolLabel && network) {
    return makeCompletenessAwareAnswer(`${toolLabel} for ${network}.`, payload)
  }
  if (toolLabel) {
    return makeCompletenessAwareAnswer(toolLabel, payload)
  }

  return undefined
}

function buildDisplay(payload: RecordLike): RecordLike | undefined {
  const headline = isRecord(payload._ui) && isRecord(payload._ui.headline) ? payload._ui.headline : undefined
  const summary = isRecord(payload.summary) ? payload.summary : undefined
  const meta = isRecord(payload._meta) ? payload._meta : undefined
  const toolContract = isRecord(payload._tool_contract) ? payload._tool_contract : undefined

  const title =
    (typeof headline?.title === 'string' && headline.title) ||
    humanizeLabel(summary?.pair_label) ||
    humanizeLabel(summary?.venue_label) ||
    humanizeLabel(summary?.metric) ||
    humanizeLabel(toolContract?.name)
  const resolvedNetwork =
    humanizeLabel(meta?.network) ||
    humanizeLabel(meta?.dataset) ||
    humanizeLabel(summary?.network) ||
    humanizeLabel(payload.network) ||
    humanizeLabel(payload.display_name)

  const subtitle =
    (typeof headline?.subtitle === 'string' && headline.subtitle) ||
    [
      resolvedNetwork,
      humanizeLabel(summary?.venue_label),
      typeof summary?.interval === 'string' ? summary.interval : undefined,
      typeof summary?.duration === 'string' ? summary.duration : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' • ')

  const display: RecordLike = {}
  if (title) display.title = title
  if (subtitle) display.subtitle = subtitle

  if (resolvedNetwork) display.network = resolvedNetwork

  const vmValues = asArray<string>(toolContract?.vm).filter((value) => value !== 'cross-chain')
  if (vmValues.length === 1) {
    const vm = humanizeLabel(vmValues[0])
    if (vm) display.vm = vm
  }

  const focus =
    humanizeLabel(summary?.pair_label) ||
    humanizeLabel(summary?.metric) ||
    humanizeLabel(summary?.base_token) ||
    (typeof payload.address === 'string' ? payload.address : undefined)
  if (focus) display.focus = focus

  const source = humanizeLabel(summary?.venue_label) || humanizeLabel(summary?.source)
  if (source) display.source = source

  return Object.keys(display).length > 0 ? display : undefined
}

function buildNextSteps(payload: RecordLike): RecordLike | undefined {
  const ui = isRecord(payload._ui) ? payload._ui : undefined
  const pipesHandoff = isRecord(payload.pipes_handoff) ? payload.pipes_handoff : undefined
  const pagination = isRecord(payload._pagination) ? payload._pagination : undefined
  const toolContract = isRecord(payload._tool_contract) ? payload._tool_contract : undefined
  const toolName = typeof toolContract?.name === 'string' ? toolContract.name : undefined
  const hasContinuation = typeof pagination?.next_cursor === 'string'
  const adjacentWindow = pagination?.continuation_scope === 'adjacent_window'
  const continuationLabel = adjacentWindow ? 'Load previous window' : 'Load more results'
  const executableContinuation = buildExecutableContinuationAction(pagination, toolName)
  const actions = asArray<RecordLike>(ui?.follow_up_actions).map((action) =>
    withContinuationExecutableMetadata(normalizeFollowUpAction(action), executableContinuation),
  )
  const hasExplicitContinueAction = actions.some((action) => action.intent === 'continue')

  if (hasContinuation && !hasExplicitContinueAction) {
    actions.unshift({
      label: continuationLabel,
      intent: 'continue',
      target: '_pagination.next_cursor',
      executable: executableContinuation?.executable === true,
      ...(executableContinuation?.tool ? { tool: executableContinuation.tool } : {}),
      ...(executableContinuation?.arguments ? { arguments: executableContinuation.arguments } : {}),
      cursor_path: '_pagination.next_cursor',
    })
  }

  if (actions.length === 0 && typeof pagination?.next_cursor !== 'string' && !pipesHandoff) {
    return undefined
  }

  return {
    actions: actions.slice(0, 6),
    ...(hasContinuation
      ? {
          continuation: {
            available: true,
            label: continuationLabel,
            how_to_continue: 'Reuse _pagination.next_cursor on the same tool.',
            note: adjacentWindow ? 'Cursor opens the preceding window.' : 'More matching rows remain in this window.',
          },
        }
      : {}),
    ...(pipesHandoff
      ? {
          custom_data: {
            available: true,
            label: typeof pipesHandoff.title === 'string' ? pipesHandoff.title : 'Need more data?',
            note:
              typeof pipesHandoff.summary === 'string'
                ? pipesHandoff.summary
                : 'Use Pipes SDK when you need custom indexing or backfill depth.',
          },
        }
      : {}),
  }
}

function buildDefaultFreshness(): RecordLike {
  return { kind: 'not_applicable' }
}

function buildDefaultPagination(): RecordLike {
  return { has_more: false }
}

function buildDefaultCoverage(): RecordLike {
  return {
    kind: 'not_applicable',
    result_complete: true,
  }
}

function buildDefaultOrdering(): RecordLike {
  return { kind: 'not_applicable' }
}

function buildDefaultExecution(toolName?: string): RecordLike {
  return {
    kind: 'not_applicable',
    source: 'portal_mcp',
    ...(toolName ? { tool: toolName } : {}),
  }
}

export function inferPrimaryEvidencePath(
  payload: RecordLike,
  options: { arraysOnly?: boolean } = {},
): string | undefined {
  const tablePaths = asArray<RecordLike>(payload.tables)
    .map((entry) => entry.data_key)
    .filter((path): path is string => typeof path === 'string')
  const chart = isRecord(payload.chart) ? payload.chart : undefined
  const chartPaths = typeof chart?.data_key === 'string' ? [chart.data_key] : []
  const preferredKeys = [
    'items',
    'matches',
    'fills',
    'candles',
    'buckets',
    'transactions',
    'transfers',
    'logs',
    'events',
    'calls',
    'instructions',
    'blocks',
    'networks',
    'activity.items',
    'interactions.top_callers',
    'events.top_event_types',
    'top_events',
    'top_calls',
    'top_programs.programs',
    'fund_flow.largest_movements',
    'token_transfers.items',
    'transactions.items',
    'ohlc',
    'time_series',
    'volume_by_coin',
    'top_traders_by_volume',
    'top_senders',
    'top_receivers',
    'top_contracts',
    'recent_outputs',
    'recent_inputs',
    'summary_rows',
    'presentation_summary',
    'overview',
    'summary',
    'interactions',
    'block_details',
    'block_number',
    'number',
    'timestamp',
    'network',
  ]

  return [...tablePaths, ...chartPaths, ...preferredKeys].find((path) => {
    const value = getByPath(payload, path)
    return options.arraysOnly ? Array.isArray(value) : value !== undefined
  })
}

function inferPrimaryEvidenceKind(payload: RecordLike, primaryPath?: string): string | undefined {
  const table = asArray<RecordLike>(payload.tables).find((entry) => entry.data_key === primaryPath)
  if (typeof table?.title === 'string') return table.title

  const chart = isRecord(payload.chart) ? payload.chart : undefined
  if (chart && chart.data_key === primaryPath && typeof chart.kind === 'string') return chart.kind

  if (!primaryPath) return undefined
  if (primaryPath === 'answer' || primaryPath === '_summary') return 'summary_text'
  if (primaryPath.includes('ohlc')) return 'candles'
  if (primaryPath.includes('time_series')) return 'time_series'
  if (primaryPath.includes('activity')) return 'activity'
  if (primaryPath.includes('transaction')) return 'transactions'
  if (primaryPath.includes('transfer')) return 'token_transfers'
  if (primaryPath.includes('top_')) return 'ranked_summary'
  if (primaryPath.includes('overview') || primaryPath.includes('summary')) return 'summary'
  if (primaryPath === 'number' || primaryPath.includes('block_number') || primaryPath.includes('timestamp'))
    return 'lookup'
  return 'records'
}

function inferReturnedCount(payload: RecordLike, primaryPath?: string): number | undefined {
  const meta = isRecord(payload._meta) ? payload._meta : undefined
  if (typeof meta?.returned === 'number') return meta.returned

  const primaryValue = getByPath(payload, primaryPath)
  if (Array.isArray(primaryValue)) return primaryValue.length

  const overview = isRecord(payload.overview) ? payload.overview : undefined
  if (typeof overview?.activity_count === 'number') return overview.activity_count
  if (typeof overview?.transaction_count === 'number') return overview.transaction_count

  return undefined
}

function collectCandidateRows(payload: RecordLike): Array<{ path: string; row: RecordLike }> {
  const paths = [
    'items',
    'activity.items',
    'token_transfers.items',
    'transactions.items',
    'top_senders',
    'top_receivers',
    'top_contracts',
    'volume_by_coin',
    'top_traders_by_volume',
    'recent_outputs',
    'recent_inputs',
  ]
  const rows: Array<{ path: string; row: RecordLike }> = []

  rows.push({ path: '$', row: payload })

  for (const path of paths) {
    const value = getByPath(payload, path)
    if (!Array.isArray(value)) continue
    value.slice(0, 3).forEach((entry, index) => {
      if (isRecord(entry)) rows.push({ path: `${path}[${index}]`, row: entry })
    })
  }

  return rows
}

function collectInvestigationPivots(payload: RecordLike): RecordLike[] {
  const toolContract = isRecord(payload._tool_contract) ? payload._tool_contract : undefined
  const toolName = typeof toolContract?.name === 'string' ? toolContract.name : undefined
  const blockResult = toolName === 'portal_get_head' || toolName === 'portal_debug_query_blocks'
  const pivotKeys: Record<string, string> = {
    address: 'address',
    contract_address: 'address',
    token_address: 'token_address',
    pool_address: 'pool_address',
    pool_id: 'pool_id',
    block_number: 'from_block/to_block',
    from: 'from_addresses',
    to: 'to_addresses',
    sender: 'from_addresses',
    recipient: 'to_addresses',
    user: 'user',
    coin: 'coin',
    program_id: 'program_id',
    transaction_hash: 'transaction_hash',
    tx_hash: 'transaction_hash',
    hash: blockResult ? 'block_hash' : 'transaction_hash',
    block_hash: 'block_hash',
    primary_id: 'primary_id',
  }
  const seen = new Set<string>()
  const pivots: RecordLike[] = []

  for (const { row } of collectCandidateRows(payload)) {
    if (blockResult && typeof row.number === 'number') {
      const text = String(row.number)
      const dedupeKey = `from_block/to_block:${text}`
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        pivots.push({
          field: 'number',
          value: text,
          use_as: 'from_block/to_block',
        })
        if (pivots.length >= 5) return pivots
      }
    }

    for (const [key, useAs] of Object.entries(pivotKeys)) {
      const value = row[key]
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const text = String(value)
      if (!text || text === '0x') continue
      /* Deduplicate by target role + normalized value so alias pairs like
         from/sender, to/recipient, and hash/tx_hash/primary_id do not repeat
         the exact same identifier multiple times. */
      const normalizedRole = useAs === 'primary_id' ? 'transaction_hash' : useAs
      const dedupeKey = `${normalizedRole}:${text.toLowerCase()}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      pivots.push({
        field: key,
        value: text,
        use_as: useAs,
      })
      if (pivots.length >= 5) return pivots
    }
  }

  return pivots
}

function buildInvestigationGuide(payload: RecordLike): RecordLike | undefined {
  const toolContract = isRecord(payload._tool_contract) ? payload._tool_contract : undefined
  const intent = typeof toolContract?.intent === 'string' ? toolContract.intent : undefined
  const pagination = isRecord(payload._pagination) ? payload._pagination : undefined
  const coverage = isRecord(payload._coverage) ? payload._coverage : undefined
  const execution = isRecord(payload._execution) ? payload._execution : undefined
  const notices = [
    ...asArray<string>(payload._notices),
    ...(typeof payload._notice === 'string' ? [payload._notice] : []),
  ].slice(0, 3)
  const primaryPath =
    inferPrimaryEvidencePath(payload) ?? (typeof payload.answer === 'string' ? 'answer' : undefined) ?? '_summary'
  const primaryKind = inferPrimaryEvidenceKind(payload, primaryPath)
  const returned = inferReturnedCount(payload, primaryPath)
  const pivots = collectInvestigationPivots(payload)
  const limitations: string[] = []
  const continuationScope =
    typeof pagination?.continuation_scope === 'string' ? pagination.continuation_scope : 'remaining_results'
  const resultIncomplete =
    coverage?.result_complete === false ||
    coverage?.window_complete === false ||
    (coverage?.result_complete !== true &&
      continuationScope !== 'adjacent_window' &&
      typeof pagination?.next_cursor === 'string')

  if (typeof pagination?.next_cursor === 'string') {
    limitations.push(
      continuationScope === 'adjacent_window'
        ? 'Cursor loads an older adjacent window.'
        : 'Preview page; continue with _pagination.next_cursor.',
    )
  } else if (
    coverage?.has_more === true ||
    coverage?.result_complete === false ||
    coverage?.window_complete === false
  ) {
    limitations.push('Window or result coverage is partial; inspect _coverage.')
  }
  if (typeof execution?.max_scan_blocks === 'number' && typeof execution?.scanned_blocks === 'number') {
    limitations.push(
      `Scanned ${execution.scanned_blocks.toLocaleString('en-US')}/${execution.max_scan_blocks.toLocaleString('en-US')} blocks.`,
    )
  }
  limitations.push(...notices)

  const followUpFilters: RecordLike[] = []
  if (typeof pagination?.next_cursor === 'string') {
    followUpFilters.push({
      goal: 'Continue timeline',
      use: 'Reuse _pagination.next_cursor.',
    })
  }
  if (pivots.length > 0) {
    followUpFilters.push({
      goal: 'Pivot on returned entity',
      use: 'Reuse values from investigation.pivots as exact filters.',
    })
  }
  if (followUpFilters.length === 0) {
    followUpFilters.push({
      goal: 'Adjust scope',
      use: 'Refine network, timeframe, or block bounds.',
    })
  }

  return {
    version: 'portal_investigation_v1',
    status: resultIncomplete ? 'partial_page' : intent === 'discover' ? 'reference_result' : 'bounded_result',
    evidence: {
      ...(primaryPath ? { primary_path: primaryPath } : {}),
      ...(primaryKind ? { primary_kind: primaryKind } : {}),
      ...(returned !== undefined ? { returned } : {}),
    },
    pivots,
    follow_up_filters: followUpFilters,
    limitations: Array.from(new Set(limitations)).slice(0, 4),
  }
}

function buildInferredExecutionMetadata(metadata?: FormatOptions['metadata']) {
  if (!metadata) return undefined

  if (metadata.from_block === undefined && metadata.to_block === undefined) {
    return undefined
  }

  return {
    scan_window: {
      ...(metadata.from_block !== undefined ? { from_block: metadata.from_block } : {}),
      ...(metadata.to_block !== undefined ? { to_block: metadata.to_block } : {}),
    },
  }
}

function mergeExecutionMetadata(
  inferredExecution: Record<string, unknown> | undefined,
  explicitExecution: Record<string, unknown> | undefined,
) {
  if (!inferredExecution && !explicitExecution) {
    return undefined
  }

  const merged = {
    ...(inferredExecution || {}),
    ...(explicitExecution || {}),
  } as Record<string, unknown>

  if (
    inferredExecution?.['scan_window'] &&
    explicitExecution?.['scan_window'] &&
    typeof inferredExecution['scan_window'] === 'object' &&
    inferredExecution['scan_window'] !== null &&
    typeof explicitExecution['scan_window'] === 'object' &&
    explicitExecution['scan_window'] !== null
  ) {
    merged.scan_window = {
      ...(inferredExecution['scan_window'] as Record<string, unknown>),
      ...(explicitExecution['scan_window'] as Record<string, unknown>),
    }
  }

  return merged
}

function normalizeExecutionMetadata(execution: Record<string, unknown>, toolName?: string): Record<string, unknown> {
  const hasWindowOrResolution =
    execution.kind !== undefined ||
    execution.range_kind !== undefined ||
    execution.scan_window !== undefined ||
    execution.timestamp !== undefined ||
    execution.resolution !== undefined

  if (hasWindowOrResolution) {
    return {
      ...(toolName && execution.tool === undefined ? { tool: toolName } : {}),
      ...execution,
    }
  }

  return {
    kind: 'not_applicable',
    ...(toolName ? { tool: toolName } : {}),
    ...execution,
  }
}

function responseTooLargeError(formattedBytes: number, options?: FormatOptions): ActionableError {
  const pagination = isRecord(options?.pagination) ? options?.pagination : undefined
  const pageSize = typeof pagination?.page_size === 'number' ? pagination.page_size : options?.maxItems
  const recommendedLimit =
    typeof pageSize === 'number' && pageSize > 1
      ? Math.max(1, Math.floor(pageSize * (MAX_RESPONSE_BYTES / formattedBytes) * 0.8))
      : undefined

  return new ActionableError(
    `Response too large (${formattedBytes.toLocaleString('en-US')} bytes). SQD did not shorten the blockchain evidence because that could create an incomplete result.`,
    [
      ...(recommendedLimit ? [`Retry with limit: ${recommendedLimit}`] : []),
      'Narrow timeframe, from_block/to_block, or other query filters',
      'Use the returned pagination cursor only when the tool provides one',
    ],
    {
      formatted_bytes: formattedBytes,
      maximum_formatted_bytes: MAX_RESPONSE_BYTES,
      ...(recommendedLimit ? { recommended_arguments: { limit: recommendedLimit } } : {}),
    },
    {
      code: 'response_too_large',
      origin: 'client_input',
      retryable: true,
    },
  )
}

/**
 * Format results as MCP text content with optional metadata. Oversized
 * responses fail explicitly instead of silently dropping blockchain rows.
 */
export function formatResult(data: unknown, message?: string, options?: FormatOptions): FormattedToolResult {
  let dataToFormat = data
  const notices = [...(options?.notices || [])]

  assertUniqueNormalizedIds(dataToFormat)

  let jsonString: string
  try {
    jsonString = JSON.stringify(dataToFormat, null, 2)
  } catch {
    try {
      jsonString = JSON.stringify(dataToFormat)
    } catch {
      return {
        content: [{ type: 'text', text: 'Error: Unable to serialize response.' }],
      }
    }
  }

  // Attach metadata
  const metadata = options?.metadata
  let responsePayload: unknown = dataToFormat

  if (metadata) {
    const meta: ResponseMetadata = {}
    if (metadata.network) meta.network = metadata.network
    if (metadata.dataset) meta.dataset = metadata.dataset
    if (metadata.from_block !== undefined && metadata.to_block !== undefined) {
      meta.queried_blocks = `${metadata.from_block}-${metadata.to_block}`
    }
    if (metadata.query_start_time) meta.response_time_ms = Date.now() - metadata.query_start_time
    if (Array.isArray(dataToFormat)) {
      meta.returned = (dataToFormat as unknown[]).length
    }

    if (Array.isArray(dataToFormat)) {
      responsePayload = { items: dataToFormat, _meta: meta }
    } else if (typeof dataToFormat === 'object' && dataToFormat !== null) {
      responsePayload = { ...dataToFormat, _meta: meta }
    } else {
      responsePayload = { value: dataToFormat, _meta: meta }
    }
  } else if (Array.isArray(dataToFormat)) {
    responsePayload = { items: dataToFormat }
  } else if (typeof dataToFormat !== 'object' || dataToFormat === null) {
    responsePayload = { value: dataToFormat }
  }

  if (typeof responsePayload === 'object' && responsePayload !== null) {
    const payloadRecord = responsePayload as Record<string, unknown>
    const toolContract = options?.toolName ? getToolContract(options.toolName) : undefined
    const execution = normalizeExecutionMetadata(
      mergeExecutionMetadata(buildInferredExecutionMetadata(metadata), options?.execution) ??
        buildDefaultExecution(options?.toolName),
      options?.toolName,
    )

    if (message?.trim()) {
      payloadRecord._summary = message.trim()
    }
    if (toolContract) {
      payloadRecord._tool_contract = {
        name: toolContract.name,
        intent: toolContract.intent,
        vm: toolContract.vm,
        ...(toolContract.normalized_output ? { normalized_output: true } : {}),
        untrusted_fields: UNTRUSTED_FIELDS,
      }
    }
    payloadRecord._server = {
      name: 'SQD',
      version: npmVersion,
      commit: gitCommit,
    }
    payloadRecord._pagination = options?.pagination ?? buildDefaultPagination()
    payloadRecord._ordering = options?.ordering ?? buildDefaultOrdering()
    payloadRecord._freshness = options?.freshness ?? buildDefaultFreshness()
    payloadRecord._coverage = reconcileCoverageWithPagination(
      reconcileCoverageWithFreshness(options?.coverage ?? buildDefaultCoverage(), payloadRecord._freshness),
      payloadRecord._pagination,
    )
    if (payloadRecord.gap_diagnostics !== undefined) {
      payloadRecord.gap_diagnostics = reconcileGapDiagnosticsWithFreshness(
        payloadRecord.gap_diagnostics,
        payloadRecord._freshness,
      )
    }
    payloadRecord._execution = execution
    if (options?.ui !== undefined) {
      payloadRecord._ui = options.ui
    }
    if (options?.toolName && ACTIVITY_EXPLORER_TOOLS.has(options.toolName) && isActivityExplorerEnabled()) {
      payloadRecord._app = {
        name: 'SQD Explorer',
        stage: 'beta',
        version: npmVersion,
        resource_uri: ACTIVITY_EXPLORER_RESOURCE_URI,
        server_delivery_state: 'ready',
        host_render_state: 'not_observable_from_tool_result',
        required_host_extension: 'io.modelcontextprotocol/ui',
      }
    }
    if (options?.pipes !== undefined) {
      payloadRecord.pipes_handoff = options.pipes
    }

    if (notices.length === 1) {
      payloadRecord._notice = notices[0]
    } else if (notices.length > 1) {
      payloadRecord._notices = notices
    }

    // Third-party names may already sit in the summary, notices, and headline.
    // Clean the prose copies before they feed the answer; structured data stays exact.
    cleanProseFields(payloadRecord)
    const answer = buildChatAnswer(payloadRecord)
    const display = buildDisplay(payloadRecord)
    const nextSteps = buildNextSteps(payloadRecord) ?? { actions: [] }
    if (answer) payloadRecord.answer = answer
    if (display) payloadRecord.display = display
    payloadRecord.next_steps = nextSteps
    cleanProseFields(payloadRecord)

    payloadRecord.investigation = buildInvestigationGuide(payloadRecord)
    payloadRecord._llm = buildLlmHints(payloadRecord, options?.llm)

    const orderedPayload: Record<string, unknown> = {}

    if (answer) {
      orderedPayload.answer = answer
    }
    if (display) {
      orderedPayload.display = display
    }
    if (nextSteps) {
      orderedPayload.next_steps = nextSteps
    }

    for (const [key, value] of Object.entries(payloadRecord)) {
      if (key.startsWith('_')) continue
      orderedPayload[key] = value
    }

    for (const [key, value] of Object.entries(payloadRecord)) {
      if (!key.startsWith('_')) continue
      orderedPayload[key] = value
    }

    responsePayload = orderedPayload
  }

  try {
    // Measure and return the actual compact wire representation. Counting
    // indentation here rejected valid results even though MCP clients receive
    // the compact JSON form below.
    jsonString = JSON.stringify(responsePayload)
  } catch {
    return {
      content: [{ type: 'text', text: 'Error: Unable to serialize response.' }],
    }
  }

  const formattedBytes = Buffer.byteLength(jsonString, 'utf8')
  if (formattedBytes > MAX_RESPONSE_BYTES) {
    throw responseTooLargeError(formattedBytes, options)
  }

  try {
    const structuredContent = JSON.parse(jsonString) as Record<string, unknown>

    return {
      // The structured payload is the primary rich result. Keep the text
      // fallback as equivalent JSON, but compact it so compatibility does not
      // double the response-size cost of executable metadata.
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    }
  } catch {
    return { content: [{ type: 'text', text: jsonString }] }
  }
}

/**
 * Format a result with the shared lossless size guard.
 */
export function formatResultWithLimit(data: unknown, message: string, limit: number): FormattedToolResult {
  return formatResult(data, message, { maxItems: limit, warnOnTruncation: true })
}
