import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { toolCallDuration, toolCallsActive, toolCallsTotal } from './metrics.js'
import { createInvocationId, recordToolOutcome, type RuntimeRequestContext } from './observability.js'
import { registerSchemaResource } from './resources/schema.js'
import { registerAllTools } from './tools/index.js'
import { npmVersion } from './version.js'

// ============================================================================
// Server Factory
// ============================================================================

export function createPortalServer(runtimeContext: RuntimeRequestContext = { transport: 'stdio' }): McpServer {
  const server = new McpServer({
    name: 'sqd-portal-mcp-server',
    version: npmVersion,
  })

  // Wrap server.tool() to automatically instrument all tools with metrics
  const originalTool = server.tool.bind(server)

  // biome-ignore lint: any needed to wrap overloaded server.tool() signatures
  ;(server as any).tool = (...args: any[]) => {
    const handler = args[args.length - 1] as (...handlerArgs: any[]) => Promise<any>
    const toolName = args[0] as string

    args[args.length - 1] = async (...handlerArgs: any[]) => {
      const invocationId = createInvocationId()
      const startedAt = Date.now()
      const end = toolCallDuration.startTimer({ tool: toolName, transport: runtimeContext.transport })
      toolCallsActive.inc({ tool: toolName, transport: runtimeContext.transport })
      const toolArgs = (handlerArgs[0] && typeof handlerArgs[0] === 'object' ? handlerArgs[0] : {}) as Record<string, unknown>
      try {
        const result = await handler(...handlerArgs)
        toolCallsTotal.inc({ tool: toolName, status: 'success', transport: runtimeContext.transport, server_version: npmVersion })
        recordToolOutcome({
          toolName,
          args: toolArgs,
          result,
          durationMs: Date.now() - startedAt,
          runtime: runtimeContext,
          invocationId,
        })
        return result
      } catch (error) {
        toolCallsTotal.inc({ tool: toolName, status: 'error', transport: runtimeContext.transport, server_version: npmVersion })
        recordToolOutcome({
          toolName,
          args: toolArgs,
          error,
          durationMs: Date.now() - startedAt,
          runtime: runtimeContext,
          invocationId,
        })
        throw error
      } finally {
        end()
        toolCallsActive.dec({ tool: toolName, transport: runtimeContext.transport })
      }
    }

    return originalTool(...(args as Parameters<typeof server.tool>))
  }

  // Register resources
  registerSchemaResource(server)

  // Register all tools
  registerAllTools(server)

  return server
}
