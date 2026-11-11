import { AsyncLocalStorage } from 'node:async_hooks'

import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  RegisteredTool,
  ServerContext,
} from '@modelcontextprotocol/server'
import { type ZodRawShape, z } from 'zod'

import { getActivityExplorerToolMeta } from '../apps/activity-explorer.js'
import { classifyClientFamily } from '../observability.js'
import { isToolActive } from '../toolsets.js'
import { runWithPortalRequestDeadline } from './request-context.js'

type PortalToolResult = CallToolResult | InputRequiredResult

const PORTAL_TOOL_TITLES: Record<string, string> = {
  portal_list_networks: 'Find blockchain networks',
  portal_get_network_info: 'Check network status',
  portal_get_head: 'Get the latest block',
  portal_resolve_entity: 'Find a token or contract',
  portal_get_recent_activity: 'View recent blockchain activity',
  portal_get_wallet_summary: 'Review wallet activity',
  portal_get_time_series: 'Chart blockchain activity',
  portal_substrate_query_events: 'Find Polkadot events',
  portal_substrate_query_calls: 'Find Polkadot calls',
  portal_substrate_get_analytics: 'Analyze Polkadot activity',
  portal_evm_query_transactions: 'Find Ethereum and Base transactions',
  portal_evm_query_logs: 'Find smart contract events',
  portal_evm_query_traces: 'Find internal calls and contract creations',
  portal_evm_query_token_transfers: 'Find token transfers',
  portal_evm_get_contract_deployment: 'Find a contract deployment',
  portal_evm_get_contract_activity: 'Review smart contract activity',
  portal_evm_get_analytics: 'Analyze Ethereum and Base activity',
  portal_evm_get_ohlc: 'Chart token price history',
  portal_solana_query_transactions: 'Find Solana transactions',
  portal_solana_query_instructions: 'Find Solana program activity',
  portal_solana_get_analytics: 'Analyze Solana activity',
  portal_bitcoin_query_transactions: 'Find Bitcoin transactions',
  portal_bitcoin_get_analytics: 'Analyze Bitcoin activity',
  portal_hyperliquid_query_fills: 'Find Hyperliquid trades',
  portal_hyperliquid_get_analytics: 'Analyze Hyperliquid trading',
  portal_hyperliquid_get_ohlc: 'Chart Hyperliquid prices',
  portal_tron_query_transactions: 'Find Tron transactions',
  portal_tron_query_logs: 'Find Tron contract events',
  portal_debug_query_blocks: 'Inspect raw blocks',
  portal_debug_resolve_time_to_block: 'Match a time to a block',
  portal_debug_hyperliquid_query_replica_commands: 'Inspect Hyperliquid command records',
}

/** Every public tool name, the one list toolset coverage is checked against. */
export const PORTAL_TOOL_NAMES: readonly string[] = Object.keys(PORTAL_TOOL_TITLES)

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const

/**
 * Every Portal tool returns the same machine-readable envelope around its
 * tool-specific blockchain data. The catchall is intentional: transaction,
 * log, analytics, and market-data tools expose different primary data keys,
 * while the documented envelope stays stable across the full catalog.
 *
 * This schema is serialised once per tool in tools/list, so every token here
 * is paid 31 times per session. Keep descriptions short and leave free-form
 * blocks untyped; `npm run test:catalog-tokens` guards the total.
 */
const PORTAL_TOOL_OUTPUT_SCHEMA = z
  .object({
    answer: z.string().optional().describe('Answer grounded in the returned data.'),
    display: z.unknown().optional().describe('Labels for presenting the result.'),
    next_steps: z.unknown().optional().describe('Safe follow-up actions and continuation guidance.'),
    items: z.array(z.unknown()).optional().describe('Primary rows for list results.'),
    value: z.unknown().optional().describe('Primary scalar result.'),
    investigation: z.unknown().optional().describe('Evidence paths, pivots, and limitations.'),
    error: z
      .object({
        code: z.string(),
        origin: z.string(),
        summary: z.string(),
        retryable: z.boolean(),
        retry_after_ms: z.number().optional(),
        suggestions: z.array(z.string()),
      })
      .catchall(z.unknown())
      .optional()
      .describe('Structured failure details.'),
    _meta: z.unknown().optional().describe('Network, block range, timing, and row counts.'),
    _summary: z.string().optional().describe('Human-readable summary.'),
    _tool_contract: z.unknown().optional().describe('Tool identity, intent, and chain families.'),
    _pagination: z.unknown().optional().describe('Pagination state and next_cursor.'),
    _ordering: z.unknown().optional().describe('Ordering guarantees.'),
    _freshness: z.unknown().optional().describe('Freshness and finality.'),
    _coverage: z.unknown().optional().describe('Window and result completeness.'),
    _evidence: z.unknown().optional().describe('Replayable arguments, digest, row count, and receipt.'),
    _execution: z.unknown().optional().describe('Bounded execution and scan details.'),
    _ui: z.unknown().optional().describe('Chart, table, and follow-up presentation metadata.'),
    _app: z.unknown().optional().describe('SQD Explorer identity and host-render state.'),
    _server: z
      .object({
        name: z.string(),
        version: z.string(),
        commit: z.string(),
      })
      .optional()
      .describe('SQD server name, exact version, and git commit.'),
    pipes_handoff: z.unknown().optional().describe('SQD Pipes guidance for custom data needs.'),
    _notice: z.string().optional().describe('Limitation or truncation notice.'),
    _notices: z.array(z.string()).optional().describe('Limitation or truncation notices.'),
    _llm: z.unknown().optional().describe('Hints to locate the primary evidence.'),
  })
  .catchall(z.unknown())

/*
 * The shared output schema is about 40% of tools/list. The OpenAI listing,
 * which ChatGPT and Codex share, is reviewed against it; other hosts only pay
 * for it. A client whose User-Agent names another known host skips it, and
 * its results are identical because every structuredContent is an object.
 * Anything unidentified keeps the schema, so a wrong or missing User-Agent
 * costs tokens, never behaviour.
 */
const OUTPUT_SCHEMA_SKIPPING_FAMILIES = new Set(['claude', 'cursor', 'grok', 'gemini', 'vscode', 'windsurf'])
const outputSchemaListing = new AsyncLocalStorage<boolean>()

export function listsOutputSchemaFor(userAgent: string | undefined): boolean {
  return !OUTPUT_SCHEMA_SKIPPING_FAMILIES.has(classifyClientFamily(userAgent))
}

export function runWithOutputSchemaListing<T>(enabled: boolean, callback: () => T): T {
  return outputSchemaListing.run(enabled, callback)
}

function getPortalToolTitle(name: string): string {
  const title = PORTAL_TOOL_TITLES[name]
  if (name.startsWith('__test_')) return name.slice('__test_'.length).replaceAll('_', ' ')
  if (!title) throw new Error(`Missing public title for MCP tool: ${name}`)
  return title
}

/**
 * Registers Portal's concise Zod raw shapes through the MCP SDK v2 schema API.
 * Keeping this translation in one place lets every tool use the modern API
 * without duplicating schema wrapping or reaching into SDK internals.
 */
export function registerPortalTool<InputShape extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputShape: InputShape,
  handler: (
    args: z.infer<z.ZodObject<InputShape>>,
    context: ServerContext,
  ) => PortalToolResult | Promise<PortalToolResult>,
  options?: { deadlineMs?: number },
): RegisteredTool | undefined {
  // A tool outside the active toolset selection is never registered, so
  // discovery still comes from this one registry.
  if (!isToolActive(name)) return undefined
  const deadlineMs = options?.deadlineMs
  const activityExplorerMeta = getActivityExplorerToolMeta(name)
  const boundedHandler =
    deadlineMs !== undefined
      ? (args: z.infer<z.ZodObject<InputShape>>, context: ServerContext) =>
          runWithPortalRequestDeadline(deadlineMs, async () => handler(args, context), { tool: name, stage: 'tool' })
      : handler

  return server.registerTool(
    name,
    {
      title: getPortalToolTitle(name),
      description,
      inputSchema: z.object(inputShape),
      ...((outputSchemaListing.getStore() ?? true) ? { outputSchema: PORTAL_TOOL_OUTPUT_SCHEMA } : {}),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      _meta: activityExplorerMeta,
    },
    boundedHandler,
  )
}
