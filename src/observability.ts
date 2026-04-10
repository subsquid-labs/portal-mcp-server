import { datasetQueriesTotal, observabilityExportsTotal, toolErrorsTotal, toolIntentCallsTotal, toolResponseSizeBytes } from './metrics.js'
import { detectChainType } from './helpers/chain.js'
import { ActionableError } from './helpers/errors.js'
import { getToolContract } from './helpers/tool-ux.js'
import { npmVersion } from './version.js'

export type TransportKind = 'stdio' | 'http'

export type RuntimeRequestContext = {
  transport: TransportKind
  requestId?: string
  clientName?: string
  clientVersion?: string
  sessionId?: string
  userQuery?: string
  userAgent?: string
  forwardedFor?: string
}

type ToolEventStatus = 'success' | 'error'

type ObservabilityEvent = {
  event: 'mcp_tool_call'
  timestamp: string
  invocation_id: string
  request_id?: string
  session_id?: string
  transport: TransportKind
  server_version: string
  tool: string
  audience?: string
  category?: string
  intent?: string
  vm?: string
  network?: string
  client_name?: string
  client_version?: string
  user_agent?: string
  duration_ms: number
  status: ToolEventStatus
  response_size_bytes?: number
  response_format?: string
  mode?: string
  args_summary?: Record<string, unknown>
  user_query?: string
  error?: {
    type: string
    message: string
    actionable: boolean
  }
}

const OBS_SERVICE_NAME = process.env.OBS_SERVICE_NAME || 'sqd-portal-mcp'
const OBS_ENV = process.env.OBS_ENV || process.env.NODE_ENV || 'production'
const OBS_LOG_JSON = process.env.OBS_LOG_JSON === 'true'
const OBS_CAPTURE_USER_QUERY = process.env.OBS_CAPTURE_USER_QUERY === 'true'
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
  const content = asRecord(result)?.content
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
    (typeof args.network === 'string' ? args.network : undefined)
    ?? (typeof args.dataset === 'string' ? args.dataset : undefined)
    ?? (typeof payload?._meta === 'object' && payload._meta !== null && typeof (payload._meta as Record<string, unknown>).network === 'string'
      ? String((payload._meta as Record<string, unknown>).network)
      : undefined)
    ?? (typeof payload?._meta === 'object' && payload._meta !== null && typeof (payload._meta as Record<string, unknown>).dataset === 'string'
      ? String((payload._meta as Record<string, unknown>).dataset)
      : undefined)

  if (!candidateNetwork) return contract?.vm?.[0] ?? 'unknown'

  const chainType = detectChainType(candidateNetwork)
  if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') return 'hyperliquid'
  return chainType
}

function extractNetwork(args: Record<string, unknown>, payload?: Record<string, unknown>): string | undefined {
  const direct =
    (typeof args.network === 'string' ? args.network : undefined)
    ?? (typeof args.dataset === 'string' ? args.dataset : undefined)
  if (direct) return direct

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

function classifyErrorType(error: unknown): string {
  if (error instanceof ActionableError) return 'actionable'
  if (!(error instanceof Error)) return 'unknown'
  const message = error.message.toLowerCase()
  if (message.includes('timeout')) return 'timeout'
  if (message.includes('rate limited') || message.includes('(429')) return 'rate_limit'
  if (message.includes('reorganization') || message.includes('(409')) return 'reorg'
  if (message.includes('invalid request') || message.includes('(400')) return 'validation'
  if (message.includes('temporarily unavailable') || message.includes('(503')) return 'upstream_unavailable'
  if (message.includes('portal server error') || message.includes('portal api error (5')) return 'upstream_error'
  if (message.includes('not found') || message.includes('(404')) return 'not_found'
  return 'unknown'
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {}

  const scalarKeys = ['network', 'vm', 'timeframe', 'duration', 'interval', 'metric', 'mode', 'response_format', 'group_by', 'type']
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
  const message = error instanceof Error ? error.message : String(error)
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
    captures_forwarded_user_query: OBS_CAPTURE_USER_QUERY,
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
}) {
  const { toolName, args, result, error, durationMs, runtime, invocationId } = params
  const payload = result ? parseResultPayload(result) : undefined
  const toolContract = getToolContract(toolName)
  const network = extractNetwork(args, payload)
  const vm = classifyVm(toolName, args, payload)
  const status: ToolEventStatus = error ? 'error' : 'success'
  const responseSizeBytes = result ? getResponseSizeBytes(result) : undefined
  const responseFormat =
    (typeof args.response_format === 'string' ? args.response_format : undefined)
    ?? extractExecutionField(payload, 'response_format')
  const mode =
    (typeof args.mode === 'string' ? args.mode : undefined)
    ?? extractExecutionField(payload, 'mode')

  if (network) {
    datasetQueriesTotal.inc({ dataset: network, vm })
  }

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

  if (error) {
    toolErrorsTotal.inc({
      tool: toolName,
      transport: runtime.transport,
      error_type: classifyErrorType(error),
    })
  }

  const event: ObservabilityEvent = {
    event: 'mcp_tool_call',
    timestamp: new Date().toISOString(),
    invocation_id: invocationId,
    ...(runtime.requestId ? { request_id: runtime.requestId } : {}),
    ...(runtime.sessionId ? { session_id: runtime.sessionId } : {}),
    transport: runtime.transport,
    server_version: npmVersion,
    tool: toolName,
    ...(toolContract?.audience ? { audience: toolContract.audience } : {}),
    ...(toolContract?.category ? { category: toolContract.category } : {}),
    ...(toolContract?.intent ? { intent: toolContract.intent } : {}),
    ...(vm ? { vm } : {}),
    ...(network ? { network } : {}),
    ...(runtime.clientName ? { client_name: runtime.clientName } : {}),
    ...(runtime.clientVersion ? { client_version: runtime.clientVersion } : {}),
    ...(runtime.userAgent ? { user_agent: runtime.userAgent } : {}),
    duration_ms: durationMs,
    status,
    ...(responseSizeBytes !== undefined ? { response_size_bytes: responseSizeBytes } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(mode ? { mode } : {}),
    args_summary: summarizeArgs(args),
    ...(OBS_CAPTURE_USER_QUERY && runtime.userQuery ? { user_query: truncateText(runtime.userQuery, 400) } : {}),
    ...(error
      ? {
          error: {
            type: classifyErrorType(error),
            message: truncateText(error instanceof Error ? error.message : String(error), 280),
            actionable: error instanceof ActionableError,
          },
        }
      : {}),
  }

  emitObservabilityEvent(event)
}
