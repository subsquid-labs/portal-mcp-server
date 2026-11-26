import { cleanProse } from './untrusted-text.js'

// ============================================================================
// Error Handling with Actionable Messages
// ============================================================================

const REDACTED_VALUE = '[REDACTED]'
const MAX_CONTEXT_ARRAY_ITEMS = 10
const MAX_CONTEXT_DEPTH = 4
const MAX_CONTEXT_STRING_LENGTH = 1000

const AUTHORIZATION_FIELD_NAMES = new Set([
  'authorization',
  'proxy_authorization',
  'auth',
  'bearer',
  'token',
  'api_key',
  'apikey',
  'x_api_key',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'cookie',
  'set_cookie',
  'access_token',
  'refresh_token',
  'id_token',
])

function normalizeContextKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function isAuthorizationLikeKey(key: string): boolean {
  const normalized = normalizeContextKey(key)
  if (AUTHORIZATION_FIELD_NAMES.has(normalized)) {
    return true
  }

  return /(^|_)(authorization|proxy_authorization|auth|bearer|api_key|apikey|secret|client_secret|password|passwd|cookie|set_cookie|access_token|refresh_token|id_token)($|_)/.test(
    normalized,
  )
}

function stripQueryString(value: string): string {
  const queryIndex = value.indexOf('?')
  if (queryIndex === -1) return value

  const hashIndex = value.indexOf('#', queryIndex)
  return `${value.slice(0, queryIndex)}${hashIndex === -1 ? '' : value.slice(hashIndex)}`
}

function sanitizeUrl(value: string): string {
  const stripped = stripQueryString(value)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(stripped)) {
    return stripped
  }

  try {
    const url = new URL(stripped)
    url.username = ''
    url.password = ''
    url.search = ''
    return url.toString()
  } catch {
    return stripped
  }
}

export function sanitizeText(value: string): string {
  return cleanProse(value, Number.MAX_SAFE_INTEGER)
    .replace(/Bearer\s+[A-Za-z0-9._~+/\-=]+/gi, `Bearer ${REDACTED_VALUE}`)
    .replace(
      /\b(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|token)\s*[:=]\s*["']?[^"',\s}\]]+/gi,
      (_match, key: string) => `${key}: ${REDACTED_VALUE}`,
    )
    .replace(/https?:\/\/[^\s"',)]+/gi, (match) => sanitizeUrl(match))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function truncateContextString(value: string): string {
  const sanitized = sanitizeText(value)
  if (sanitized.length <= MAX_CONTEXT_STRING_LENGTH) {
    return sanitized
  }
  return `${sanitized.slice(0, MAX_CONTEXT_STRING_LENGTH - 1)}…`
}

function summarizeArray(value: unknown[], depth: number): unknown[] | Record<string, unknown> {
  if (value.length <= MAX_CONTEXT_ARRAY_ITEMS) {
    return value
      .map((entry) => sanitizeContextValue(entry, undefined, depth + 1))
      .filter((entry) => entry !== undefined)
  }

  return {
    type: 'array',
    length: value.length,
    sample: value.slice(0, 2).map((entry) => sanitizeContextValue(entry, undefined, depth + 1)),
  }
}

function summarizeQueryBody(query: unknown): Record<string, unknown> {
  if (Array.isArray(query)) {
    return { type: 'array', length: query.length }
  }

  if (!isRecord(query)) {
    return { type: typeof query }
  }

  const visibleKeys = Object.keys(query)
    .filter((key) => !isAuthorizationLikeKey(key))
    .sort()
  const summary: Record<string, unknown> = {
    type: typeof query.type === 'string' ? sanitizeText(query.type) : 'object',
    top_level_keys: visibleKeys,
  }

  for (const key of ['fromBlock', 'toBlock', 'from_block', 'to_block', 'fromTimestamp', 'toTimestamp']) {
    const value = query[key]
    if (typeof value === 'number' || typeof value === 'string') {
      summary[key] = value
    }
  }

  for (const key of [
    'logs',
    'transactions',
    'traces',
    'stateDiffs',
    'calls',
    'events',
    'instructions',
    'inputs',
    'outputs',
  ]) {
    const value = query[key]
    if (Array.isArray(value)) {
      summary[`${key}_count`] = value.length
    }
  }

  if (isRecord(query.fields)) {
    summary.field_groups = Object.keys(query.fields)
      .filter((key) => !isAuthorizationLikeKey(key))
      .sort()
  }

  try {
    summary.approx_bytes = JSON.stringify(query).length
  } catch {
    // Circular input is not expected for Portal requests, but keep the
    // sanitizer total and non-throwing for defensive error handling.
  }

  return summary
}

function sanitizeContextValue(value: unknown, key: string | undefined, depth: number): unknown {
  if (key && isAuthorizationLikeKey(key)) {
    return REDACTED_VALUE
  }

  const normalizedKey = key ? normalizeContextKey(key) : ''
  if (
    normalizedKey === 'query' ||
    normalizedKey === 'body' ||
    normalizedKey === 'request_body' ||
    normalizedKey === 'payload'
  ) {
    return summarizeQueryBody(value)
  }

  if (typeof value === 'string') {
    const sanitized =
      normalizedKey.includes('url') || normalizedKey === 'uri' || normalizedKey === 'endpoint'
        ? sanitizeUrl(value)
        : value
    return truncateContextString(sanitized)
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    return summarizeArray(value, depth)
  }

  if (isRecord(value)) {
    if (depth >= MAX_CONTEXT_DEPTH) {
      return {
        type: 'object',
        keys: Object.keys(value)
          .filter((nestedKey) => !isAuthorizationLikeKey(nestedKey))
          .slice(0, 20),
        truncated: true,
      }
    }

    const sanitized: Record<string, unknown> = {}
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      const sanitizedValue = sanitizeContextValue(nestedValue, nestedKey, depth + 1)
      if (sanitizedValue !== undefined) {
        sanitized[nestedKey] = sanitizedValue
      }
    }
    return sanitized
  }

  return undefined
}

export function sanitizeErrorContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context)) {
    const sanitizedValue = sanitizeContextValue(value, key, 0)
    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

export type ToolErrorOrigin = 'client_input' | 'upstream' | 'server' | 'transport'

export type ToolErrorCode =
  | 'invalid_request'
  | 'invalid_cursor'
  | 'unknown_network'
  | 'unsupported_operation'
  | 'not_found'
  | 'no_data'
  | 'incomplete_result'
  | 'response_too_large'
  | 'overloaded'
  | 'upstream_reorg'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'internal_error'
  | 'cancelled'
  | 'unknown_error'

export type ToolErrorDescriptor = {
  code: ToolErrorCode
  origin: ToolErrorOrigin
  summary: string
  retryable: boolean
  retryAfterMs?: number
  suggestions: string[]
}

export type ActionableErrorMetadata = {
  code?: ToolErrorCode
  origin?: ToolErrorOrigin
  retryable?: boolean
  retryAfterMs?: number
}

function inferErrorMetadata(message: string): Required<Omit<ActionableErrorMetadata, 'retryAfterMs'>> {
  const normalized = message.toLowerCase()

  if (normalized.includes('cancel')) {
    return { code: 'cancelled', origin: 'transport', retryable: false }
  }
  if (normalized.includes('pagination cursor') || normalized.includes('cursor belongs')) {
    return { code: 'invalid_cursor', origin: 'client_input', retryable: false }
  }
  if (normalized.includes('unknown network')) {
    return { code: 'unknown_network', origin: 'client_input', retryable: false }
  }
  if (normalized.includes('does not support') || normalized.includes('only supported for')) {
    return { code: 'unsupported_operation', origin: 'client_input', retryable: false }
  }
  if (normalized.includes('response too large')) {
    return { code: 'response_too_large', origin: 'client_input', retryable: false }
  }
  if (normalized.includes('server is busy') || normalized.includes('admission queue')) {
    return { code: 'overloaded', origin: 'server', retryable: true }
  }
  if (normalized.includes('chain reorganization') || normalized.includes('409 conflict')) {
    return { code: 'upstream_reorg', origin: 'upstream', retryable: true }
  }
  if (normalized.includes('rate limit') || normalized.includes('(429')) {
    return { code: 'rate_limited', origin: 'upstream', retryable: true }
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return { code: 'upstream_timeout', origin: 'upstream', retryable: true }
  }
  if (normalized.includes('temporarily unavailable') || normalized.includes('(503')) {
    return { code: 'upstream_unavailable', origin: 'upstream', retryable: true }
  }
  if (normalized.includes('coverage was incomplete')) {
    return { code: 'incomplete_result', origin: 'upstream', retryable: true }
  }
  if (normalized.includes('no data') || (normalized.includes('no ') && normalized.includes(' found'))) {
    return { code: 'no_data', origin: 'client_input', retryable: false }
  }
  if (normalized.includes('not found')) {
    return { code: 'not_found', origin: 'client_input', retryable: false }
  }
  if (
    normalized.includes('portal server error') ||
    normalized.includes('portal api error (5') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('fetch failed') ||
    normalized.includes('socket hang up') ||
    normalized.includes('other side closed') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('etimedout') ||
    normalized.includes('connect timeout') ||
    normalized.includes('headers timeout') ||
    normalized.includes('body timeout')
  ) {
    return { code: 'upstream_error', origin: 'upstream', retryable: true }
  }
  if (
    normalized.includes('invalid') ||
    normalized.includes('required') ||
    normalized.includes('must ') ||
    normalized.includes('cannot be used') ||
    normalized.includes('provide ') ||
    normalized.includes('cannot be empty')
  ) {
    return { code: 'invalid_request', origin: 'client_input', retryable: false }
  }

  return { code: 'internal_error', origin: 'server', retryable: false }
}

function safeGenericSummary(error: Error, metadata: ReturnType<typeof inferErrorMetadata>): string {
  if (metadata.origin === 'server') {
    return 'The tool could not complete the request.'
  }
  return sanitizeText(error.message).slice(0, 500)
}

export class ActionableError extends Error {
  public suggestions: string[]
  public context?: Record<string, unknown>
  public code: ToolErrorCode
  public origin: ToolErrorOrigin
  public retryable: boolean
  public retryAfterMs?: number
  public summary: string

  constructor(
    message: string,
    suggestions: string[],
    context?: Record<string, unknown>,
    metadata: ActionableErrorMetadata = {},
  ) {
    const sanitizedMessage = sanitizeText(message)
    const sanitizedSuggestions = suggestions.map((suggestion) => sanitizeText(suggestion))
    const sanitizedContext = sanitizeErrorContext(context)
    const inferred = inferErrorMetadata(sanitizedMessage)

    // Build the full message including suggestions
    const parts = [sanitizedMessage]

    if (sanitizedSuggestions.length > 0) {
      parts.push('\n\nSuggestions:')
      sanitizedSuggestions.forEach((suggestion, i) => {
        parts.push(`  ${i + 1}. ${suggestion}`)
      })
    }

    if (sanitizedContext && Object.keys(sanitizedContext).length > 0) {
      parts.push('\n\nContext:')
      Object.entries(sanitizedContext).forEach(([key, value]) => {
        parts.push(`  ${key}: ${JSON.stringify(value)}`)
      })
    }

    super(parts.join('\n'))
    this.name = 'ActionableError'
    this.suggestions = sanitizedSuggestions
    this.context = sanitizedContext
    this.code = metadata.code ?? inferred.code
    this.origin = metadata.origin ?? inferred.origin
    this.retryable = metadata.retryable ?? inferred.retryable
    this.retryAfterMs = metadata.retryAfterMs
    this.summary = sanitizedMessage
  }
}

export class RequestCancelledError extends Error {
  constructor(message = 'Request cancelled by the MCP client') {
    super(message)
    this.name = 'RequestCancelledError'
  }
}

export function describeToolError(error: unknown): ToolErrorDescriptor {
  if (error instanceof ActionableError) {
    return {
      code: error.code,
      origin: error.origin,
      summary: error.summary,
      retryable: error.retryable,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      suggestions: error.suggestions,
    }
  }

  if (error instanceof RequestCancelledError) {
    return {
      code: 'cancelled',
      origin: 'transport',
      summary: error.message,
      retryable: false,
      suggestions: [],
    }
  }

  if (error instanceof Error) {
    const metadata = inferErrorMetadata(error.message)
    const suggestions =
      metadata.origin === 'upstream' && metadata.retryable
        ? ['Retry the same request once.', 'Reduce the requested window if the problem continues.']
        : metadata.origin === 'client_input'
          ? ['Review the tool arguments and retry with the corrected values.']
          : ['Retry once. If the problem continues, use a narrower query.']
    return {
      ...metadata,
      summary: safeGenericSummary(error, metadata),
      suggestions,
    }
  }

  return {
    code: 'unknown_error',
    origin: 'server',
    summary: 'The tool could not complete the request.',
    retryable: false,
    suggestions: ['Retry once. If the problem continues, use a narrower query.'],
  }
}

/**
 * Parse Portal API error and provide actionable suggestions
 */
export function parsePortalError(
  status: number,
  errorText: string,
  context?: { url?: string; query?: unknown },
  options?: { retryAfterMs?: number },
): ActionableError {
  const suggestions: string[] = []
  let message = `Portal API Error (${status})`
  const explicitRetryAfterMs =
    typeof options?.retryAfterMs === 'number' && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0
      ? Math.round(options.retryAfterMs)
      : undefined
  let metadata: ActionableErrorMetadata = {
    code: 'upstream_error',
    origin: 'upstream',
    retryable:
      (status >= 500 && status !== 501 && status !== 505) || status === 408 || status === 409 || status === 429,
    ...(explicitRetryAfterMs !== undefined ? { retryAfterMs: explicitRetryAfterMs } : {}),
  }
  const upstreamOverloaded =
    status === 529 ||
    /\"type\"\s*:\s*\"rate_limit_error\"|\"code\"\s*:\s*\"overloaded\"|service is overloaded/i.test(errorText)

  // 400 Bad Request - Parse detailed error
  if (status === 400) {
    message = `Invalid request: ${errorText}`
    metadata = { code: 'invalid_request', origin: 'client_input', retryable: false }

    if (errorText.includes('unknown field')) {
      const fieldMatch = errorText.match(/unknown field `(\w+)`/)
      if (fieldMatch) {
        suggestions.push(`Remove the unsupported field '${fieldMatch[1]}' from your query`)
        suggestions.push('Check the Portal API documentation for valid field names')
      }
    }

    if (errorText.includes('missing field')) {
      const fieldMatch = errorText.match(/missing field '(\w+)'/)
      if (fieldMatch) {
        suggestions.push(`Add the required field '${fieldMatch[1]}' to your query`)
      }
    }

    if (errorText.includes('fromBlock')) {
      suggestions.push('Ensure fromBlock is a valid block number (integer)')
      suggestions.push('Use portal_get_head to find the latest block')
    }

    if (errorText.includes('toBlock')) {
      suggestions.push('Ensure toBlock >= fromBlock')
      suggestions.push('Use portal_get_head to find the latest block')
    }

    if (errorText.includes('invalid address')) {
      suggestions.push("Use lowercase hex addresses (e.g., '0xabc...')")
      suggestions.push('Ensure addresses are 42 characters long (0x + 40 hex digits)')
    }

    if (errorText.includes('invalid topic')) {
      suggestions.push("Use 32-byte hex topics (e.g., '0x' + 64 hex digits)")
      suggestions.push('Ensure topic0, topic1, etc. are correctly formatted')
    }

    // Generic 400 suggestions
    if (suggestions.length === 0) {
      suggestions.push('Verify all query parameters are correctly formatted')
      suggestions.push('Check that addresses are lowercase hex strings')
      suggestions.push('Ensure block numbers are valid integers')
    }
  }

  // 404 Not Found
  if (status === 404) {
    message = `Resource not found: ${errorText}`
    metadata = { code: 'not_found', origin: 'upstream', retryable: false }

    if (context?.url && String(context.url).includes('/timestamps/')) {
      // Timestamp-to-block lookup failed — the indexer hasn't caught up
      const tsMatch = String(context.url).match(/\/timestamps\/(\d+)\/block/)
      suggestions.push(
        `Timestamp ${tsMatch?.[1] ?? 'unknown'} is not yet indexed (indexer may lag ~1-2h behind the chain head)`,
      )
      suggestions.push('Use a longer timeframe (e.g., "24h" instead of "1h") or explicit from_block')
      suggestions.push('Use portal_get_head to get the latest block and query by block range')
    } else if (context?.url && String(context.url).includes('/datasets/')) {
      const datasetMatch = String(context.url).match(/\/datasets\/([^/]+)/)
      if (datasetMatch) {
        suggestions.push(`Network '${datasetMatch[1]}' was not found or is not available here`)
        suggestions.push('Use portal_list_networks to see available networks')
        suggestions.push(
          "Use portal_list_networks with query: 'ethereum', 'base', or another chain name to find the right network",
        )
      }
    } else {
      suggestions.push('Verify the network name is correct')
      suggestions.push('Use portal_list_networks to see all available networks')
    }
  }

  // 408 Request Timeout
  if (status === 408) {
    message = errorText ? `Portal request timed out (408): ${errorText}` : 'Portal request timed out (408)'
    metadata = {
      code: 'upstream_timeout',
      origin: 'upstream',
      retryable: true,
      ...(explicitRetryAfterMs !== undefined ? { retryAfterMs: explicitRetryAfterMs } : {}),
    }
    suggestions.push('Retry the same request')
    suggestions.push('Try a smaller block range if timeouts continue')
  }

  // 409 Conflict (Chain Reorg)
  if (status === 409) {
    message = 'Chain reorganization detected'
    metadata = {
      code: 'upstream_reorg',
      origin: 'upstream',
      retryable: true,
      ...(explicitRetryAfterMs !== undefined ? { retryAfterMs: explicitRetryAfterMs } : {}),
    }
    suggestions.push('Wait a few seconds and retry with the same parameters')
    suggestions.push("Query finalized blocks only (older blocks that won't reorg)")
    suggestions.push('For recent data, use smaller block ranges (< 100 blocks)')
  }

  // 429 Rate Limited
  if (status === 429) {
    const retryAfterMatch = errorText.match(/Retry after (\d+(?:\.\d+)?)s/i)
    const retryAfterMs =
      explicitRetryAfterMs ?? (retryAfterMatch ? Math.round(Number(retryAfterMatch[1]) * 1000) : undefined)
    metadata = {
      code: 'rate_limited',
      origin: 'upstream',
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    }
    if (retryAfterMs !== undefined) {
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000)
      message = `Rate limited. Retry after ${retryAfterSeconds} seconds`
      suggestions.push(`Wait ${retryAfterSeconds} seconds before retrying`)
    } else {
      message = 'Rate limited'
      suggestions.push('Wait a few seconds before retrying')
    }
    suggestions.push('Reduce the frequency of your requests')
    suggestions.push('Use smaller block ranges per query')
    suggestions.push('Consider caching results')
  }

  // Portal may use 529 for capacity overloads. Treat it as an explicit rate
  // limit so clients receive truthful retry guidance instead of a generic 5xx.
  if (upstreamOverloaded) {
    const retryAfterMs = explicitRetryAfterMs ?? 5_000
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
    message = `Portal is temporarily overloaded. Retry after ${retryAfterSeconds} seconds`
    metadata = { code: 'rate_limited', origin: 'upstream', retryable: true, retryAfterMs }
    suggestions.push(`Wait at least ${retryAfterSeconds} seconds before retrying the same request`)
    suggestions.push('Reduce request frequency if overloads continue')
  }

  // 503 Worker unavailable
  if (status === 503) {
    message = `Portal worker temporarily unavailable (503): ${errorText}`
    metadata = {
      code: 'upstream_unavailable',
      origin: 'upstream',
      retryable: true,
      ...(explicitRetryAfterMs !== undefined ? { retryAfterMs: explicitRetryAfterMs } : {}),
    }
    suggestions.push('IMPORTANT: This is a transient error — retry the same request immediately')
    suggestions.push('Portal workers rotate frequently; the next attempt will likely hit a different worker')
    suggestions.push('If retries fail, try a slightly different block range (e.g., shift by 100 blocks)')
    suggestions.push('Check Portal status at https://status.sqd.dev')
  }

  // Other 5xx Server Errors
  if (status >= 500 && status !== 503 && !upstreamOverloaded) {
    message = `Portal server error (${status}): ${errorText}`
    metadata = {
      code: 'upstream_error',
      origin: 'upstream',
      retryable: status !== 501 && status !== 505,
      ...(explicitRetryAfterMs !== undefined ? { retryAfterMs: explicitRetryAfterMs } : {}),
    }
    suggestions.push('This is a Portal API infrastructure issue')
    suggestions.push('Wait a few minutes and retry')
    suggestions.push('Try a different dataset or smaller block range')
    suggestions.push('Check Portal status at https://status.sqd.dev')
  }

  return new ActionableError(message, suggestions, context, metadata)
}

/**
 * Create error for timeout
 */
export function createTimeoutError(timeout: number, context?: Record<string, unknown>): ActionableError {
  const suggestions = [
    `Request timed out after ${timeout}ms`,
    'Try reducing the block range (query fewer blocks)',
    'Add more specific filters (addresses, topics) to reduce result size',
    'Split large queries into smaller block-range chunks',
    'Use a lower timeframe or explicit from_block/to_block window',
  ]

  return new ActionableError(`Request timeout after ${timeout}ms`, suggestions, context, {
    code: 'upstream_timeout',
    origin: 'upstream',
    retryable: true,
  })
}

/**
 * Create error for block range issues
 */
export function createBlockRangeError(fromBlock: number, toBlock: number, reason: string): ActionableError {
  const range = toBlock - fromBlock + 1
  const suggestions = []

  if (range > 100000) {
    suggestions.push(`Block range is very large (${range.toLocaleString()} blocks)`)
    suggestions.push('Reduce range to < 10,000 blocks for logs queries')
    suggestions.push('Reduce range to < 5,000 blocks for traces queries')
    suggestions.push('Split the request into multiple smaller block ranges')
  } else if (range > 10000) {
    suggestions.push(`Block range (${range.toLocaleString()} blocks) may be slow`)
    suggestions.push('Consider reducing to < 10,000 blocks for better performance')
  }

  if (toBlock < fromBlock) {
    suggestions.push('toBlock must be >= fromBlock')
    suggestions.push(`Current: fromBlock=${fromBlock}, toBlock=${toBlock}`)
  }

  if (fromBlock < 0) {
    suggestions.push('fromBlock must be >= 0')
  }

  return new ActionableError(
    reason,
    suggestions,
    { fromBlock, toBlock, range },
    {
      code: 'invalid_request',
      origin: 'client_input',
      retryable: false,
    },
  )
}

/**
 * Create error for empty results with suggestions
 */
export function createEmptyResultError(queryType: string, context: Record<string, unknown>): ActionableError {
  const suggestions = [
    'No data found for the specified query',
    'Try expanding the block range',
    'Check that addresses/topics are correct',
    'Verify the dataset has data for this block range',
    'Use portal_get_head to confirm blocks exist',
  ]

  return new ActionableError(`No ${queryType} found in the specified range`, suggestions, context, {
    code: 'no_data',
    origin: 'client_input',
    retryable: false,
  })
}

/**
 * Create error for invalid dataset
 */
export function createDatasetError(dataset: string, availableCount: number): ActionableError {
  const suggestions = [
    `Network '${dataset}' was not found`,
    `Use portal_list_networks to see all ${availableCount} available networks`,
    "Use portal_list_networks with query='ethereum' or query='base' to search by chain name",
    "Common aliases: 'ethereum', 'polygon', 'base', 'arbitrum', 'optimism'",
  ]

  return new ActionableError(
    `Unknown network: '${dataset}'`,
    suggestions,
    {
      dataset,
      available_networks: availableCount,
    },
    { code: 'unknown_network', origin: 'client_input', retryable: false },
  )
}

/**
 * Create error for invalid address format
 */
export function createAddressFormatError(address: string): ActionableError {
  const suggestions = []

  if (!address.startsWith('0x')) {
    suggestions.push("Address must start with '0x'")
  }

  if (address.length !== 42) {
    suggestions.push(`Address must be 42 characters (0x + 40 hex digits), got ${address.length}`)
  }

  if (!/^0x[0-9a-fA-F]+$/.test(address)) {
    suggestions.push('Address must contain only hexadecimal characters (0-9, a-f)')
  }

  if (address !== address.toLowerCase()) {
    suggestions.push('Use lowercase addresses for consistency')
    suggestions.push(`Try: ${address.toLowerCase()}`)
  }

  return new ActionableError(
    `Invalid address format: ${address}`,
    suggestions,
    { address },
    {
      code: 'invalid_request',
      origin: 'client_input',
      retryable: false,
    },
  )
}

function describeChainType(chainType: string): string {
  switch (chainType) {
    case 'evm':
      return 'EVM'
    case 'tron':
      return 'Tron'
    case 'solana':
      return 'Solana'
    case 'bitcoin':
      return 'Bitcoin'
    case 'substrate':
      return 'Substrate'
    case 'hyperliquidFills':
      return 'Hyperliquid fills'
    case 'hyperliquidReplicaCmds':
      return 'Hyperliquid replica'
    default:
      return chainType
  }
}

export function createUnsupportedChainError(params: {
  toolName: string
  dataset: string
  actualChainType: string
  supportedChains: string[]
  suggestions?: string[]
  context?: Record<string, unknown>
}): ActionableError {
  const { toolName, dataset, actualChainType, supportedChains, suggestions = [], context } = params
  const supported = supportedChains.map((chain) => describeChainType(chain)).join(', ')

  return new ActionableError(
    `${toolName} does not support network '${dataset}' because it is a ${describeChainType(actualChainType)} network. Supported chain types: ${supported}.`,
    suggestions,
    {
      dataset,
      actual_chain_type: actualChainType,
      supported_chains: supportedChains,
      ...context,
    },
  )
}

export function createUnsupportedMetricError(params: {
  toolName: string
  metric: string
  dataset: string
  supportedMetrics: string[]
  reason?: string
  suggestions?: string[]
}): ActionableError {
  const { toolName, metric, dataset, supportedMetrics, reason, suggestions = [] } = params
  return new ActionableError(
    `${toolName} does not support metric '${metric}' for network '${dataset}'.${reason ? ` ${reason}` : ''}`,
    suggestions.length > 0
      ? suggestions
      : [`Use one of the supported metrics instead: ${supportedMetrics.join(', ')}.`],
    {
      dataset,
      metric,
      supported_metrics: supportedMetrics,
    },
  )
}

const PERMANENT_NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_NONAME',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_INVALID_URL',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
])

function isPermanentNetworkError(error: Error): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && PERMANENT_NETWORK_ERROR_CODES.has(code)) {
      return true
    }
    const message = (current as { message?: unknown }).message
    if (typeof message === 'string' && /\b(ENOTFOUND|EAI_NONAME|ENETUNREACH|EHOSTUNREACH)\b/i.test(message)) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function isTransientNetworkError(error: Error): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
      return true
    }
    const message = (current as { message?: unknown }).message
    if (
      typeof message === 'string' &&
      /socket hang up|other side closed|econnreset|econnrefused|etimedout|epipe|eai_again|connect timeout|headers timeout|body timeout|network error/i.test(
        message,
      )
    ) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Wrap any error with actionable context
 */
export function wrapError(error: unknown, context?: Record<string, unknown>): Error {
  if (error instanceof ActionableError) {
    return error
  }

  if (error instanceof Error) {
    // Check if it's a Portal API error we can parse
    const httpMatch = error.message.match(/HTTP (\d+): (.+)/)
    if (httpMatch) {
      const status = parseInt(httpMatch[1], 10)
      const errorText = httpMatch[2]
      return parsePortalError(status, errorText, context)
    }

    // Check for timeout
    if (error.message.includes('abort')) {
      return createTimeoutError(60000, context)
    }

    if (
      error instanceof SyntaxError ||
      /unexpected end|terminated|premature close|invalid json|ndjson|parse/i.test(error.message)
    ) {
      return new ActionableError(
        'Portal returned an incomplete or malformed data stream.',
        [
          'Retry the same request once',
          'If the problem continues, narrow the timeframe or block range',
          'Do not treat any rows from the interrupted response as complete',
        ],
        context,
        { code: 'upstream_error', origin: 'upstream', retryable: true },
      )
    }

    if (isPermanentNetworkError(error)) {
      return new ActionableError(
        error.message,
        ['Verify the Portal endpoint URL and network connectivity before retrying'],
        context,
        { code: 'upstream_error', origin: 'upstream', retryable: false },
      )
    }

    if (isTransientNetworkError(error)) {
      return new ActionableError(
        error.message,
        ['Retry the same request', 'If the problem continues, narrow the timeframe or block range'],
        context,
        { code: 'upstream_error', origin: 'upstream', retryable: true },
      )
    }

    // Generic error - add context if provided
    if (context) {
      const suggestions = ['Review the error details and query parameters below']
      return new ActionableError(error.message, suggestions, context)
    }

    return error
  }

  return new Error(String(error))
}
