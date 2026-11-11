import { detectChainType } from './helpers/chain.js'
import {
  RequestCancelledError,
  type ToolErrorCode,
  type ToolErrorDescriptor,
  type ToolErrorOrigin,
  describeToolError,
  sanitizeText,
} from './helpers/errors.js'
import { getToolContract } from './helpers/tool-ux.js'
import {
  datasetQueriesTotal,
  observabilityExportsTotal,
  toolClientCallsTotal,
  toolErrorsTotal,
  toolIntentCallsTotal,
  toolOutcomesTotal,
  toolResponseSizeBytes,
} from './metrics.js'
import { currentTraceIds } from './tracing.js'
import { npmVersion } from './version.js'

export type TransportKind = 'stdio' | 'http'

export type RuntimeRequestContext = {
  transport: TransportKind
  requestId?: string
  clientName?: string
  clientVersion?: string
  protocolVersion?: string
  /** Whether this connection opted into the beta SQD Explorer app surface. */
  appEnabled?: boolean
  /** Toolsets this connection asked for (`?toolsets=` or `X-MCP-Toolsets`); only ever narrows the deployment. */
  toolsets?: string[]
  /** Bounded label of the active selection: `all`, one toolset name, or `custom`. */
  toolsetLabel?: string
  /** Hashed connection identifier used only as a fairness key; never logged or labelled. */
  connectionKey?: string
  /** HTTP User-Agent, read only to size the tool catalog; never logged or labelled. */
  userAgent?: string
}

export type ToolEventStatus = 'success' | 'partial' | 'tool_error' | 'request_error' | 'cancelled'
export type ToolResultState = 'data' | 'empty' | 'partial' | 'error' | 'cancelled' | 'unknown'

type ObservabilityEvent = {
  event: 'mcp_tool_call'
  timestamp: string
  invocation_id: string
  request_id?: string
  /* Present only while tracing is on, so a log line and its span can be
     looked up from each other. Both are random ids, never caller input. */
  trace_id?: string
  span_id?: string
  transport: TransportKind
  protocol_version?: string
  server_version: string
  tool: string
  audience?: string
  category?: string
  intent?: string
  vm?: string
  network?: string
  client_family?: string
  client_major?: string
  duration_ms: number
  status: ToolEventStatus
  response_size_bytes?: number
  response_format?: string
  mode?: string
  args_summary?: Record<string, unknown>
  result_state: ToolResultState
  error_origin: ToolErrorOrigin | 'none' | 'unknown'
  error_code: ToolErrorCode | 'none'
  error?: {
    code: ToolErrorCode
    origin: ToolErrorOrigin
    summary: string
    retryable: boolean
    retry_after_ms?: number
  }
}

const OBS_SERVICE_NAME = process.env.OBS_SERVICE_NAME || 'sqd-portal-mcp'
const OBS_ENV = process.env.OBS_ENV || process.env.NODE_ENV || 'production'
const OBS_LOG_JSON = process.env.OBS_LOG_JSON === 'true'
const GRAFANA_LOKI_URL = process.env.GRAFANA_LOKI_URL
const GRAFANA_LOKI_USERNAME = process.env.GRAFANA_LOKI_USERNAME
const GRAFANA_LOKI_PASSWORD = process.env.GRAFANA_LOKI_PASSWORD
const GRAFANA_LOKI_TOKEN = process.env.GRAFANA_LOKI_TOKEN
const GRAFANA_LOKI_TIMEOUT_MS = Number(process.env.GRAFANA_LOKI_TIMEOUT_MS || 2500)

let lastObservabilityExportErrorAt = 0

function getNowNs(): string {
  return `${Date.now()}000000`
}

export function createInvocationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function parseResultPayload(result: unknown): Record<string, unknown> | undefined {
  const resultRecord = asRecord(result)
  const structuredContent = asRecord(resultRecord?.structuredContent)
  if (structuredContent) return structuredContent

  const content = resultRecord?.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const first = asRecord(content[0])
  if (!first || typeof first.text !== 'string') return undefined
  try {
    const parsed = JSON.parse(first.text)
    return asRecord(parsed)
  } catch {
    return undefined
  }
}

const BOUNDED_ERROR_CODES = new Set<ToolErrorCode>([
  'invalid_request',
  'invalid_cursor',
  'unknown_network',
  'unsupported_operation',
  'not_found',
  'no_data',
  'incomplete_result',
  'response_too_large',
  'upstream_reorg',
  'rate_limited',
  'upstream_unavailable',
  'upstream_timeout',
  'upstream_error',
  'internal_error',
  'cancelled',
  'unknown_error',
])
const BOUNDED_ERROR_ORIGINS = new Set<ToolErrorOrigin>(['client_input', 'upstream', 'server', 'transport'])

function resultErrorDescriptor(result: unknown): ToolErrorDescriptor | undefined {
  const resultRecord = asRecord(result)
  if (resultRecord?.isError !== true) return undefined

  const error = asRecord(parseResultPayload(result)?.error)
  const code = typeof error?.code === 'string' ? error.code : undefined
  const origin = typeof error?.origin === 'string' ? error.origin : undefined
  const summary = typeof error?.summary === 'string' ? error.summary : undefined
  const retryable = typeof error?.retryable === 'boolean' ? error.retryable : undefined
  const suggestions = Array.isArray(error?.suggestions)
    ? error.suggestions.filter((value): value is string => typeof value === 'string').slice(0, 4)
    : []

  if (
    code &&
    BOUNDED_ERROR_CODES.has(code as ToolErrorCode) &&
    origin &&
    BOUNDED_ERROR_ORIGINS.has(origin as ToolErrorOrigin) &&
    summary &&
    retryable !== undefined
  ) {
    return {
      code: code as ToolErrorCode,
      origin: origin as ToolErrorOrigin,
      summary,
      retryable,
      ...(typeof error?.retry_after_ms === 'number' ? { retryAfterMs: error.retry_after_ms } : {}),
      suggestions,
    }
  }

  return {
    code: 'unknown_error',
    origin: 'server',
    summary: 'MCP tool returned an error result.',
    retryable: false,
    suggestions: [],
  }
}

function isPartialPayload(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  if (payload.partial === true || payload.result_complete === false || payload.window_complete === false) return true

  const coverage = asRecord(payload._coverage)
  if (coverage?.window_complete === false || coverage?.result_complete === false) return true

  const sectionStatus = asRecord(payload.section_status)
  return Boolean(sectionStatus && Object.values(sectionStatus).some((status) => status === 'unavailable'))
}

export function classifyToolOutcome(params: {
  result?: unknown
  error?: unknown
  cancelled?: boolean
}): ToolEventStatus {
  const { result, error, cancelled = false } = params
  if (cancelled || error instanceof RequestCancelledError) return 'cancelled'
  if (error !== undefined) return 'request_error'
  if (asRecord(result)?.isError === true) return 'tool_error'
  if (isPartialPayload(parseResultPayload(result))) return 'partial'
  return 'success'
}

const EMPTY_ARRAY_KEYS = new Set([
  'items',
  'transactions',
  'logs',
  'transfers',
  'token_transfers',
  'events',
  'calls',
  'instructions',
  'fills',
  'candles',
  'blocks',
  'points',
  'results',
  'series',
])

function isEmptyPayload(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  if (payload.value === null) return true
  if (payload.returned === 0) return true

  const meta = asRecord(payload._meta)
  if (meta?.returned === 0) return true

  const resultArrays = Object.entries(payload).filter(
    ([key, value]) => EMPTY_ARRAY_KEYS.has(key) && Array.isArray(value),
  )
  return resultArrays.length > 0 && resultArrays.every(([, value]) => (value as unknown[]).length === 0)
}

export function classifyToolResultState(params: { status: ToolEventStatus; result?: unknown }): ToolResultState {
  const { status, result } = params
  if (status === 'cancelled') return 'cancelled'
  if (status === 'tool_error' || status === 'request_error') return 'error'
  if (status === 'partial') return 'partial'
  const payload = parseResultPayload(result)
  if (!payload) return 'unknown'
  return isEmptyPayload(payload) ? 'empty' : 'data'
}

function getResponseSizeBytes(result: unknown): number | undefined {
  const content = asRecord(result)?.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const first = asRecord(content[0])
  return typeof first?.text === 'string' ? first.text.length : undefined
}

function classifyVm(toolName: string, args: Record<string, unknown>, payload?: Record<string, unknown>): string {
  const contract = getToolContract(toolName)
  if (contract?.vm?.length === 1 && contract.vm[0] !== 'cross-chain') {
    return contract.vm[0]
  }

  const candidateNetwork =
    (typeof args.network === 'string' ? args.network : undefined) ??
    (typeof args.dataset === 'string' ? args.dataset : undefined) ??
    (typeof payload?._meta === 'object' &&
    payload._meta !== null &&
    typeof (payload._meta as Record<string, unknown>).network === 'string'
      ? String((payload._meta as Record<string, unknown>).network)
      : undefined) ??
    (typeof payload?._meta === 'object' &&
    payload._meta !== null &&
    typeof (payload._meta as Record<string, unknown>).dataset === 'string'
      ? String((payload._meta as Record<string, unknown>).dataset)
      : undefined)

  if (!candidateNetwork) return contract?.vm?.[0] ?? 'unknown'

  const chainType = detectChainType(candidateNetwork)
  if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') return 'hyperliquid'
  return chainType
}

function extractNetwork(payload?: Record<string, unknown>): string | undefined {
  const meta = asRecord(payload?._meta)
  if (typeof meta?.network === 'string') return meta.network
  if (typeof meta?.dataset === 'string') return meta.dataset

  if (typeof payload?.network === 'string') return payload.network
  return undefined
}

function extractExecutionField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const execution = asRecord(payload?._execution)
  return typeof execution?.[key] === 'string' ? String(execution[key]) : undefined
}

/** Bounded client family for a declared client name: claude, openai, grok, gemini, cursor, or unknown. */
export function classifyClientFamily(name?: string): string {
  return normalizeClientIdentity(name).family
}

const SLOW_REQUEST_MS = (() => {
  const parsed = Number(process.env.MCP_SLOW_REQUEST_MS)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5_000
})()

/**
 * One JSON line on stderr for a tool call slower than MCP_SLOW_REQUEST_MS, with
 * phase timings and bounded client identity only.
 */
export function recordSlowToolCall(params: {
  toolName: string
  durationMs: number
  admissionWaitMs: number
  status: ToolEventStatus
  runtime: RuntimeRequestContext
  invocationId: string
}) {
  if (params.durationMs < SLOW_REQUEST_MS) return
  const client = normalizeClientIdentity(params.runtime.clientName, params.runtime.clientVersion)
  console.error(
    JSON.stringify({
      event: 'mcp_slow_tool_call',
      timestamp: new Date().toISOString(),
      invocation_id: params.invocationId,
      ...(params.runtime.requestId ? { request_id: params.runtime.requestId } : {}),
      ...currentTraceIds(),
      tool: params.toolName,
      transport: params.runtime.transport,
      client_family: client.family,
      client_major: client.major,
      status: params.status,
      duration_ms: params.durationMs,
      admission_wait_ms: params.admissionWaitMs,
      execution_ms: Math.max(0, params.durationMs - params.admissionWaitMs),
      threshold_ms: SLOW_REQUEST_MS,
    }),
  )
}

function normalizeClientIdentity(name?: string, version?: string): { family: string; major: string } {
  const normalizedName = name?.trim().toLowerCase() ?? ''
  let family = 'unknown'
  if (normalizedName.includes('claude') || normalizedName.includes('anthropic')) family = 'claude'
  else if (normalizedName.includes('codex') || normalizedName.includes('chatgpt') || normalizedName.includes('openai'))
    family = 'openai'
  else if (normalizedName.includes('grok') || normalizedName.includes('xai')) family = 'grok'
  else if (normalizedName.includes('gemini') || normalizedName.includes('google')) family = 'gemini'
  else if (normalizedName.includes('cursor')) family = 'cursor'
  else if (normalizedName.includes('vscode') || normalizedName.includes('visual studio code')) family = 'vscode'
  else if (normalizedName.includes('windsurf')) family = 'windsurf'
  else if (normalizedName.includes('inspector')) family = 'mcp_inspector'
  else if (normalizedName.includes('test')) family = 'test'

  const majorMatch = version?.trim().match(/^(?:v)?(\d{1,3})(?:\.|$)/i)
  return { family, major: majorMatch ? `v${majorMatch[1]}` : 'unknown' }
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {}

  const scalarKeys = [
    'network',
    'vm',
    'timeframe',
    'duration',
    'interval',
    'metric',
    'mode',
    'response_format',
    'group_by',
    'type',
  ]
  for (const key of scalarKeys) {
    const value = args[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = value
    }
  }

  if (typeof args.limit === 'number') summary.limit = args.limit
  if (typeof args.compare_previous === 'boolean') summary.compare_previous = args.compare_previous
  if (typeof args.decode === 'boolean') summary.decode = args.decode

  if (args.from_block !== undefined || args.to_block !== undefined) summary.has_block_range = true
  if (args.from_timestamp !== undefined || args.to_timestamp !== undefined) summary.has_timestamp_range = true
  if (typeof args.cursor === 'string') summary.has_cursor = true

  const countedArrayKeys = [
    'addresses',
    'token_addresses',
    'token_symbols',
    'from_token_symbols',
    'to_token_symbols',
    'program_id',
    'account',
    'coin',
    'event_names',
    'call_names',
    'from_addresses',
    'to_addresses',
    'topic0',
    'topic1',
    'topic2',
    'topic3',
    'action_type',
  ]

  for (const key of countedArrayKeys) {
    if (Array.isArray(args[key])) {
      summary[`${key}_count`] = (args[key] as unknown[]).length
    }
  }

  const booleanPresenceKeys = [
    'address',
    'contract_address',
    'pool_address',
    'pool_id',
    'pool_manager_address',
    'include_inputs',
    'include_outputs',
    'include_recent_trades',
    'include_logs',
    'include_instructions',
    'include_balances',
    'include_token_balances',
    'include_rewards',
    'include_events',
    'include_transaction',
    'include_traces',
    'include_state_diffs',
  ]

  for (const key of booleanPresenceKeys) {
    const value = args[key]
    if (typeof value === 'boolean') {
      summary[key] = value
    } else if (value !== undefined && value !== null) {
      summary[`has_${key}`] = true
    }
  }

  return summary
}

function maybeLogJsonEvent(event: ObservabilityEvent) {
  if (!OBS_LOG_JSON) return
  console.error(JSON.stringify(event))
}

function buildLokiHeaders() {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (GRAFANA_LOKI_USERNAME && GRAFANA_LOKI_PASSWORD) {
    const raw = `${GRAFANA_LOKI_USERNAME}:${GRAFANA_LOKI_PASSWORD}`
    const encoded =
      typeof Buffer !== 'undefined'
        ? Buffer.from(raw).toString('base64')
        : typeof globalThis.btoa === 'function'
          ? globalThis.btoa(raw)
          : raw
    headers.Authorization = `Basic ${encoded}`
    return headers
  }

  if (GRAFANA_LOKI_TOKEN) {
    headers.Authorization = `Bearer ${GRAFANA_LOKI_TOKEN}`
  }

  return headers
}

function maybeWarnObservabilityExport(error: unknown) {
  const now = Date.now()
  if (now - lastObservabilityExportErrorAt < 60_000) return
  lastObservabilityExportErrorAt = now
  const message = sanitizeText(error instanceof Error ? error.message : String(error))
  console.error(`[observability] failed to export telemetry: ${truncateText(message, 220)}`)
}

async function pushEventToLoki(event: ObservabilityEvent) {
  if (!GRAFANA_LOKI_URL) return

  const stream = {
    app: OBS_SERVICE_NAME,
    env: OBS_ENV,
    event: event.event,
    tool: event.tool,
    status: event.status,
    transport: event.transport,
    server_version: event.server_version,
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), GRAFANA_LOKI_TIMEOUT_MS)

  try {
    const response = await fetch(GRAFANA_LOKI_URL, {
      method: 'POST',
      headers: buildLokiHeaders(),
      body: JSON.stringify({
        streams: [
          {
            stream,
            values: [[getNowNs(), JSON.stringify(event)]],
          },
        ],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      observabilityExportsTotal.inc({ sink: 'loki', status: 'error' })
      throw new Error(`Loki push failed with status ${response.status}`)
    }

    observabilityExportsTotal.inc({ sink: 'loki', status: 'success' })
  } catch (error) {
    observabilityExportsTotal.inc({ sink: 'loki', status: 'error' })
    maybeWarnObservabilityExport(error)
  } finally {
    clearTimeout(timeoutId)
  }
}

function emitObservabilityEvent(event: ObservabilityEvent) {
  maybeLogJsonEvent(event)
  if (GRAFANA_LOKI_URL) {
    void pushEventToLoki(event)
  }
}

export function getObservabilityStatus() {
  return {
    metrics: true,
    json_logs: OBS_LOG_JSON,
    loki_export: Boolean(GRAFANA_LOKI_URL),
    captures_user_content: false,
    bounded_metric_labels: true,
    service_name: OBS_SERVICE_NAME,
    environment: OBS_ENV,
  }
}

export function recordToolOutcome(params: {
  toolName: string
  args: Record<string, unknown>
  result?: unknown
  error?: unknown
  durationMs: number
  runtime: RuntimeRequestContext
  invocationId: string
  status?: ToolEventStatus
}) {
  const { toolName, args, result, error, durationMs, runtime, invocationId } = params
  const payload = result ? parseResultPayload(result) : undefined
  const toolContract = getToolContract(toolName)
  const network = extractNetwork(payload)
  const vm = classifyVm(toolName, args, payload)
  const status = params.status ?? classifyToolOutcome({ result, error })
  const errorDescriptor = error !== undefined ? describeToolError(error) : resultErrorDescriptor(result)
  const resultState = classifyToolResultState({ status, result })
  const errorOrigin = errorDescriptor?.origin ?? (status === 'request_error' ? 'unknown' : 'none')
  const errorCode = errorDescriptor?.code ?? 'none'
  const client = normalizeClientIdentity(runtime.clientName, runtime.clientVersion)
  const responseSizeBytes = result ? getResponseSizeBytes(result) : undefined
  const responseFormat =
    (typeof args.response_format === 'string' ? args.response_format : undefined) ??
    extractExecutionField(payload, 'response_format')
  const mode = (typeof args.mode === 'string' ? args.mode : undefined) ?? extractExecutionField(payload, 'mode')

  if (network) {
    datasetQueriesTotal.inc({ dataset: network, vm })
  }

  toolOutcomesTotal.inc({
    tool: toolName,
    status,
    result_state: resultState,
    error_origin: errorOrigin,
    error_code: errorCode,
    transport: runtime.transport,
    server_version: npmVersion,
  })

  toolClientCallsTotal.inc({
    transport: runtime.transport,
    client_family: client.family,
    client_major: client.major,
    toolset: runtime.toolsetLabel ?? 'all',
  })

  if (toolContract?.intent) {
    toolIntentCallsTotal.inc({
      tool: toolName,
      intent: toolContract.intent,
      vm,
    })
  }

  if (responseSizeBytes !== undefined) {
    toolResponseSizeBytes.observe({ tool: toolName, transport: runtime.transport }, responseSizeBytes)
  }

  if (errorDescriptor && (status === 'tool_error' || status === 'request_error')) {
    toolErrorsTotal.inc({
      tool: toolName,
      transport: runtime.transport,
      error_type: errorDescriptor.code,
    })
  }

  const event: ObservabilityEvent = {
    event: 'mcp_tool_call',
    timestamp: new Date().toISOString(),
    invocation_id: invocationId,
    ...(runtime.requestId ? { request_id: runtime.requestId } : {}),
    ...currentTraceIds(),
    transport: runtime.transport,
    ...(runtime.protocolVersion ? { protocol_version: runtime.protocolVersion } : {}),
    server_version: npmVersion,
    tool: toolName,
    ...(toolContract?.audience ? { audience: toolContract.audience } : {}),
    ...(toolContract?.category ? { category: toolContract.category } : {}),
    ...(toolContract?.intent ? { intent: toolContract.intent } : {}),
    ...(vm ? { vm } : {}),
    ...(network ? { network } : {}),
    client_family: client.family,
    client_major: client.major,
    duration_ms: durationMs,
    status,
    result_state: resultState,
    error_origin: errorOrigin,
    error_code: errorCode,
    ...(responseSizeBytes !== undefined ? { response_size_bytes: responseSizeBytes } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(mode ? { mode } : {}),
    args_summary: summarizeArgs(args),
    ...(errorDescriptor
      ? {
          error: {
            code: errorDescriptor.code,
            origin: errorDescriptor.origin,
            summary: truncateText(sanitizeText(errorDescriptor.summary), 280),
            retryable: errorDescriptor.retryable,
            ...(errorDescriptor.retryAfterMs !== undefined ? { retry_after_ms: errorDescriptor.retryAfterMs } : {}),
          },
        }
      : {}),
  }

  emitObservabilityEvent(event)
}
