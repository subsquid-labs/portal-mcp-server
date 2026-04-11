import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { toolCallDuration, toolCallsActive, toolCallsTotal } from './metrics.js'
import { createInvocationId, recordToolOutcome, type RuntimeRequestContext } from './observability.js'
import { registerAppResources } from './resources/apps.js'
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

  function instrumentToolHandler<TArgs extends unknown[]>(toolName: string, handler: (...handlerArgs: TArgs) => Promise<unknown>) {
    return async (...handlerArgs: TArgs) => {
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
  }

  // Wrap server.tool() and server.registerTool() to automatically instrument all tools with metrics
  const originalTool = server.tool.bind(server)
  const originalRegisterTool = server.registerTool.bind(server)

  // biome-ignore lint: any needed to wrap overloaded server.tool() signatures
  ;(server as any).tool = (...args: any[]) => {
    const handler = args[args.length - 1] as (...handlerArgs: any[]) => Promise<any>
    const toolName = args[0] as string

    args[args.length - 1] = instrumentToolHandler(toolName, handler)

    return originalTool(...(args as Parameters<typeof server.tool>))
  }

  // biome-ignore lint: any needed to wrap generic registerTool() signature
  ;(server as any).registerTool = (...args: any[]) => {
    const toolName = args[0] as string
    const handler = args[2] as ((...handlerArgs: any[]) => Promise<any>) | undefined

    if (typeof handler === 'function') {
      args[2] = instrumentToolHandler(toolName, handler)
    }

    return originalRegisterTool(...(args as [string, Parameters<typeof server.registerTool>[1], Parameters<typeof server.registerTool>[2]]))
  }

  // Register resources
  registerSchemaResource(server)
  registerAppResources(server)

  // Register all tools
  registerAllTools(server)

  return server
}
