import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { clientRequestsTotal } from './metrics.js'
import { getObservabilityStatus } from './observability.js'
import { register } from './metrics.js'
import { createPortalServer } from './server.js'
import { npmVersion } from './version.js'

// ============================================================================
// SQD Portal MCP Server - Node.js HTTP Entry Point
// ============================================================================

const PORT = Number(process.env.PORT) || 3000

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value[0] : undefined
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const requestId = readHeader(req, 'x-request-id') || randomUUID()
  res.setHeader('x-request-id', requestId)

  const userAgent = readHeader(req, 'user-agent')
  const clientName =
    readHeader(req, 'x-mcp-client-name')
    || readHeader(req, 'x-client-name')
    || 'unknown'
  const clientVersion =
    readHeader(req, 'x-mcp-client-version')
    || readHeader(req, 'x-client-version')
    || 'unknown'

  // Health check endpoint
  // NOTE: Do not expose PORTAL_URL here — it may contain a sensitive token
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        version: npmVersion,
        observability: getObservabilityStatus(),
      }),
    )
    return
  }

  // Prometheus metrics endpoint
  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': register.contentType })
    res.end(await register.metrics())
    return
  }

  // MCP endpoint
  if (url.pathname === '/') {
    if (req.method === 'POST') {
      try {
        clientRequestsTotal.inc({
          transport: 'http',
          client_name: clientName,
          client_version: clientVersion,
        })

        const mcpServer = createPortalServer({
          transport: 'http',
          requestId,
          clientName,
          clientVersion,
          sessionId: readHeader(req, 'x-mcp-session-id') || readHeader(req, 'x-session-id'),
          userQuery: readHeader(req, 'x-mcp-user-query'),
          userAgent,
          forwardedFor: readHeader(req, 'x-forwarded-for'),
        })
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        })

        await mcpServer.connect(transport)
        await transport.handleRequest(req, res)

        res.on('close', () => {
          transport.close()
          mcpServer.close()
        })
      } catch (error) {
        console.error('MCP error:', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : 'Internal server error',
              },
              id: null,
            }),
          )
        }
      }
      return
    }

    // GET and DELETE aren't supported in stateless mode
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    )
    return
  }
})

server.listen(PORT, () => {
  console.log(`SQD Portal MCP Server listening on http://localhost:${PORT}`)
})

process.on('SIGINT', () => {
  console.log('Shutting down...')
  server.close()
  process.exit(0)
})
