// ============================================================================
// Result Formatting
// ============================================================================

import { buildLlmHints, type LlmOverrides } from './llm-hints.js'
import type { PipesRecipe } from './pipes-recipe.js'
import { getToolContract } from './tool-ux.js'

const MAX_RESPONSE_LENGTH = 50_000 // 50KB - keeps responses within MCP client context limits

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
  portal_get_recent_activity: 'Recent Activity',
  portal_get_wallet_summary: 'Wallet Summary',
  portal_get_time_series: 'Time Series',
  portal_evm_query_transactions: 'EVM Transactions',
  portal_evm_query_logs: 'EVM Logs',
  portal_evm_query_token_transfers: 'Token Transfers',
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

function capitalizeWord(word: string): string {
  const lower = word.toLowerCase()
  if (DISPLAY_NAME_OVERRIDES[lower]) return DISPLAY_NAME_OVERRIDES[lower]
  if (['api', 'btc', 'dex', 'eth', 'evm', 'ohlc', 'rpc', 'sol', 'sql', 'ui', 'usd', 'usdc', 'usdt', 'vm'].includes(lower)) {
    return lower.toUpperCase()
  }
  if (/^[0-9]+[mhdw]$/.test(lower)) return lower
  return lower.charAt(0).toUpperCase() + lower.slice(1)
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
  return normalized.split(' ').map((word) => capitalizeWord(word)).join(' ')
}

function buildChatAnswer(payload: RecordLike): string | undefined {
  if (typeof payload._summary === 'string' && payload._summary.trim()) {
    return payload._summary.trim()
  }

  const headline = isRecord(payload._ui) && isRecord(payload._ui.headline) ? payload._ui.headline : undefined
  const title = typeof headline?.title === 'string' ? headline.title : undefined
  const subtitle = typeof headline?.subtitle === 'string' ? headline.subtitle : undefined
  if (title && subtitle) return `${title}: ${subtitle}`
  if (title) return title
  if (subtitle) return subtitle

  if (typeof payload.number === 'number') {
    return `Current value: ${payload.number.toLocaleString('en-US')}.`
  }

  if (typeof payload.value === 'number' || typeof payload.value === 'string') {
    return `Current value: ${String(payload.value)}.`
  }

  if (isRecord(payload.head) && typeof payload.head.number === 'number') {
    return `Current head is ${payload.head.number.toLocaleString('en-US')}.`
  }

  if (Array.isArray(payload.items)) {
    return `Returned ${payload.items.length.toLocaleString('en-US')} result${payload.items.length === 1 ? '' : 's'}.`
  }

  const meta = isRecord(payload._meta) ? payload._meta : undefined
  const summary = isRecord(payload.summary) ? payload.summary : undefined
  const toolContract = isRecord(payload._tool_contract) ? payload._tool_contract : undefined
  const network = humanizeLabel(
    meta?.network
    ?? meta?.dataset
    ?? summary?.network
    ?? payload.network
    ?? payload.display_name,
  )
  const toolName = typeof toolContract?.name === 'string' ? toolContract.name : undefined
  const toolLabel = humanizeLabel(toolName?.replace(/^portal_/, ''))
  if (toolLabel && network) {
    return `${toolLabel} for ${network}.`
  }
  if (toolLabel) {
    return toolLabel
  }

  return undefined
}

function buildDisplay(payload: RecordLike): RecordLike | undefined {
  const headline = isRecord(payload._ui) && isRecord(payload._ui.headline) ? payload._ui.headline : undefined
  const summary = isRecord(payload.summary) ? payload.summary : undefined
  const meta = isRecord(payload._meta) ? payload._meta : undefined
  const toolContract = isRecord(payload._tool_contract) ? payload._tool_contract : undefined

  const title =
    (typeof headline?.title === 'string' && headline.title)
    || humanizeLabel(summary?.pair_label)
    || humanizeLabel(summary?.venue_label)
    || humanizeLabel(summary?.metric)
    || humanizeLabel(toolContract?.name)
  const resolvedNetwork =
    humanizeLabel(meta?.network)
    || humanizeLabel(meta?.dataset)
    || humanizeLabel(summary?.network)
    || humanizeLabel(payload.network)
    || humanizeLabel(payload.display_name)

  const subtitle =
    (typeof headline?.subtitle === 'string' && headline.subtitle)
    || [
      resolvedNetwork,
      humanizeLabel(summary?.venue_label),
      typeof summary?.interval === 'string' ? summary.interval : undefined,
      typeof summary?.duration === 'string' ? summary.duration : undefined,
    ].filter((value): value is string => Boolean(value)).join(' • ')

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
    humanizeLabel(summary?.pair_label)
    || humanizeLabel(summary?.metric)
    || humanizeLabel(summary?.base_token)
    || (typeof payload.address === 'string' ? payload.address : undefined)
  if (focus) display.focus = focus

  const source =
    humanizeLabel(summary?.venue_label)
    || humanizeLabel(summary?.source)
  if (source) display.source = source

  return Object.keys(display).length > 0 ? display : undefined
}

function buildNextSteps(payload: RecordLike): RecordLike | undefined {
  const ui = isRecord(payload._ui) ? payload._ui : undefined
  const pipesHandoff = isRecord(payload.pipes_handoff) ? payload.pipes_handoff : undefined
  const actions = asArray<RecordLike>(ui?.follow_up_actions)
    .slice(0, 6)
    .map((action) => ({
      label: typeof action.label === 'string' ? action.label : 'Continue',
      ...(typeof action.intent === 'string' ? { intent: action.intent } : {}),
      ...(typeof action.target === 'string' ? { target: action.target } : {}),
    }))

  const pagination = isRecord(payload._pagination) ? payload._pagination : undefined
  const hasContinuation = typeof pagination?.next_cursor === 'string'
  const hasExplicitContinueAction = actions.some((action) => action.intent === 'continue')

  if (hasContinuation && !hasExplicitContinueAction) {
    actions.unshift({
      label: 'Load older results',
      intent: 'continue',
      target: '_pagination.next_cursor',
    })
  }

  if (actions.length === 0 && typeof pagination?.next_cursor !== 'string' && !pipesHandoff) {
    return undefined
  }

  return {
    ...(actions.length > 0 ? { actions } : {}),
    ...(hasContinuation
      ? {
          continuation: {
            available: true,
            label: 'Load older results',
            how_to_continue: 'Call the same tool again with the next cursor from _pagination.next_cursor.',
            note: 'This response is a preview page, so older matching results are still available.',
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
                : 'Use Pipes SDK plus SQD agent skills when you need custom indexing or protocol-specific depth.',
          },
        }
      : {}),
  }
}

function buildTechnicalDetails(payload: RecordLike): RecordLike | undefined {
  const technicalDetails: RecordLike = {}

  if (payload._meta !== undefined) technicalDetails.meta = payload._meta
  if (payload._freshness !== undefined) technicalDetails.freshness = payload._freshness
  if (payload._coverage !== undefined) technicalDetails.coverage = payload._coverage
  if (payload._execution !== undefined) technicalDetails.execution = payload._execution
  if (payload._pagination !== undefined) technicalDetails.pagination = payload._pagination
  if (payload._ordering !== undefined) technicalDetails.ordering = payload._ordering
  if (payload._tool_contract !== undefined) technicalDetails.tool_contract = payload._tool_contract

  return Object.keys(technicalDetails).length > 0 ? technicalDetails : undefined
}

const TRUNCATABLE_ARRAY_KEYS = new Set([
  'items',
  'time_series',
  'ohlc',
  'current_series',
  'previous_series',
  'comparison_series',
  'bucket_deltas',
  'top_contracts',
  'top_programs',
  'programs',
  'volume_by_coin',
  'top_traders_by_volume',
  'top_pnl_winners',
  'top_pnl_losers',
  'recent_outputs',
  'recent_inputs',
  'summary_rows',
])

type TruncatableArrayRef = {
  key: string
  path: string
  values: unknown[]
  replace: (nextValues: unknown[]) => void
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
    inferredExecution?.['scan_window']
    && explicitExecution?.['scan_window']
    && typeof inferredExecution['scan_window'] === 'object'
    && inferredExecution['scan_window'] !== null
    && typeof explicitExecution['scan_window'] === 'object'
    && explicitExecution['scan_window'] !== null
  ) {
    merged.scan_window = {
      ...(inferredExecution['scan_window'] as Record<string, unknown>),
      ...(explicitExecution['scan_window'] as Record<string, unknown>),
    }
  }

  return merged
}

function collectTruncatableArrays(
  value: unknown,
  path = '$',
  results: TruncatableArrayRef[] = [],
): TruncatableArrayRef[] {
  if (!value || typeof value !== 'object') {
    return results
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectTruncatableArrays(entry, `${path}[${index}]`, results))
    return results
  }

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`
    if (Array.isArray(child)) {
      if (TRUNCATABLE_ARRAY_KEYS.has(key) || key.endsWith('_items') || key.endsWith('_series')) {
        results.push({
          key,
          path: childPath,
          values: child,
          replace: (nextValues) => {
            record[key] = nextValues
          },
        })
      }
      child.forEach((entry, index) => collectTruncatableArrays(entry, `${childPath}[${index}]`, results))
      continue
    }

    collectTruncatableArrays(child, childPath, results)
  }

  return results
}

function truncateNestedArraysToFit(
  value: unknown,
  maxLength: number,
): { data: unknown; truncatedPaths: string[]; jsonString?: string } | undefined {
  let working: unknown
  try {
    working = JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }

  const truncatedPaths = new Set<string>()
  let jsonString = JSON.stringify(working, null, 2)
  if (jsonString.length <= maxLength) {
    return { data: working, truncatedPaths: [], jsonString }
  }

  while (jsonString.length > maxLength) {
    const candidates = collectTruncatableArrays(working).filter((candidate) => candidate.values.length > 1)
    if (candidates.length === 0) {
      return undefined
    }

    candidates.sort((left, right) => right.values.length - left.values.length)
    const target = candidates[0]
    const nextLength = Math.max(1, Math.floor(target.values.length / 2))
    if (nextLength >= target.values.length) {
      return undefined
    }

    target.replace(target.values.slice(0, nextLength))
    truncatedPaths.add(target.path)
    jsonString = JSON.stringify(working, null, 2)
  }

  return {
    data: working,
    truncatedPaths: Array.from(truncatedPaths),
    jsonString,
  }
}

/**
 * Format results as MCP text content with optional metadata and truncation.
 */
export function formatResult(
  data: unknown,
  message?: string,
  options?: FormatOptions,
): { content: Array<{ type: 'text'; text: string }> } {
  const maxItems = options?.maxItems

  let dataToFormat = data
  let truncated = false
  let truncationKind: 'array' | 'nested' | undefined
  let originalCount = 0
  const notices = [...(options?.notices || [])]

  // Handle array truncation
  if (Array.isArray(data) && maxItems && data.length > maxItems) {
    originalCount = data.length
    dataToFormat = data.slice(0, maxItems)
    truncated = true
    truncationKind = 'array'
  }

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

  // Truncate if too large
  if (jsonString.length > MAX_RESPONSE_LENGTH) {
    if (Array.isArray(dataToFormat)) {
      const safeCount = Math.floor(((dataToFormat as unknown[]).length * MAX_RESPONSE_LENGTH) / jsonString.length)
      originalCount = originalCount || (dataToFormat as unknown[]).length
      dataToFormat = (dataToFormat as unknown[]).slice(0, Math.max(1, safeCount))
      jsonString = JSON.stringify(dataToFormat, null, 2)
      truncated = true
      truncationKind = 'array'
    } else {
      const nestedTruncation = truncateNestedArraysToFit(dataToFormat, MAX_RESPONSE_LENGTH)
      if (nestedTruncation) {
        dataToFormat = nestedTruncation.data
        jsonString = nestedTruncation.jsonString ?? JSON.stringify(dataToFormat, null, 2)
        truncated = true
        truncationKind = 'nested'
        const pathLabel = nestedTruncation.truncatedPaths.slice(0, 3).join(', ')
        const extraCount = Math.max(0, nestedTruncation.truncatedPaths.length - 3)
        notices.push(
          extraCount > 0
            ? `Large nested arrays were truncated to fit MCP limits (${pathLabel}, +${extraCount} more).`
            : `Large nested arrays were truncated to fit MCP limits (${pathLabel}).`,
        )
      } else {
        return {
          content: [{ type: 'text', text: `Error: Response too large. Add filters or reduce block range.` }],
        }
      }
    }
  }

  if (truncated && (options?.warnOnTruncation ?? true)) {
    if (truncationKind === 'array' && Array.isArray(dataToFormat) && originalCount > dataToFormat.length) {
      notices.push(`Results truncated: showing ${(dataToFormat as unknown[]).length} of ${originalCount} items.`)
    } else if (truncationKind === 'nested') {
      notices.push('Some nested sections were shortened to keep the response fast and readable in MCP clients.')
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
      if (truncated) meta.has_more = true
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
    const execution = mergeExecutionMetadata(buildInferredExecutionMetadata(metadata), options?.execution)

    if (message?.trim()) {
      payloadRecord._summary = message.trim()
    }
    if (toolContract) {
      payloadRecord._tool_contract = toolContract
    }
    if (options?.pagination) {
      payloadRecord._pagination = options.pagination
    }
    if (options?.ordering !== undefined) {
      payloadRecord._ordering = options.ordering
    }
    if (options?.freshness !== undefined) {
      payloadRecord._freshness = options.freshness
    }
    if (options?.coverage !== undefined) {
      payloadRecord._coverage = options.coverage
    }
    if (execution) {
      payloadRecord._execution = execution
    }
    if (options?.ui !== undefined) {
      payloadRecord._ui = options.ui
    }
    if (options?.pipes !== undefined) {
      payloadRecord.pipes_handoff = options.pipes
    }

    const answer = buildChatAnswer(payloadRecord)
    const display = buildDisplay(payloadRecord)
    const nextSteps = buildNextSteps(payloadRecord)
    if (answer) payloadRecord.answer = answer
    if (display) payloadRecord.display = display
    if (nextSteps) payloadRecord.next_steps = nextSteps

    payloadRecord._llm = buildLlmHints(payloadRecord, options?.llm)
    if (notices.length === 1) {
      payloadRecord._notice = notices[0]
    } else if (notices.length > 1) {
      payloadRecord._notices = notices
    }

    const technicalDetails = buildTechnicalDetails(payloadRecord)
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

    if (technicalDetails) {
      orderedPayload.technical_details = technicalDetails
    }

    for (const [key, value] of Object.entries(payloadRecord)) {
      if (!key.startsWith('_')) continue
      orderedPayload[key] = value
    }

    responsePayload = orderedPayload
  }

  try {
    jsonString = JSON.stringify(responsePayload, null, 2)
  } catch {
    try {
      jsonString = JSON.stringify(responsePayload)
    } catch {
      return {
        content: [{ type: 'text', text: 'Error: Unable to serialize response.' }],
      }
    }
  }

  return { content: [{ type: 'text', text: jsonString }] }
}

/**
 * Format result with automatic array truncation
 */
export function formatResultWithLimit(
  data: unknown,
  message: string,
  limit: number,
): { content: Array<{ type: 'text'; text: string }> } {
  return formatResult(data, message, { maxItems: limit, warnOnTruncation: true })
}
