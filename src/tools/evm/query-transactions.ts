import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { getTransactionFields } from '../../helpers/field-presets.js'
import {
  buildEvmLogFields,
  buildEvmStateDiffFields,
  buildEvmTraceFields,
  buildEvmTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatTransactionFields } from '../../helpers/formatting.js'
import { type ResponseFormat, applyResponseFormat } from '../../helpers/response-modes.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import {
  getQueryExamples,
  getValidationNotices,
  normalizeAddresses,
  validateQuerySize,
} from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Transactions (EVM)
// ============================================================================

function flattenTransactionsWithBlockContext(results: unknown[]) {
  return results.flatMap((block: unknown) => {
    const typedBlock = block as {
      number?: number
      timestamp?: number
      header?: {
        number?: number
        timestamp?: number
      }
      transactions?: Array<Record<string, unknown>>
    }

    const blockNumber = typedBlock.number ?? typedBlock.header?.number
    const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

    return (typedBlock.transactions || []).map((tx) =>
      formatTransactionFields({
        ...tx,
        ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
        ...(timestamp !== undefined
          ? {
              timestamp,
              timestamp_human: formatTimestamp(timestamp),
            }
          : {}),
      }),
    )
  })
}

export function registerQueryTransactionsTool(server: McpServer) {
  server.tool(
    'portal_query_transactions',
    `Query transactions from EVM chains. Filter by sender, recipient, or function signature. Unfiltered queries >100 blocks need limit <=100.`,
    {
      dataset: z.string().describe('Dataset name or alias'),
      timeframe: z
        .string()
        .optional()
        .describe(
          "Time range (e.g., '24h', '7d'). Alternative to from_block/to_block. Supported: 1h, 6h, 12h, 24h, 3d, 7d, 14d, 30d. Large ranges OK with low limit (<=100).",
        ),
      from_block: z
        .number()
        .optional()
        .describe('Starting block number (use this OR timeframe). Large ranges OK with low limit (<=100).'),
      to_block: z
        .number()
        .optional()
        .describe(
          'Ending block number. RECOMMENDED: <5k blocks for fast (<500ms) responses. Larger ranges may be slow.',
        ),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      from_addresses: z
        .array(z.string())
        .optional()
        .describe(
          'FILTER: Sender addresses (wallets or contracts that initiated the transaction). Optional if limit <=100.',
        ),
      to_addresses: z
        .array(z.string())
        .optional()
        .describe(
          'FILTER: Recipient addresses (typically contracts being called, or wallets receiving ETH). Optional if limit <=100.',
        ),
      sighash: z
        .array(z.string())
        .optional()
        .describe("FILTER: Function sighash (4-byte hex, e.g., '0xa9059cbb' for transfer). Optional if limit <=100."),
      first_nonce: z.number().optional().describe('Minimum nonce'),
      last_nonce: z.number().optional().describe('Maximum nonce'),
      limit: z
        .number()
        .max(200)
        .optional()
        .default(20)
        .describe('Max transactions (default: 20, max: 1000). Note: Lower default for MCP to reduce context usage.'),
      field_preset: z
        .enum(['minimal', 'standard', 'full'])
        .optional()
        .default('standard')
        .describe(
          "Field preset: 'minimal' (from/to/value+block, ~70% smaller), 'standard' (hash+gas+timestamp), 'full' (includes input data hex, largest). Use 'minimal' to reduce context usage.",
        ),
      response_format: z
        .enum(['full', 'compact', 'summary'])
        .optional()
        .default('full')
        .describe(
          "Response format: 'summary' (~90% smaller, aggregated stats), 'compact' (~60% smaller, strips input/nonce), 'full' (complete data). Use 'summary' for counting/profiling.",
        ),
      include_logs: z.boolean().optional().default(false).describe('Include logs emitted by transactions'),
      include_traces: z.boolean().optional().default(false).describe('Include traces for transactions'),
      include_state_diffs: z.boolean().optional().default(false).describe('Include state diffs caused by transactions'),
      include_l2_fields: z.boolean().optional().default(false).describe('Include L2-specific fields'),
      // include_receipt removed: logsBloom is not in TransactionFieldSelection per OpenAPI spec
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      finalized_only,
      from_addresses,
      to_addresses,
      sighash,
      first_nonce,
      last_nonce,
      limit,
      field_preset,
      response_format,
      include_logs,
      include_traces,
      include_state_diffs,
      include_l2_fields,
    }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_query_transactions is only for EVM chains')
      }

      // Resolve timeframe or use explicit blocks
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const normalizedFrom = normalizeAddresses(from_addresses, chainType)
      const normalizedTo = normalizeAddresses(to_addresses, chainType)
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const includeL2 = include_l2_fields || isL2Chain(dataset)

      // Validate query size to prevent crashes
      const blockRange = endBlock - resolvedFromBlock
      const hasFilters = !!(normalizedFrom || normalizedTo || sighash)

      const validation = validateQuerySize({
        blockRange,
        hasFilters,
        queryType: 'transactions',
        limit: limit ?? 100,
      })

      if (!validation.valid) {
        // Add examples to help user fix the query
        const examples = !hasFilters ? getQueryExamples('transactions') : ''
        throw new Error(validation.error + examples)
      }

      const txFilter: Record<string, unknown> = {}
      if (normalizedFrom) txFilter.from = normalizedFrom
      if (normalizedTo) txFilter.to = normalizedTo
      if (sighash) txFilter.sighash = sighash
      if (first_nonce !== undefined) txFilter.firstNonce = first_nonce
      if (last_nonce !== undefined) txFilter.lastNonce = last_nonce
      if (include_logs) txFilter.logs = true
      if (include_traces) txFilter.traces = true
      if (include_state_diffs) txFilter.stateDiffs = true

      // Use field preset to control response size
      const presetFields = getTransactionFields(field_preset || 'standard')
      const fields: Record<string, unknown> = { ...presetFields }

      // Merge L2 fields if requested (but keep preset as base)
      if (include_l2_fields) {
        const additionalFields = buildEvmTransactionFields(includeL2)
        fields.transaction = {
          ...(fields.transaction as Record<string, boolean>),
          ...additionalFields,
        }
      }

      if (include_logs) {
        fields.log = buildEvmLogFields()
      }
      if (include_traces) {
        fields.trace = buildEvmTraceFields()
      }
      if (include_state_diffs) {
        fields.stateDiff = buildEvmStateDiffFields()
      }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields,
        transactions: [txFilter],
      }

      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['transactions'],
        limit,
        chunkSize: hasFilters ? 500 : 100,
      })

      const allTxs = flattenTransactionsWithBlockContext(results)
      const limitedTxs = allTxs.slice(-limit)

      // Apply response format (summary/compact/full)
      const formattedData = applyResponseFormat(limitedTxs, response_format || 'full', 'transactions')

      const message =
        response_format === 'summary'
          ? `Transaction summary for ${limitedTxs.length} transactions${allTxs.length > limit ? ' (latest preview)' : ''}`
          : `Retrieved ${limitedTxs.length} transactions${allTxs.length > limit ? ` from the most recent matching blocks (preview limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
        maxItems: limit,
        warnOnTruncation: false,
        notices: getValidationNotices(validation),
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
