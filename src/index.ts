#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createPortalServer } from './server.js'

// ============================================================================
// SQD Portal MCP Server - Node.js Entry Point
// ============================================================================

const server = createPortalServer()

const transport = new StdioServerTransport()
await server.connect(transport)

console.error('SQD Portal MCP Server running on stdio')
