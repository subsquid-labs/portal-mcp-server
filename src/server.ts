import { CLIENT_INFO_META_KEY, McpServer, type ServerContext } from '@modelcontextprotocol/server'

import {
  classifyUiCapability,
  isActivityExplorerEnabled,
  isActivityExplorerEnabledByDeployment,
  recordActivityExplorerResult,
  registerActivityExplorerResource,
  runWithActivityExplorerSurface,
} from './apps/activity-explorer.js'
import { RequestCancelledError } from './helpers/errors.js'
import { attachEvidenceReceipt } from './helpers/evidence-receipt.js'
import { runWithGuardrailScope } from './helpers/guardrails.js'
import { PORTAL_TOOL_NAMES, listsOutputSchemaFor, runWithOutputSchemaListing } from './helpers/mcp-registration.js'
import { runWithPortalRequestSignal } from './helpers/request-context.js'
import { getToolWorkProfile, toolAdmission } from './helpers/tool-admission.js'
import { formatToolError } from './helpers/tool-error.js'
import { registerInvestigationPromptsAndResources } from './investigations.js'
import { toolCallDuration, toolCallsActive, toolCallsTotal } from './metrics.js'
import {
  type RuntimeRequestContext,
  type ToolEventStatus,
  classifyClientFamily,
  classifyToolOutcome,
  createInvocationId,
  recordSlowToolCall,
  recordToolOutcome,
} from './observability.js'
import { registerSchemaResource } from './resources/schema.js'
import { registerAllTools } from './tools/index.js'
import {
  type ToolSelection,
  type Toolset,
  getActiveToolSelection,
  isToolEnabled,
  narrowToolSelection,
  resolveDeploymentToolSelection,
  runWithToolSelection,
  toolsetOf,
} from './toolsets.js'
import { recordChildSpan, recordToolSpan } from './tracing.js'
import { npmVersion } from './version.js'

// ============================================================================
// Server Factory
// ============================================================================

const PORTAL_BASE_INSTRUCTIONS =
  'SQD provides read-only blockchain data from SQD Portal. Start with portal_list_networks to resolve a network, then use portal_get_network_info to check availability and freshness. Check _coverage and _pagination before claiming completeness, and reuse _pagination.next_cursor when present.'

/* Only an opted-in deployment may point the model at the beta App. */
const PORTAL_APP_INSTRUCTIONS =
  ' Its MCP App is named SQD Explorer. A successful result from any tool whose _meta carries ui.resourceUri can open in the Explorer with exact charts, tables, timelines, coverage, freshness, and safe follow-ups; a result being App-ready is not proof that the host rendered it. To demonstrate the App, run a successful App-enabled tool and only say it rendered when the host confirms a render.'

/* Every example the App paragraph can offer, in the order it offers them. */
const PORTAL_APP_EXAMPLES: [tool: string, view: string][] = [
  ['portal_get_recent_activity', 'the activity view'],
  ['portal_hyperliquid_get_ohlc', 'the market chart'],
  ['portal_evm_get_analytics', 'the analytics dashboard'],
  ['portal_get_wallet_summary', 'the wallet view'],
]

/* The chain families the instructions can describe, each with the toolset that
   has to be registered for the claim to be true. */
const PORTAL_CHAIN_FAMILIES: [toolset: Toolset, description: string][] = [
  ['evm', 'Ethereum-compatible networks'],
  ['solana', 'Solana'],
  ['bitcoin', 'Bitcoin'],
  ['substrate', 'Polkadot and other Substrate networks'],
  ['hyperliquid', 'Hyperliquid'],
  ['tron', 'Tron'],
]

const PORTAL_TRIMMED_BASE_INSTRUCTIONS =
  'SQD provides read-only blockchain data from SQD Portal. This connection exposes a subset of the SQD tool catalog. Check _coverage and _pagination before claiming completeness, and reuse _pagination.next_cursor when present.'

function joinPhrases(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/*
 * The instructions are the first thing a model reads, and a tool named here
 * that this connection does not serve sends it straight into a
 * method-not-found. Every tool name below is emitted only when the selection
 * registers that tool, and every chain family only when the selection
 * registers at least one tool from it.
 */
export function getPortalServerInstructions(selection: ToolSelection = getActiveToolSelection()): string {
  const enabled = (tool: string) => isToolEnabled(selection, tool)

  const base =
    enabled('portal_list_networks') && enabled('portal_get_network_info')
      ? PORTAL_BASE_INSTRUCTIONS
      : PORTAL_TRIMMED_BASE_INSTRUCTIONS

  const appExamples = PORTAL_APP_EXAMPLES.filter(([tool]) => enabled(tool))
  const app = isActivityExplorerEnabled()
    ? PORTAL_APP_INSTRUCTIONS +
      (appExamples.length > 0 ? ` Use ${joinPhrases(appExamples.map(([tool, view]) => `${tool} for ${view}`))}.` : '')
    : ''

  // A toolset being in the selection is not the same as a tool from it being
  // registered: an exact-name MCP_TOOLS deployment keeps every toolset while
  // narrowing to a handful of tools, and the families were claimed anyway.
  const familyHasATool = (toolset: Toolset) =>
    PORTAL_TOOL_NAMES.some((tool) => toolsetOf(tool) === toolset && isToolEnabled(selection, tool))
  const families = PORTAL_CHAIN_FAMILIES.filter(([toolset]) => familyHasATool(toolset)).map(([toolset, description]) =>
    toolset === 'tron' && enabled('portal_tron_query_transactions') && enabled('portal_tron_query_logs')
      ? `${description} (native TRX transfers, TRC-10 transfers, contract calls, and TRC-20 event logs through portal_tron_query_transactions and portal_tron_query_logs; addresses may be given as Base58 or hex)`
      : description,
  )
  const network =
    families.length > 0
      ? ` Chain-specific MCP query tools cover ${joinPhrases(families)}. Prefer timeframe for recent windows and from_block/to_block for exact evidence. No authentication is required.`
      : ' Prefer timeframe for recent windows and from_block/to_block for exact evidence. No authentication is required.'

  return base + app + network
}

/* Resolved once per process; a connection may only narrow it. */
const DEPLOYMENT_TOOL_SELECTION = resolveDeploymentToolSelection(process.env)
for (const warning of DEPLOYMENT_TOOL_SELECTION.warnings) {
  console.error(`[mcp:toolsets] ${warning}`)
}

export function getDeploymentToolSelection(): ToolSelection {
  return DEPLOYMENT_TOOL_SELECTION
}

export function createPortalServer(runtimeContext: RuntimeRequestContext = { transport: 'stdio' }): McpServer {
  const appEnabled = runtimeContext.appEnabled ?? isActivityExplorerEnabledByDeployment()
  const selection = narrowToolSelection(DEPLOYMENT_TOOL_SELECTION, runtimeContext.toolsets)
  const context: RuntimeRequestContext = { ...runtimeContext, toolsetLabel: selection.label }
  return runWithActivityExplorerSurface(appEnabled, () =>
    runWithToolSelection(selection, () =>
      runWithOutputSchemaListing(listsOutputSchemaFor(runtimeContext.userAgent), () =>
        buildPortalServer(context, appEnabled),
      ),
    ),
  )
}

function buildPortalServer(runtimeContext: RuntimeRequestContext, appEnabled: boolean): McpServer {
  const server = new McpServer(
    {
      name: 'sqd-portal-mcp-server',
      version: npmVersion,
    },
    {
      instructions: getPortalServerInstructions(),
    },
  )

  function instrumentToolHandler<TArgs extends unknown[]>(
    toolName: string,
    handler: (...handlerArgs: TArgs) => Promise<unknown>,
  ) {
    return async (...handlerArgs: TArgs) => {
      const invocationId = createInvocationId()
      const startedAt = Date.now()
      const end = toolCallDuration.startTimer({ tool: toolName, transport: runtimeContext.transport })
      let admitted = false
      let releaseAdmission: (() => void) | undefined
      const extraCandidate = handlerArgs[handlerArgs.length - 1]
      const requestContext =
        extraCandidate && typeof extraCandidate === 'object' && 'mcpReq' in extraCandidate
          ? (extraCandidate as ServerContext)
          : undefined
      const toolArgs = (
        handlerArgs.length > 1 && handlerArgs[0] && typeof handlerArgs[0] === 'object' ? handlerArgs[0] : {}
      ) as Record<string, unknown>
      const requestSignal = requestContext?.mcpReq.signal
      const envelope = requestContext?.mcpReq.envelope as Record<string, unknown> | undefined
      const envelopeClient = envelope?.[CLIENT_INFO_META_KEY]
      const declaredClient =
        envelopeClient && typeof envelopeClient === 'object'
          ? (envelopeClient as { name?: unknown; version?: unknown })
          : server.server.getClientVersion()
      const effectiveRuntime: RuntimeRequestContext = {
        ...runtimeContext,
        clientName: typeof declaredClient?.name === 'string' ? declaredClient.name : runtimeContext.clientName,
        clientVersion:
          typeof declaredClient?.version === 'string' ? declaredClient.version : runtimeContext.clientVersion,
        protocolVersion: server.server.getNegotiatedProtocolVersion(),
      }
      /* A host that traces its own turn puts W3C trace context in the tool
         call `_meta`; over HTTP the request span has already picked it up from
         the header, and this overrides it when the client is more specific. */
      const metaTraceparent = typeof envelope?.traceparent === 'string' ? envelope.traceparent : undefined
      const metaTracestate = typeof envelope?.tracestate === 'string' ? envelope.tracestate : undefined
      const uiCapability = classifyUiCapability(envelope, server.server.getClientCapabilities())
      const clientFamily = classifyClientFamily(effectiveRuntime.clientName)
      /* stdio has exactly one caller, so it is counted but never share-limited;
         the fair share protects the hosted HTTP endpoint. */
      const caller = {
        /* Keyed on the connection alone. The family is what the client calls
           itself, so including it let one connection claim a share per name
           it declared. It stays on the metric label, where it is a bounded
           description of the traffic rather than a claim to more budget. */
        key: runtimeContext.connectionKey ?? runtimeContext.transport,
        family: clientFamily,
        exempt: runtimeContext.transport === 'stdio',
      }
      let admissionWaitMs = 0
      const noteSlowCall = (status: ToolEventStatus) =>
        recordSlowToolCall({
          toolName,
          durationMs: Date.now() - startedAt,
          admissionWaitMs,
          status,
          runtime: effectiveRuntime,
          invocationId,
        })

      return recordToolSpan(
        {
          tool: toolName,
          workClass: getToolWorkProfile(toolName).class,
          runtimeContext: effectiveRuntime,
          traceparent: metaTraceparent,
          tracestate: metaTracestate,
          args: toolArgs,
        },
        async (span) => {
          try {
            const lease = await recordChildSpan(
              'mcp.admission',
              { 'mcp.tool.work_class': getToolWorkProfile(toolName).class },
              () =>
                toolAdmission.acquire(getToolWorkProfile(toolName), runtimeContext.transport, requestSignal, caller),
            )
            admissionWaitMs = lease.waitMs
            span.setAttribute('mcp.admission.wait_ms', lease.waitMs)
            releaseAdmission = lease.release
            admitted = true
            toolCallsActive.inc({ tool: toolName, transport: runtimeContext.transport })
            /* Handlers run outside the factory's scope, so the connection's
               app choice is re-entered here for the result formatters. */
            const handlerResult = await runWithActivityExplorerSurface(appEnabled, () =>
              runWithPortalRequestSignal(requestSignal, () =>
                runWithGuardrailScope({ tool: toolName, workClass: getToolWorkProfile(toolName).class }, () =>
                  handler(...handlerArgs),
                ),
              ),
            )
            /* Hashing the result for the evidence receipt is real work on a
               large answer, and it happens after every fetch has returned, so
               it is worth its own span rather than unexplained tail. */
            const result = await recordChildSpan('mcp.format_result', {}, async () =>
              attachEvidenceReceipt(toolName, toolArgs, handlerResult),
            )
            const status = classifyToolOutcome({ result })
            toolCallsTotal.inc({
              tool: toolName,
              status,
              transport: runtimeContext.transport,
              server_version: npmVersion,
            })
            recordToolOutcome({
              toolName,
              args: toolArgs,
              result,
              durationMs: Date.now() - startedAt,
              runtime: effectiveRuntime,
              invocationId,
              status,
            })
            recordActivityExplorerResult({
              toolName,
              result,
              transport: runtimeContext.transport,
              uiCapability,
              resultState: status,
            })
            noteSlowCall(status)
            span.setOutcome(status)
            return result
          } catch (error) {
            const cancelled = requestSignal?.aborted || error instanceof RequestCancelledError
            const status = cancelled ? 'cancelled' : 'tool_error'
            noteSlowCall(status)
            const toolErrorResult = cancelled ? undefined : formatToolError(error, toolName)
            toolCallsTotal.inc({
              tool: toolName,
              status,
              transport: runtimeContext.transport,
              server_version: npmVersion,
            })
            recordToolOutcome({
              toolName,
              args: toolArgs,
              ...(cancelled ? { error: new RequestCancelledError() } : { result: toolErrorResult }),
              durationMs: Date.now() - startedAt,
              runtime: effectiveRuntime,
              invocationId,
              status,
            })
            recordActivityExplorerResult({
              toolName,
              result: toolErrorResult,
              transport: runtimeContext.transport,
              uiCapability,
              resultState: status,
            })
            span.setOutcome(status, cancelled ? undefined : error instanceof Error ? error.constructor.name : 'Error')
            if (cancelled) throw error
            return toolErrorResult
          } finally {
            end()
            if (admitted) toolCallsActive.dec({ tool: toolName, transport: runtimeContext.transport })
            releaseAdmission?.()
          }
        },
      )
    }
  }

  // Instrument the single MCP SDK v2 registration surface used by every tool.
  const originalRegisterTool = server.registerTool.bind(server)

  ;(server as any).registerTool = (...args: any[]) => {
    const toolName = args[0] as string
    const handler = args[2] as ((...handlerArgs: any[]) => Promise<any>) | undefined

    if (typeof handler === 'function') {
      args[2] = instrumentToolHandler(toolName, handler)
    }

    return originalRegisterTool(
      ...(args as [string, Parameters<typeof server.registerTool>[1], Parameters<typeof server.registerTool>[2]]),
    )
  }

  // Register resources
  registerSchemaResource(server)
  registerInvestigationPromptsAndResources(server)
  registerActivityExplorerResource(server, runtimeContext)

  // Register all tools
  registerAllTools(server)

  return server
}
