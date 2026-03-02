/**
 * Cloudflare Worker for SQD Portal MCP Server
 * Uses Web Standard Streamable HTTP transport
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { PORTAL_URL } from './constants/index.js'
import { createPortalServer } from './server.js'
import { npmVersion } from './version.js'

// ============================================================================
// SQD Portal MCP Server - Cloudflare Worker Entry Point
// ============================================================================

interface Env {
  PORTAL_URL?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const portalUrl = env.PORTAL_URL || PORTAL_URL

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: npmVersion,
          portal_url: portalUrl,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    // MCP endpoint using WebStandard transport
    if (url.pathname === '/mcp') {
      try {
        // Create MCP server with all tools registered
        const server = createPortalServer()

        // Create transport in stateless mode (no session management)
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless mode
          enableJsonResponse: false, // Use SSE for streaming
        })

        // Connect server to transport
        await server.connect(transport)

        // Handle the HTTP request
        const response = await transport.handleRequest(request)

        return response
      } catch (error) {
        console.error('MCP error:', error)
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Internal server error',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
    }

    // Default response
    return new Response(
      `SQD Portal MCP Server v${npmVersion}\n\nEndpoints:\n- GET /health - Health check\n- POST /mcp - MCP protocol endpoint`,
      {
        headers: { 'Content-Type': 'text/plain' },
      },
    )
  },
}
