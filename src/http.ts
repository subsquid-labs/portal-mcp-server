import { createServer } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { PORTAL_URL } from './constants/index.js'
import { createPortalServer } from './server.js'
import { npmVersion } from './version.js'

// ============================================================================
// SQD Portal MCP Server - Node.js HTTP Entry Point
// ============================================================================

const PORT = Number(process.env.PORT) || 3000

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  // Health check endpoint
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        version: npmVersion,
        portal_url: PORTAL_URL,
      }),
    )
    return
  }

  // MCP endpoint
  if (url.pathname === '/mcp') {
    if (req.method === 'POST') {
      try {
        const mcpServer = createPortalServer()
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

    // GET and DELETE not supported in stateless mode
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

  // Default response
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(
    `SQD Portal MCP Server v${npmVersion}\n\nEndpoints:\n- GET /health - Health check\n- POST /mcp - MCP protocol endpoint`,
  )
})

server.listen(PORT, () => {
  console.log(`SQD Portal MCP Server listening on http://localhost:${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/health`)
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`)
})

process.on('SIGINT', () => {
  console.log('Shutting down...')
  server.close()
  process.exit(0)
})
