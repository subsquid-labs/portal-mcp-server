import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'

import { toNodeHandler } from '@modelcontextprotocol/node'
import { type McpHandlerRequestOptions, type McpRequestContext, createMcpHandler } from '@modelcontextprotocol/server'

import {
  extractDeclaredUiCapabilityFromBody,
  getActivityExplorerDeploymentMode,
  isActivityExplorerEnabledByDeployment,
  parseExplicitActivityExplorerQueryFlag,
  resolveActivityExplorerSurface,
} from './apps/activity-explorer.js'
import { ENDPOINT_PAGE_HEADERS, renderEndpointPage, wantsEndpointPage } from './endpoint-page.js'
import { hasConfiguredCursorSecret } from './helpers/pagination.js'
import { runWithPortalRequestSignal } from './helpers/request-context.js'
import {
  connectionKeyFromRequest,
  evaluateBodyLimit,
  evaluateRequestGuard,
  isTrustedPeer,
  parseTrustedProxyPrefixes,
  readPositiveInt,
  readTrustedProxyCount,
  resolveRequestGuardPolicy,
} from './http-guard.js'
import { register } from './metrics.js'
import { type RuntimeRequestContext, getObservabilityStatus } from './observability.js'
import { createReadinessTracker } from './readiness.js'
import { createPortalServer } from './server.js'
import { SERVER_CARD_HEADERS, buildServerCard } from './server-card.js'
import { requestedToolsetsFromRequest } from './toolsets.js'
import { recordRequestSpan, startTracing, stopTracing, tracingStatus } from './tracing.js'
import { gitCommit, npmVersion } from './version.js'

// ============================================================================
// SQD Portal MCP Server - Node.js HTTP Entry Point
// ============================================================================

const PORT = Number(process.env.PORT) || 3000
const METRICS_PUBLIC = process.env.METRICS_PUBLIC === 'true'
const METRICS_BEARER_TOKEN = process.env.METRICS_BEARER_TOKEN

// Request bounds. Timeouts are Node's own server timers; the body cap is checked
// against Content-Length before the MCP handler reads a byte.
const REQUEST_TIMEOUT_MS = readPositiveInt(process.env.MCP_REQUEST_TIMEOUT_MS, 120_000)
const HEADERS_TIMEOUT_MS = readPositiveInt(process.env.MCP_HEADERS_TIMEOUT_MS, 30_000)
const KEEP_ALIVE_TIMEOUT_MS = readPositiveInt(process.env.MCP_KEEP_ALIVE_TIMEOUT_MS, 65_000)
const MAX_BODY_BYTES = readPositiveInt(process.env.MCP_MAX_BODY_BYTES, 1024 * 1024)
const READY_PROBE_INTERVAL_MS = readPositiveInt(process.env.MCP_READY_PROBE_INTERVAL_MS, 30_000)
const READY_MAX_AGE_MS = readPositiveInt(process.env.MCP_READY_MAX_AGE_MS, 90_000)
const TRUSTED_PROXIES = readTrustedProxyCount(process.env.MCP_TRUST_PROXY)
const TRUSTED_PROXY_PREFIXES = parseTrustedProxyPrefixes(process.env.MCP_TRUSTED_PROXY_PREFIXES)
const SAFE_HOST_AUTHORITY = /^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/

function parseConfiguredPublicOrigin(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined
  try {
    const parsed = new URL(raw.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

const PUBLIC_ORIGIN = parseConfiguredPublicOrigin(process.env.MCP_PUBLIC_ORIGIN)

function resolveServerCardOrigin(req: IncomingMessage): string | undefined {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN
  const rawHost = readHeader(req, 'host')?.trim()
  if (!rawHost || !SAFE_HOST_AUTHORITY.test(rawHost)) return undefined
  const trustedProxy = TRUSTED_PROXIES > 0 && isTrustedPeer(req.socket.remoteAddress, TRUSTED_PROXY_PREFIXES)
  const forwardedProto = trustedProxy
    ? readHeader(req, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    : undefined
  const scheme = forwardedProto === 'https' ? 'https' : 'http'
  return `${scheme}://${rawHost}`
}
// Internal header carrying the hashed connection key from the Node layer to the
// MCP handler; any client-supplied value is overwritten.
const CONNECTION_KEY_HEADER = 'x-sqd-connection-key'

/* Nothing is imported, allocated, or sent unless OTEL_EXPORTER_OTLP_ENDPOINT
   is set; see src/tracing.ts. Awaited here so the first request is traced. */
await startTracing({ serviceName: 'sqd-portal-mcp-server', serviceVersion: npmVersion })

const guardPolicy = resolveRequestGuardPolicy(process.env)
for (const warning of guardPolicy.warnings) {
  console.error(`[mcp:http] ${warning}`)
}

/* Without a configured key each process signs cursors with its own random one,
   so a cursor issued by one instance is rejected by the next. That is safe but
   it is not what an operator running more than one process wants, and the
   failure would otherwise surface as clients randomly losing their place. */
if (!hasConfiguredCursorSecret()) {
  console.error(
    '[mcp:http] MCP_CURSOR_SECRET is not set. Cursors are signed with a per-process key, so pagination will not survive a restart or work across instances. Set it to a random secret shared by every instance.',
  )
}

const readiness = createReadinessTracker({ probeIntervalMs: READY_PROBE_INTERVAL_MS, maxAgeMs: READY_MAX_AGE_MS })

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value[0] : undefined
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function readBearerToken(req: IncomingMessage): string | undefined {
  const authorization = readHeader(req, 'authorization')
  if (!authorization) return undefined
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}

function isMetricsAuthorized(req: IncomingMessage): boolean {
  if (METRICS_PUBLIC) return true
  if (!METRICS_BEARER_TOKEN) return false
  const token = readBearerToken(req)
  return Boolean(token && safeEqual(token, METRICS_BEARER_TOKEN))
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

const requestUiDeclaredStorage = new AsyncLocalStorage<boolean>()

function runtimeContextFromRequest(ctx: McpRequestContext): RuntimeRequestContext {
  const headers = ctx.requestInfo?.headers
  const uiDeclared = requestUiDeclaredStorage.getStore() ?? false

  return {
    transport: 'http',
    requestId: headers?.get('x-request-id') || undefined,
    protocolVersion: ctx.era === 'modern' ? '2026-07-28' : undefined,
    appEnabled: resolveActivityExplorerSurface(ctx.requestInfo, { uiDeclared }),
    toolsets: requestedToolsetsFromRequest(ctx.requestInfo),
    connectionKey: headers?.get(CONNECTION_KEY_HEADER) || undefined,
    userAgent: headers?.get('user-agent') || undefined,
  }
}

const mcpHandler = createMcpHandler((ctx) => createPortalServer(runtimeContextFromRequest(ctx)), {
  legacy: 'stateless',
  responseMode: 'auto',
  maxRequestBodySize: MAX_BODY_BYTES,
  onerror(error) {
    console.error('[mcp:http]', error)
  },
})

const handleMcpRequest = toNodeHandler(
  {
    async fetch(request: Request, options?: McpHandlerRequestOptions) {
      let uiDeclared = false
      const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
      if (
        request.method === 'POST' &&
        contentType.includes('application/json') &&
        getActivityExplorerDeploymentMode() === 'auto' &&
        parseExplicitActivityExplorerQueryFlag({ url: request.url }) === undefined
      ) {
        try {
          const body = await request.clone().json()
          uiDeclared = extractDeclaredUiCapabilityFromBody(body)
        } catch {
          uiDeclared = false
        }
      }
      return requestUiDeclaredStorage.run(uiDeclared, () => mcpHandler.fetch(request, options))
    },
  },
  {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror(error) {
      console.error('[mcp:http-adapter]', error)
    },
  },
)

const server = createServer(
  {
    // Node only enforces headersTimeout and requestTimeout on this interval, so keep it
    // short enough that a slow-header client is dropped soon after the deadline.
    connectionsCheckingInterval: Math.max(250, Math.min(30_000, Math.floor(HEADERS_TIMEOUT_MS / 2))),
  },
  async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    const requestId = readHeader(req, 'x-request-id') || randomUUID()
    req.headers['x-request-id'] = requestId
    res.setHeader('x-request-id', requestId)
    req.headers[CONNECTION_KEY_HEADER] = connectionKeyFromRequest(
      { remoteAddress: req.socket.remoteAddress, forwardedFor: readHeader(req, 'x-forwarded-for') },
      TRUSTED_PROXIES,
      TRUSTED_PROXY_PREFIXES,
    )

    // Host and Origin allowlist first, on every route, so a DNS-rebound browser page
    // cannot reach health, readiness, metrics, or MCP.
    const guard = evaluateRequestGuard(
      { host: readHeader(req, 'host'), origin: readHeader(req, 'origin') },
      guardPolicy,
    )
    if (!guard.allowed) {
      sendJson(res, 403, { error: 'Forbidden', reason: guard.reason })
      return
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        version: npmVersion,
        commit: gitCommit,
        observability: getObservabilityStatus(),
        tracing: tracingStatus(),
        /* The deployment's setting, not this request's: an operator turning the
           Explorer on or off restarts the process and needs to see whether the
           restart took. A caller's own `?app=1` or `?app=0` is answered on the
           MCP connection, not here. */
        app: {
          enabled: isActivityExplorerEnabledByDeployment(),
          mode: getActivityExplorerDeploymentMode(),
          stage: 'beta',
        },
      })
      return
    }

    if (url.pathname === '/.well-known/mcp/server-card.json' || url.pathname === '/.well-known/mcp') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Accept, Content-Type',
          'Cache-Control': 'public, max-age=300',
        })
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD, OPTIONS' })
        res.end(JSON.stringify({ error: 'Method not allowed' }))
        return
      }
      const payload = JSON.stringify(buildServerCard({ origin: resolveServerCardOrigin(req) }), null, 2)
      res.writeHead(200, SERVER_CARD_HEADERS)
      res.end(req.method === 'HEAD' ? undefined : payload)
      return
    }

    if (url.pathname === '/ready') {
      const snapshot = readiness.snapshot()
      if (snapshot.ready) {
        sendJson(res, 200, { status: 'ready', version: npmVersion, commit: gitCommit, ...snapshot })
        return
      }
      sendJson(
        res,
        503,
        { status: 'not_ready', version: npmVersion, commit: gitCommit, ...snapshot },
        { 'Retry-After': String(Math.max(1, Math.ceil(READY_PROBE_INTERVAL_MS / 1000))) },
      )
      return
    }

    if (url.pathname === '/metrics') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' })
        res.end(JSON.stringify({ error: 'Method not allowed' }))
        return
      }

      if (!isMetricsAuthorized(req)) {
        const isTokenConfigured = Boolean(METRICS_BEARER_TOKEN)
        res.writeHead(isTokenConfigured ? 401 : 404, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(isTokenConfigured ? { 'WWW-Authenticate': 'Bearer realm="metrics"' } : {}),
        })
        res.end(JSON.stringify({ error: isTokenConfigured ? 'Unauthorized' : 'Not found' }))
        return
      }

      res.writeHead(200, { 'Content-Type': register.contentType, 'Cache-Control': 'no-store' })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(await register.metrics())
      return
    }

    if (url.pathname === '/' || url.pathname === '/mcp') {
      // A GET here is answered by Accept: a page for browsers, the transport's 405 for the rest.
      if (req.method === 'GET' || req.method === 'HEAD') res.setHeader('Vary', 'Accept')
      if (wantsEndpointPage(req.method, readHeader(req, 'accept'))) {
        res.writeHead(200, ENDPOINT_PAGE_HEADERS)
        res.end(req.method === 'HEAD' ? undefined : renderEndpointPage(npmVersion))
        return
      }
      const bodyLimit = evaluateBodyLimit(
        {
          'content-length': readHeader(req, 'content-length'),
          'transfer-encoding': readHeader(req, 'transfer-encoding'),
        },
        req.method,
        MAX_BODY_BYTES,
      )
      if (!bodyLimit.ok) {
        sendJson(
          res,
          bodyLimit.status,
          {
            error: bodyLimit.status === 413 ? 'Payload too large' : 'Length required',
            reason: bodyLimit.reason,
            max_body_bytes: MAX_BODY_BYTES,
          },
          { Connection: 'close' },
        )
        return
      }
      /* Propagate client socket disconnects to in-flight Portal fetches and
         retry waits so abandoned HTTP requests stop consuming upstream work. */
      const disconnectController = new AbortController()
      const onResponseClose = () => {
        if (!res.writableEnded) disconnectController.abort()
      }
      res.once('close', onResponseClose)
      try {
        /* One span per MCP request, parented to the caller's own trace when the
           header carries one. Tool spans hang off it, so a batched request is a
           single tree rather than a handful of unrelated roots. */
        await runWithPortalRequestSignal(disconnectController.signal, () =>
          recordRequestSpan(
            {
              method: req.method ?? 'POST',
              transport: 'http',
              traceparent: readHeader(req, 'traceparent'),
              tracestate: readHeader(req, 'tracestate'),
            },
            () => handleMcpRequest(req, res),
          ),
        )
      } finally {
        res.off('close', onResponseClose)
      }
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  },
)

server.requestTimeout = REQUEST_TIMEOUT_MS
server.headersTimeout = HEADERS_TIMEOUT_MS
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS

server.listen(PORT, guardPolicy.bind, () => {
  console.log(`SQD Portal MCP Server listening on http://${guardPolicy.bind}:${PORT}`)
  readiness.start()
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('Shutting down...')
  readiness.stop()
  await mcpHandler.close()
  await stopTracing()
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
