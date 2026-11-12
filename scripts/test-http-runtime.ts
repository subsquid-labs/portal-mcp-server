#!/usr/bin/env tsx

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { type Server, createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const PORT = 3197
const BASE_URL = `http://localhost:${PORT}`
const METRICS_TOKEN = 'test-metrics-token'
const OBS_USER_QUERY_SECRET = 'obs-user-query-secret'

let child: ChildProcessWithoutNullStreams | undefined
let portalFixture: Server | undefined
let portalFixtureUrl = ''
let cancelledUpstreamRequests = 0
let appIsolationStreamRequests = 0
let activeAppIsolationStreams = 0
let peakAppIsolationStreams = 0
let catalogAvailable = false
let catalogRequests = 0
let probeRequests = 0
const upstreamTraceparents: string[] = []
const stderrChunks: string[] = []

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`)
      if (response.ok) return
    } catch {
      // keep polling until the child is ready
    }
    await sleep(150)
  }
  throw new Error('HTTP server did not become healthy')
}

async function startPortalFixture() {
  portalFixture = createServer((req, res) => {
    if (req.url === '/datasets') {
      probeRequests += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{ dataset: 'base-mainnet' }]))
      return
    }
    if (req.url?.startsWith('/datasets?')) {
      catalogRequests += 1
      if (!catalogAvailable) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'catalog fixture not available yet' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            dataset: 'base-mainnet',
            aliases: ['base'],
            metadata: { kind: 'evm', display_name: 'Base' },
            schema: { tables: {} },
          },
          {
            dataset: 'slow-mainnet',
            aliases: ['slow'],
            metadata: { kind: 'evm', display_name: 'Slow fixture' },
            schema: { tables: {} },
          },
        ]),
      )
      return
    }
    if (req.url === '/datasets/base-mainnet/head') {
      const traceparent = req.headers.traceparent
      if (typeof traceparent === 'string') upstreamTraceparents.push(traceparent)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ number: 1_000, hash: `0x${'1'.repeat(64)}` }))
      return
    }
    if (req.url === '/datasets/base-mainnet/finalized-head') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ number: 999, hash: `0x${'3'.repeat(64)}` }))
      return
    }
    if (req.url === '/datasets/base-mainnet/metadata') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ start_block: 0 }))
      return
    }
    if (req.url === '/datasets/slow-mainnet/head') {
      req.on('close', () => {
        cancelledUpstreamRequests += 1
      })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' })
      res.flushHeaders()
      return
    }
    if (req.method === 'POST' && req.url === '/datasets/base-mainnet/stream') {
      req.resume()
      appIsolationStreamRequests += 1
      activeAppIsolationStreams += 1
      peakAppIsolationStreams = Math.max(peakAppIsolationStreams, activeAppIsolationStreams)
      res.once('finish', () => {
        activeAppIsolationStreams -= 1
      })
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.end(
          `${JSON.stringify({
            header: { number: 1_000, hash: `0x${'1'.repeat(64)}`, timestamp: 1_775_000_000 },
            transactions: [
              {
                transactionIndex: 0,
                hash: `0x${'2'.repeat(64)}`,
                from: '0x1111111111111111111111111111111111111111',
                to: '0x2222222222222222222222222222222222222222',
                value: '0x0',
                gas: '0x5208',
                gasUsed: '0x5208',
                effectiveGasPrice: '0x1',
                input: '0x',
                nonce: 1,
                status: 1,
                type: 2,
              },
            ],
          })}\n`,
        )
      }, 75)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `fixture route not found: ${req.method ?? 'UNKNOWN'} ${req.url ?? '/'}` }))
  })
  await new Promise<void>((resolve) => portalFixture!.listen(0, '127.0.0.1', resolve))
  const address = portalFixture.address()
  assert(address && typeof address === 'object', 'Portal fixture should expose a TCP address')
  portalFixtureUrl = `http://127.0.0.1:${address.port}`
}

function parseSseJson(text: string) {
  const dataLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: '))
  assert(Boolean(dataLine), `Expected SSE data line, got: ${text.slice(0, 240)}`)
  return JSON.parse(dataLine!.slice('data: '.length))
}

async function postRpc(id: number, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-mcp-user-query': `this header must be ignored ${OBS_USER_QUERY_SECRET}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const text = await response.text()
  assert(response.ok, `RPC ${method} should return HTTP 2xx, got ${response.status}: ${text.slice(0, 240)}`)
  const parsed = parseSseJson(text)
  assert(!parsed.error, `RPC ${method} returned JSON-RPC error: ${JSON.stringify(parsed.error)}`)
  return parsed
}

async function assertPublicHttpSurface() {
  const health = await fetch(`${BASE_URL}/health`)
  assert(health.ok, `Public /health should stay reachable, got ${health.status}`)
  const healthPayload = (await health.json()) as Record<string, any>
  assert(
    healthPayload.observability?.captures_user_content === false,
    'Runtime should explicitly report that observability does not capture user content',
  )
  assert(
    typeof healthPayload.commit === 'string' && /^(unknown|[0-9a-f]{7,40})$/.test(healthPayload.commit),
    '/health must name the exact commit the server was built from, or unknown outside an image build',
  )
  /* The Explorer's rollback plan says an operator restarts the process and
     reads this field to see whether the flip took. This run sets nothing, so
     the field has to be there and has to say off. */
  assert(
    healthPayload.app?.enabled === false && healthPayload.app?.stage === 'beta',
    `/health must report the deployment's Explorer setting, got ${JSON.stringify(healthPayload.app)}`,
  )

  const tools = await fetch(`${BASE_URL}/tools`)
  assert(tools.status === 404, `Retired duplicate /tools endpoint should return 404, got ${tools.status}`)

  const publicMcp = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/list', params: {} }),
  })
  assert(publicMcp.ok, `Anonymous MCP POST should stay available in v0.8.0, got ${publicMcp.status}`)
}

async function assertModernHttpProtocol() {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: {
      headers: {
        'x-mcp-client-name': 'ignored-header-value',
        'x-mcp-client-version': '999.999.999',
      },
    },
  })
  const client = new Client(
    { name: 'codex', version: '0.8.0' },
    { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5_000 } } },
  )

  await client.connect(transport)
  try {
    assert(client.getProtocolEra() === 'modern', `HTTP should negotiate modern era, got ${client.getProtocolEra()}`)
    assert(
      client.getNegotiatedProtocolVersion() === '2026-07-28',
      `HTTP should negotiate 2026-07-28, got ${client.getNegotiatedProtocolVersion()}`,
    )
    const { tools } = await client.listTools()
    assert(tools.length === 31, `Modern HTTP tools/list expected 31 tools, got ${tools.length}`)
    const result = await client.callTool({ name: 'portal_get_head', arguments: { network: 'base' } })
    assert(!result.isError, 'Modern HTTP portal_get_head should succeed')

    const cancellation = new AbortController()
    setTimeout(() => cancellation.abort(), 50)
    const startedAt = Date.now()
    await client
      .callTool(
        { name: 'portal_get_head', arguments: { network: 'slow' } },
        { signal: cancellation.signal, timeout: 2_000 },
      )
      .then(() => {
        throw new Error('Cancelled HTTP tool call unexpectedly succeeded')
      })
      .catch((error) => {
        assert(
          error instanceof Error && /abort|cancel/i.test(`${error.name}: ${error.message}`),
          `Cancelled HTTP call should reject as cancellation, got ${String(error)}`,
        )
      })
    assert(Date.now() - startedAt < 750, 'HTTP cancellation should complete within 750ms')

    const cancellationDeadline = Date.now() + 750
    while (cancelledUpstreamRequests === 0 && Date.now() < cancellationDeadline) await sleep(20)
    assert(cancelledUpstreamRequests === 1, 'HTTP cancellation should close the active upstream request exactly once')

    const recovery = await client.callTool({ name: 'portal_get_head', arguments: { network: 'base' } })
    assert(!recovery.isError, 'The same HTTP client should recover immediately after cancellation')
  } finally {
    await client.close()
  }
}

function assertListedAppState(tools: Record<string, any>[], enabled: boolean, label: string) {
  const visualTool = tools.find((tool) => tool.name === 'portal_evm_query_transactions')
  assert(Boolean(visualTool), `${label} should list portal_evm_query_transactions`)
  const meta = visualTool?._meta as Record<string, any> | undefined
  if (enabled) {
    assert(Boolean(meta?.['ui/resourceUri']), `${label} should expose the opted-in App resource URI`)
    assert(meta?.ui?.resourceUri, `${label} should expose the standard App metadata`)
  } else {
    assert(meta?.ui?.resourceUri === undefined, `${label} must not expose standard App metadata`)
    assert(meta?.['ui/resourceUri'] === undefined, `${label} must not expose the App resource URI alias`)
    assert(meta?.['openai/outputTemplate'] === undefined, `${label} must not expose the ChatGPT App template alias`)
    assert(!visualTool?.description?.includes('MCP APP:'), `${label} must not expose the App description suffix`)
  }
}

async function assertHttpAppIsolation() {
  const clients = [
    {
      label: 'default connection',
      enabled: false,
      transport: new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
        requestInit: { headers: { 'X-Forwarded-For': '198.51.100.1' } },
      }),
      client: new Client({ name: 'sqd-app-default-http', version: '1.0.0' }),
    },
    {
      label: 'explicit app=0 connection',
      enabled: false,
      transport: new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp?app=0`), {
        requestInit: { headers: { 'X-Forwarded-For': '198.51.100.2' } },
      }),
      client: new Client({ name: 'sqd-app-disabled-http', version: '1.0.0' }),
    },
    {
      label: 'explicit app=1 connection',
      enabled: true,
      transport: new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp?app=1`), {
        requestInit: { headers: { 'X-Forwarded-For': '198.51.100.3' } },
      }),
      client: new Client({ name: 'sqd-app-enabled-http', version: '1.0.0' }),
    },
  ]

  await Promise.all(clients.map(({ client, transport }) => client.connect(transport)))
  try {
    const initialTools = await Promise.all(clients.map(({ client }) => client.listTools()))
    initialTools.forEach(({ tools }, index) => {
      const expected = clients[index]
      assertListedAppState(tools as Record<string, any>[], expected.enabled, expected.label)
      const instructions = expected.client.getInstructions() ?? ''
      assert(
        instructions.includes('SQD Explorer') === expected.enabled,
        `${expected.label} instructions must ${expected.enabled ? '' : 'not '}mention SQD Explorer`,
      )
    })

    const toolArguments = { network: 'base', from_block: 1_000, to_block: 1_000, limit: 1 }
    const results = await Promise.all(
      clients.map(({ client }) => client.callTool({ name: 'portal_evm_query_transactions', arguments: toolArguments })),
    )
    assert(appIsolationStreamRequests === 3, 'all three App-isolation clients should reach the Portal fixture')
    assert(
      peakAppIsolationStreams >= 2,
      `App-isolation tools/call requests must overlap in flight, observed ${peakAppIsolationStreams}`,
    )
    results.forEach((result, index) => {
      assert(
        result.isError !== true,
        `${clients[index].label} App-isolation query should succeed: ${JSON.stringify(result.structuredContent ?? result.content)}`,
      )
      const structured = result.structuredContent as Record<string, any> | undefined
      assert(
        structured?._server?.name === 'SQD' && typeof structured?._server?.version === 'string',
        `${clients[index].label} result must preserve observable server identity`,
      )
      assert(
        Boolean(structured?._app) === clients[index].enabled,
        `${clients[index].label} result must ${clients[index].enabled ? '' : 'not '}expose _app`,
      )
    })

    const afterInterleave = await Promise.all(clients.map(({ client }) => client.listTools()))
    afterInterleave.forEach(({ tools }, index) =>
      assertListedAppState(
        tools as Record<string, any>[],
        clients[index].enabled,
        `${clients[index].label} after concurrent awaited calls`,
      ),
    )
  } finally {
    await Promise.allSettled(clients.map(({ client }) => client.close()))
  }
}

function getHelpMetricNames(metricsText: string): Set<string> {
  const names = new Set<string>()
  for (const line of metricsText.split('\n')) {
    const match = line.match(/^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) /)
    if (!match) continue
    const name = match[1]
    names.add(name)
    names.add(`${name}_bucket`)
    names.add(`${name}_sum`)
    names.add(`${name}_count`)
  }
  return names
}

async function assertDashboardMetricNames(metricsText: string) {
  const dashboard = JSON.parse(await readFile('grafana/portal-mcp-dashboard.json', 'utf8'))
  const emitted = getHelpMetricNames(metricsText)
  const missing = new Set<string>()

  function visit(value: unknown, datasource?: string) {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, datasource))
      return
    }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const currentDatasource = typeof record.datasource === 'string' ? record.datasource : datasource
    if (typeof record.expr === 'string' && currentDatasource !== '${DS_LOKI}') {
      for (const match of record.expr.matchAll(/\bmcp_[a-zA-Z0-9_:]+/g)) {
        if (!emitted.has(match[0])) missing.add(match[0])
      }
    }
    Object.values(record).forEach((entry) => visit(entry, currentDatasource))
  }

  visit(dashboard)
  assert(
    missing.size === 0,
    `Grafana dashboard references unknown Prometheus metrics: ${Array.from(missing).join(', ')}`,
  )
}

function assertUserContentNotCaptured() {
  const stderrText = stderrChunks.join('')
  assert(!stderrText.includes('"user_query"'), 'JSON runtime logs should never include forwarded user queries')
  assert(!stderrText.includes(OBS_USER_QUERY_SECRET), 'Ignored user-query headers should never enter telemetry')
}

type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function rawRequest(options: {
  method?: string
  path: string
  headers?: Record<string, string>
  body?: string
  chunked?: boolean
  port?: number
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port ?? PORT,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) {
      if (!options.chunked) req.setHeader('Content-Length', Buffer.byteLength(options.body))
      req.write(options.body)
    }
    req.end()
  })
}

async function assertRequestGuard() {
  for (const path of ['/health', '/ready', '/metrics', '/mcp', '/']) {
    const rebound = await rawRequest({ path, headers: { Host: 'attacker.example:3197' } })
    assert(rebound.status === 403, `${path} with a foreign Host should be 403, got ${rebound.status}`)
    assert(rebound.body.includes('"host_not_allowed"'), `${path} should name the Host rejection reason`)
  }

  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'tools/list', params: {} })
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

  const foreignOrigin = await rawRequest({
    method: 'POST',
    path: '/mcp',
    headers: { ...mcpHeaders, Origin: 'https://evil.example' },
    body: rpc,
  })
  assert(foreignOrigin.status === 403, `Foreign Origin should be 403, got ${foreignOrigin.status}`)
  assert(foreignOrigin.body.includes('"origin_not_allowed"'), 'Origin rejection should be named')

  const loopbackOrigin = await rawRequest({
    method: 'POST',
    path: '/mcp',
    headers: { ...mcpHeaders, Origin: 'http://localhost:4174' },
    body: rpc,
  })
  assert(loopbackOrigin.status === 200, `Loopback Origin should pass, got ${loopbackOrigin.status}`)

  const noOrigin = await rawRequest({ method: 'POST', path: '/mcp', headers: mcpHeaders, body: rpc })
  assert(noOrigin.status === 200, `A request without Origin should pass, got ${noOrigin.status}`)

  const foreignOriginHealth = await rawRequest({ path: '/health', headers: { Origin: 'https://evil.example' } })
  assert(foreignOriginHealth.status === 403, `Origin check must cover /health too, got ${foreignOriginHealth.status}`)
}

async function assertRequestLimits() {
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const oversized = await rawRequest({
    method: 'POST',
    path: '/mcp',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 902, method: 'tools/list', params: { pad: 'x'.repeat(70_000) } }),
  })
  assert(oversized.status === 413, `A body above MCP_MAX_BODY_BYTES should be 413, got ${oversized.status}`)
  assert(oversized.body.includes('"max_body_bytes":65536'), '413 should report the configured cap')

  const chunked = await rawRequest({
    method: 'POST',
    path: '/mcp',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 903, method: 'tools/list', params: {} }),
    chunked: true,
  })
  assert(chunked.status === 411, `A chunked body without Content-Length should be 411, got ${chunked.status}`)

  const withinLimit = await rawRequest({
    method: 'POST',
    path: '/mcp',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 904, method: 'tools/list', params: {} }),
  })
  assert(withinLimit.status === 200, `A normal body should still be served, got ${withinLimit.status}`)

  const slowHeader = await new Promise<{ closedAfterMs: number; response: string }>((resolve, reject) => {
    const startedAt = Date.now()
    let response = ''
    const socket = netConnect({ host: '127.0.0.1', port: PORT }, () => {
      socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: ')
    })
    socket.on('data', (chunk) => {
      response += chunk.toString()
    })
    socket.on('close', () => resolve({ closedAfterMs: Date.now() - startedAt, response }))
    socket.on('error', () => resolve({ closedAfterMs: Date.now() - startedAt, response }))
    setTimeout(() => {
      socket.destroy()
      reject(new Error('Slow-header connection was not closed by the server within 5 s'))
    }, 5_000).unref()
  })
  assert(
    slowHeader.closedAfterMs >= 500,
    `Slow-header client should live until headersTimeout, closed after ${slowHeader.closedAfterMs}ms`,
  )
  assert(
    slowHeader.response.startsWith('HTTP/1.1 408'),
    `Slow-header client should be told 408 before the close, got ${JSON.stringify(slowHeader.response)}`,
  )
}

async function listToolNames(options: { path?: string; headers?: Record<string, string>; port?: number }) {
  const response = await rawRequest({
    method: 'POST',
    path: options.path ?? '/mcp',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(options.headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 905, method: 'tools/list', params: {} }),
    port: options.port,
  })
  assert(response.status === 200, `tools/list should be 200, got ${response.status}`)
  const parsed = response.body.trimStart().startsWith('{') ? JSON.parse(response.body) : parseSseJson(response.body)
  return (parsed.result.tools as { name: string }[]).map((tool) => tool.name).sort()
}

async function rpcAs(userAgent: string | undefined, id: number, method: string, params: Record<string, unknown>) {
  const response = await rawRequest({
    method: 'POST',
    path: '/mcp',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(userAgent ? { 'User-Agent': userAgent } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  assert(response.status === 200, `${method} as ${userAgent ?? 'no User-Agent'} should be 200, got ${response.status}`)
  const parsed = response.body.trimStart().startsWith('{') ? JSON.parse(response.body) : parseSseJson(response.body)
  assert(!parsed.error, `${method} as ${userAgent ?? 'no User-Agent'} failed: ${JSON.stringify(parsed.error)}`)
  return parsed.result
}

async function assertOutputSchemaByUserAgent() {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ['openai-mcp/1.0.0', true],
    ['codex-mcp-client/0.167.0', true],
    ['node', true],
    ['Cursor/1.0.0', false],
    ['claude-code/2.1.321 (sdk-cli, agent-sdk/0.3.321)', false],
  ]
  let id = 910
  for (const [userAgent, expected] of cases) {
    const { tools } = (await rpcAs(userAgent, id++, 'tools/list', {})) as { tools: Record<string, unknown>[] }
    const withSchema = tools.filter((tool) => tool.outputSchema !== undefined).length
    assert(
      withSchema === (expected ? tools.length : 0),
      `${userAgent ?? 'no User-Agent'} should ${expected ? 'list' : 'skip'} output schemas, got ${withSchema} of ${tools.length}`,
    )
  }

  const call = { name: 'portal_get_head', arguments: { network: 'base' } }
  const listed = (await rpcAs('codex-mcp-client/0.167.0', id++, 'tools/call', call)) as Record<string, any>
  const skipped = (await rpcAs('Cursor/1.0.0', id++, 'tools/call', call)) as Record<string, any>
  assert(
    listed.structuredContent?.answer !== undefined &&
      listed.structuredContent.answer === skipped.structuredContent?.answer &&
      JSON.stringify(Object.keys(listed.structuredContent).sort()) ===
        JSON.stringify(Object.keys(skipped.structuredContent ?? {}).sort()),
    'tools/call must return the same structuredContent whether or not the output schema was listed',
  )
  console.log('PASS  output schemas: listed for OpenAI and unidentified clients, skipped for Cursor and Claude')
}

async function assertToolsetNarrowing() {
  const all = await listToolNames({})
  assert(all.length === 31, `the default connection lists 31 tools, got ${all.length}`)
  const header = await listToolNames({ headers: { 'X-MCP-Toolsets': 'discovery' } })
  assert(
    header.length === 4 && header.includes('portal_list_networks'),
    `X-MCP-Toolsets: discovery should list 4 tools, got ${header.length}`,
  )
  const query = await listToolNames({ path: '/mcp?toolsets=evm' })
  assert(
    query.length === 8 && query.every((name) => name.startsWith('portal_evm_')),
    `?toolsets=evm should list the 8 EVM tools, got ${query.join(',')}`,
  )
  const unknown = await listToolNames({ headers: { 'X-MCP-Toolsets': 'nonsense' } })
  assert(unknown.length === 31, 'an unknown toolset name on a connection is ignored')

  const port = 20_000 + Math.floor(Math.random() * 10_000)
  const restricted = spawn('node', ['dist/http.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), PORTAL_URL: portalFixtureUrl, MCP_TOOLSETS: 'discovery' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    const deadline = Date.now() + 10_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok
      } catch {
        await sleep(100)
      }
    }
    assert(ready, 'the restricted server should start')
    const widened = await listToolNames({ headers: { 'X-MCP-Toolsets': 'discovery,evm' }, port })
    assert(widened.length === 4, `a connection must not widen the deployment set, got ${widened.length} tools`)
  } finally {
    restricted.kill()
  }
}

async function assertReadinessBeforeCatalog() {
  const notReady = await fetch(`${BASE_URL}/ready`)
  assert(notReady.status === 503, `/ready before the catalog loads should be 503, got ${notReady.status}`)
  assert(notReady.headers.get('retry-after') === '1', '503 /ready should carry Retry-After')
  const payload = (await notReady.json()) as Record<string, any>
  assert(payload.status === 'not_ready' && payload.reason === 'catalog_not_loaded', 'not_ready should name its reason')
  assert(typeof payload.last_probe_error === 'string', 'not_ready should carry the last probe error')
  const health = await fetch(`${BASE_URL}/health`)
  assert(health.status === 200, '/health stays 200 while /ready is 503')
}

async function assertReadinessAfterCatalog() {
  catalogAvailable = true
  const deadline = Date.now() + 10_000
  let ready: Record<string, any> | undefined
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE_URL}/ready`)
    if (response.status === 200) {
      ready = (await response.json()) as Record<string, any>
      break
    }
    await sleep(100)
  }
  assert(ready !== undefined, '/ready should turn 200 once the catalog loads')
  assert(ready.status === 'ready' && ready.catalog_datasets === 2, '/ready should report the loaded catalog')
  assert(typeof ready.last_probe_ok_at === 'string', '/ready should report the last successful probe')
  const probesBefore = probeRequests
  await sleep(700)
  assert(probeRequests > probesBefore, 'the readiness probe should keep polling Portal')
}

async function assertPublicBindWarning() {
  const warned = await new Promise<string>((resolve, reject) => {
    const probe = spawn('node', ['dist/http.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(20_000 + Math.floor(Math.random() * 10_000)),
        PORTAL_URL: portalFixtureUrl,
        MCP_BIND: '0.0.0.0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    probe.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.includes('MCP_ALLOWED_HOSTS is not set') && stderr.includes('MCP_ALLOWED_ORIGINS is not set')) {
        probe.kill()
        resolve(stderr)
      }
    })
    probe.on('exit', () => resolve(stderr))
    setTimeout(() => {
      probe.kill()
      reject(new Error('0.0.0.0 without an allowlist did not log a startup error within 10 s'))
    }, 10_000).unref()
  })
  assert(warned.includes('MCP_ALLOWED_HOSTS is not set'), 'Public bind without MCP_ALLOWED_HOSTS should log an error')
  assert(
    !stderrChunks.join('').includes('MCP_ALLOWED_HOSTS is not set'),
    'Loopback bind should need no allowlist configuration',
  )
}

/*
 * Two halves of the same claim: with no collector configured the
 * server must not have loaded, started, or reached anything, and with one
 * configured a tool call must arrive as a tree whose ids reach Portal.
 */
function assertTracingOffByDefault(health: Record<string, any>) {
  assert(
    health.tracing?.configured === false && health.tracing?.active === false,
    `/health should report tracing off with no endpoint set, got ${JSON.stringify(health.tracing)}`,
  )
  assert(health.tracing?.include_arguments === false, 'argument capture must be off unless asked for')
  const stderrText = stderrChunks.join('')
  assert(!stderrText.includes('[mcp:tracing]'), 'an unconfigured server should say nothing about tracing')
  const toolLines = stderrText.split('\n').filter((line) => line.includes('"event":"mcp_tool_call"'))
  assert(toolLines.length > 0, 'the run should have logged at least one tool call to check')
  assert(
    toolLines.every((line) => !line.includes('"trace_id"') && !line.includes('"span_id"')),
    'log lines should carry no trace ids when nothing is tracing',
  )
  assert(upstreamTraceparents.length === 0, 'an untraced server must not add a traceparent to a Portal request')
}

type OtlpSpan = {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  attributes?: { key: string; value: Record<string, unknown> }[]
}

async function assertTracingPropagation() {
  const spans: OtlpSpan[] = []
  const collector = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        for (const resourceSpan of payload.resourceSpans ?? []) {
          for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
            spans.push(...(scopeSpan.spans ?? []))
          }
        }
      } catch {
        // a body this test cannot read is a failed assertion below, not a crash
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve))
  const collectorPort = (collector.address() as { port: number }).port
  const port = 3199
  const before = upstreamTraceparents.length
  const traced = spawn('node', ['dist/http.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PORTAL_URL: portalFixtureUrl,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
      /* Flush fast enough that the test does not wait five seconds for a batch. */
      OTEL_BSP_SCHEDULE_DELAY: '100',
      OTEL_RESOURCE_DETECTORS: 'none',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  traced.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
  try {
    const deadline = Date.now() + 15_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok
      } catch {
        await sleep(100)
      }
    }
    assert(ready, `the traced server should start; stderr: ${stderr.slice(0, 400)}`)
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Record<string, any>
    assert(
      health.tracing?.configured === true && health.tracing?.active === true,
      `/health should report tracing active, got ${JSON.stringify(health.tracing)}`,
    )

    const client = new Client({ name: 'trace-probe', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } },
      }),
    )
    try {
      const result = await client.callTool({ name: 'portal_get_head', arguments: { network: 'base-mainnet' } })
      assert(!result.isError, `the traced tool call should succeed: ${JSON.stringify(result).slice(0, 600)}`)
    } finally {
      await client.close()
    }

    const spanDeadline = Date.now() + 10_000
    while (Date.now() < spanDeadline && !spans.some((span) => span.name === 'tools/call portal_get_head')) {
      await sleep(150)
    }
  } finally {
    traced.kill()
    await new Promise<void>((resolve) => collector.close(() => resolve()))
  }

  const names = spans.map((span) => span.name)
  const tool = spans.find((span) => span.name === 'tools/call portal_get_head')
  assert(Boolean(tool), `the collector should receive a tool span, got [${names.join(', ')}]`)
  /* Every POST in the session is its own request span, so the one that matters
     is the parent of the tool call rather than the first that arrived. */
  const request = spans.find((span) => span.name === 'mcp.request' && span.spanId === tool?.parentSpanId)
  assert(Boolean(request), `the tool span should hang off its own request span, got [${names.join(', ')}]`)
  /* The readiness prober also fetches from Portal, on no tool call and so in
     its own trace; the one this asserts on is the child of the tool span. */
  const fetchSpan = spans.find((span) => span.name === 'portal.fetch' && span.parentSpanId === tool?.spanId)
  assert(Boolean(fetchSpan), `the tool call's own Portal fetch should be a child span, got [${names.join(', ')}]`)
  assert(
    request?.traceId === traceId && tool?.traceId === traceId && fetchSpan?.traceId === traceId,
    `the caller traceparent should be joined, got ${request?.traceId} and ${tool?.traceId}`,
  )

  const rendered = JSON.stringify(spans.flatMap((span) => span.attributes ?? []))
  assert(!/0x[0-9a-fA-F]{40}/.test(rendered), 'no span attribute may carry an address')
  assert(!/"mcp\.tool\.arguments"/.test(rendered), 'arguments must stay off by default')
  assert(
    rendered.includes('"gen_ai.tool.name"') && rendered.includes('portal_get_head'),
    'the tool span should carry the attribute collectors group on',
  )

  const forwarded = upstreamTraceparents.slice(before)
  assert(forwarded.length > 0, 'a traced Portal request should carry a traceparent')
  assert(
    forwarded.every((value) => value.includes(traceId)),
    `the Portal request should carry this trace, got ${forwarded.join(', ')}`,
  )
}

async function main() {
  console.log('Starting HTTP runtime QA...\n')

  await startPortalFixture()

  child = spawn('node', ['dist/http.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      PORTAL_URL: portalFixtureUrl,
      METRICS_BEARER_TOKEN: METRICS_TOKEN,
      OBS_LOG_JSON: 'true',
      MCP_APP_ENABLED: 'false',
      MCP_MAX_BODY_BYTES: '65536',
      MCP_HEADERS_TIMEOUT_MS: '1000',
      MCP_READY_PROBE_INTERVAL_MS: '200',
      MCP_READY_MAX_AGE_MS: '2000',
      MCP_SLOW_REQUEST_MS: '1',
      /* The isolation clients emulate three callers behind a trusted proxy so
         per-caller fairness does not serialise them. */
      MCP_TRUST_PROXY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    stderrChunks.push(text)
    if (!text.includes('"event":"mcp_tool_call"') && !text.includes('"event":"mcp_slow_tool_call"')) {
      process.stderr.write(chunk)
    }
  })

  await waitForHealth()
  await assertReadinessBeforeCatalog()
  await assertReadinessAfterCatalog()
  await assertRequestGuard()
  await assertRequestLimits()
  await assertToolsetNarrowing()
  await assertPublicBindWarning()
  await assertPublicHttpSurface()
  await assertModernHttpProtocol()
  await assertHttpAppIsolation()
  await assertOutputSchemaByUserAgent()
  await postRpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'metrics-smoke', version: '1.0.0' },
  })
  await postRpc(2, 'tools/call', {
    name: 'portal_get_head',
    arguments: { network: 'base' },
  })
  await postRpc(3, 'tools/call', {
    name: 'portal_resolve_entity',
    arguments: { network: 'base-mainnet', kind: 'token', query: 'USDC', limit: 3 },
  })

  const anonymousMetrics = await fetch(`${BASE_URL}/metrics`)
  assert(anonymousMetrics.status === 401, `Anonymous /metrics should be blocked, got ${anonymousMetrics.status}`)

  const authorizedMetrics = await fetch(`${BASE_URL}/metrics`, {
    headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
  })
  assert(authorizedMetrics.ok, `Authorized /metrics should succeed, got ${authorizedMetrics.status}`)
  const metricsText = await authorizedMetrics.text()

  assert(metricsText.includes('mcp_server_info{'), 'Metrics should expose mcp_server_info')
  assert(
    metricsText.includes('mcp_tool_calls_total{tool="portal_get_head",status="success",transport="http"'),
    'Metrics should count the HTTP tool call',
  )
  assert(
    metricsText.includes('mcp_tool_client_calls_total{transport="http",client_family="openai",client_major="v0"'),
    'Metrics should attribute the protocol-declared client to a bounded family and major version',
  )
  assert(
    !metricsText.includes('ignored-header-value') && !metricsText.includes('999.999.999'),
    'Arbitrary HTTP headers should never become metric labels',
  )
  assert(
    metricsText.includes(
      'mcp_tool_outcomes_total{tool="portal_get_head",status="success",result_state="data",error_origin="none",error_code="none",transport="http"',
    ),
    'Metrics should expose a canonical attributable outcome for successful tool calls',
  )
  assert(
    metricsText.includes(
      'mcp_tool_outcomes_total{tool="portal_get_head",status="cancelled",result_state="cancelled",error_origin="transport",error_code="cancelled",transport="http"',
    ),
    'Metrics should attribute HTTP cancellation separately from tool failures',
  )
  assert(
    metricsText.includes('mcp_tool_calls_active{tool="portal_get_head",transport="http"} 0'),
    'Cancellation should restore the active tool gauge to zero',
  )
  assert(
    metricsText.includes('mcp_dataset_queries_total{dataset="base-mainnet",vm="evm"}'),
    'Dataset metrics should use canonical network and vm labels',
  )
  assert(
    !metricsText.includes('mcp_dataset_queries_total{dataset="base-mainnet"}'),
    'Dataset metrics should not emit unlabeled vm series',
  )
  assert(
    !metricsText.includes('mcp_dataset_queries_total{dataset="base",vm="evm"}'),
    'Dataset metrics should not use network aliases for successful calls',
  )
  assert(
    metricsText.includes('mcp_token_list_requests_total{source="coingecko_token_list",chain="base",status="success"'),
    'Metrics should count token-list fetch success',
  )
  assert(
    metricsText.includes('mcp_token_list_cache_events_total{source="coingecko_token_list",chain="base",event="'),
    'Metrics should expose token-list cache events',
  )

  assert(
    metricsText.includes('mcp_tool_admission_active_by_family{client_family="openai"} 0'),
    'Metrics should expose the per-family active admission gauge and return it to zero',
  )
  const slowLines = stderrChunks
    .join('')
    .split('\n')
    .filter((line) => line.includes('"event":"mcp_slow_tool_call"'))
  assert(slowLines.length > 0, 'a call above MCP_SLOW_REQUEST_MS should log a slow-call line')
  const slow = JSON.parse(slowLines[0]) as Record<string, unknown>
  assert(
    typeof slow.duration_ms === 'number' &&
      typeof slow.admission_wait_ms === 'number' &&
      typeof slow.execution_ms === 'number',
    'the slow-call line should carry phase timings',
  )
  assert(
    ['claude', 'openai', 'grok', 'gemini', 'cursor', 'unknown'].includes(String(slow.client_family)) &&
      !/127\.0\.0\.1|::1|[0-9a-f]{16}/.test(
        JSON.stringify({ ...slow, invocation_id: '', request_id: '', timestamp: '' }),
      ),
    'the slow-call line should carry a bounded client family and never an address or connection key',
  )
  assertUserContentNotCaptured()
  await assertDashboardMetricNames(metricsText)
  assertTracingOffByDefault((await (await fetch(`${BASE_URL}/health`)).json()) as Record<string, any>)
  await assertTracingPropagation()

  console.log('PASS  /health and MCP remain public with no client credential setup')
  console.log('PASS  MCP 2026-07-28 negotiates and calls tools over stateless HTTP')
  console.log('PASS  concurrent app=0, default, and app=1 clients keep metadata, instructions, and results isolated')
  console.log('PASS  HTTP cancellation closes upstream work and the same client recovers immediately')
  console.log('PASS  Retired duplicate /tools endpoint stays removed')
  console.log('PASS  observability ignores forwarded user content and arbitrary client headers')
  console.log('PASS  /metrics blocks anonymous access and accepts bearer auth')
  console.log('PASS  /metrics emits canonical outcome, client, Portal, dataset, and token-list series')
  console.log('PASS  Grafana dashboard Prometheus metric names match emitted metrics')
  console.log('PASS  /ready is 503 with Retry-After until the catalog loads, then 200 while Portal probes succeed')
  console.log('PASS  foreign Host and Origin are 403 on every route; loopback and missing Origin pass')
  console.log('PASS  oversized bodies are 413, chunked bodies 411, slow-header clients are disconnected')
  console.log('PASS  binding 0.0.0.0 without an allowlist logs a startup error; loopback needs no configuration')
  console.log('PASS  ?toolsets= and X-MCP-Toolsets narrow a connection and never widen the deployment set')
  console.log('PASS  slow tool calls log bounded phase timings; per-family admission gauge returns to zero')
  console.log('PASS  no collector configured means no trace ids, no traceparent to Portal, and nothing loaded')
  console.log('PASS  a configured collector receives one tree per call, joins the caller trace, and reaches Portal')
  console.log('\nHTTP runtime QA passed')
}

main()
  .catch((error) => {
    console.error('HTTP runtime QA failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    child?.kill()
    portalFixture?.close()
  })
