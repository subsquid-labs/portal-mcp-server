import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { getLogFields } from '../../helpers/field-presets.js'
import { buildEvmLogFields, buildEvmTraceFields, buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { type ResponseFormat, applyResponseFormat } from '../../helpers/response-modes.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import {
  formatBlockRangeWarning,
  getQueryExamples,
  normalizeAddresses,
  validateQuerySize,
} from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Logs (EVM)
// ============================================================================

export function registerQueryLogsTool(server: McpServer) {
  server.tool(
    'portal_query_logs',
    `Query event logs from EVM chains. Filter by contract address, event signature (topic0), and indexed parameters. Use field_preset and response_format to control response size.`,
    {
      dataset: z.string().describe('Dataset name or alias'),
      timeframe: z
        .string()
        .optional()
        .describe(
          "Time range (e.g., '24h', '7d'). Alternative to from_block/to_block. Supported: 1h, 6h, 12h, 24h, 3d, 7d, 14d, 30d",
        ),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z
        .number()
        .optional()
        .describe(
          'Ending block number. RECOMMENDED: <10k blocks for fast (<1s) responses. Larger ranges may be slow or timeout.',
        ),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      addresses: z
        .array(z.string())
        .optional()
        .describe(
          "Contract addresses to filter (e.g., ['0xUSDC...', '0xDAI...']). IMPORTANT: Always include this or topics for fast queries.",
        ),
      topic0: z
        .array(z.string())
        .optional()
        .describe(
          'Event signatures (topic0). E.g., Transfer = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        ),
      topic1: z
        .array(z.string())
        .optional()
        .describe('Topic1 filter (often: from address in Transfer, indexed parameter 1)'),
      topic2: z
        .array(z.string())
        .optional()
        .describe('Topic2 filter (often: to address in Transfer, indexed parameter 2)'),
      topic3: z.array(z.string()).optional().describe('Topic3 filter (indexed parameter 3, chain-specific)'),
      limit: z
        .number()
        .max(200)
        .optional()
        .default(20)
        .describe('Max logs to return (default: 20, max: 1000). Note: Lower default for MCP to reduce context usage.'),
      field_preset: z
        .enum(['minimal', 'standard', 'full'])
        .optional()
        .default('standard')
        .describe(
          "Field preset: 'minimal' (address+topic0+block, ~80% smaller), 'standard' (all topics+timestamp), 'full' (includes raw data hex, largest). Use 'minimal' to reduce context usage.",
        ),
      response_format: z
        .enum(['full', 'compact', 'summary'])
        .optional()
        .default('full')
        .describe(
          "Response format: 'summary' (~95% smaller, aggregated stats only), 'compact' (~70% smaller, strips verbose fields), 'full' (complete data). Use 'summary' for counting/categorizing.",
        ),
      include_transaction: z.boolean().optional().default(false).describe('Include parent transaction data'),
      include_transaction_traces: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include traces for parent transactions'),
      include_transaction_logs: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include all logs from parent transactions'),
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      finalized_only,
      addresses,
      topic0,
      topic1,
      topic2,
      topic3,
      limit,
      field_preset,
      response_format,
      include_transaction,
      include_transaction_traces,
      include_transaction_logs,
    }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_query_logs is only for EVM chains')
      }

      // Resolve timeframe or use explicit blocks
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const normalizedAddresses = normalizeAddresses(addresses, chainType)
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const includeL2 = isL2Chain(dataset)

      // Validate query size to prevent crashes
      const blockRange = endBlock - resolvedFromBlock
      const hasFilters = !!(normalizedAddresses || topic0 || topic1 || topic2 || topic3)

      const validation = validateQuerySize({
        blockRange,
        hasFilters,
        queryType: 'logs',
        limit: limit ?? 100,
      })

      if (!validation.valid) {
        // Add examples to help user fix the query
        const examples = !hasFilters ? getQueryExamples('logs') : ''
        throw new Error(validation.error + examples)
      }

      // Warn about potentially slow queries
      if (validation.warning) {
        console.error(formatBlockRangeWarning(resolvedFromBlock, endBlock, 'logs', hasFilters))
      }

      const logFilter: Record<string, unknown> = {}
      if (normalizedAddresses) logFilter.address = normalizedAddresses
      if (topic0) logFilter.topic0 = topic0
      if (topic1) logFilter.topic1 = topic1
      if (topic2) logFilter.topic2 = topic2
      if (topic3) logFilter.topic3 = topic3
      if (include_transaction) logFilter.transaction = true
      if (include_transaction_traces) logFilter.transactionTraces = true
      if (include_transaction_logs) logFilter.transactionLogs = true

      // Use field preset to control response size
      const presetFields = getLogFields(field_preset || 'standard')
      const fields: Record<string, unknown> = { ...presetFields }

      // Add transaction/trace fields if requested
      if (include_transaction || include_transaction_traces || include_transaction_logs) {
        fields.transaction = buildEvmTransactionFields(includeL2)
      }
      if (include_transaction_traces) {
        fields.trace = buildEvmTraceFields()
      }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields,
        logs: [logFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        stopAfterItems: {
          keys: ['logs'],
          limit,
        },
      })

      const allLogs = results.flatMap((block: unknown) => (block as { logs?: unknown[] }).logs || [])

      // Apply limit after collecting all results
      const limitedLogs = allLogs.slice(0, limit)

      // Apply response format (summary/compact/full)
      const formattedData = applyResponseFormat(limitedLogs, response_format || 'full', 'logs')

      const message =
        response_format === 'summary'
          ? `Log summary for ${limitedLogs.length} logs`
          : `Retrieved ${limitedLogs.length} logs${allLogs.length > limit ? ` (total found: ${allLogs.length})` : ''}`

      return formatResult(formattedData, message, {
        maxItems: limit,
        warnOnTruncation: false,
        metadata: {
          dataset,
          from_block: resolvedFromBlock,
          to_block: endBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
