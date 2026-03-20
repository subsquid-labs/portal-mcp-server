import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { getTraceFields } from '../../helpers/field-presets.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmLogFields, buildEvmTraceFields, buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { normalizeAddresses, validateQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Traces (EVM)
// ============================================================================

export function registerQueryTracesTool(server: McpServer) {
  server.tool(
    'portal_query_traces',
    `Query internal transactions/traces from EVM chains. Find contract deployments (type: create), internal calls, and self-destructs.`,
    {
      dataset: z.string().describe('Dataset name or alias'),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block. Keep short for traces (<1h recommended)."),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z
        .number()
        .optional()
        .describe(
          'Ending block number. RECOMMENDED: <1k blocks for traces (expensive operation). Larger ranges will be slow.',
        ),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      type: z
        .array(z.enum(['call', 'create', 'suicide', 'reward']))
        .optional()
        .describe(
          "Trace types to filter. NOTE: 'create' includes both CREATE and CREATE2 opcodes (Portal API limitation)",
        ),
      create_from: z
        .array(z.string())
        .optional()
        .describe('Filter CREATE traces by deployer address (use this for contract deployments, not call_from)'),
      call_from: z.array(z.string()).optional().describe('Filter CALL traces by caller address'),
      call_to: z.array(z.string()).optional().describe('Filter CALL traces by recipient address'),
      call_sighash: z.array(z.string()).optional().describe('Call sighash filter (4-byte hex)'),
      suicide_refund_address: z.array(z.string()).optional().describe('Suicide refund addresses'),
      reward_author: z.array(z.string()).optional().describe('Reward author addresses'),
      include_transaction: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include parent transaction data for each trace'),
      include_transaction_logs: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include logs from the parent transaction'),
      include_subtraces: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include child traces (sub-calls)'),
      include_parents: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include parent traces in the call tree'),
      limit: z.number().optional().default(50).describe('Max traces'),
      field_preset: z
        .enum(['minimal', 'standard', 'full'])
        .optional()
        .default('standard')
        .describe(
          "Field preset: 'minimal' (type+from+to, smallest), 'standard' (+value+sighash, no input/output hex), 'full' (all fields including input/output hex blobs)",
        ),
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      finalized_only,
      type,
      create_from,
      call_from,
      call_to,
      call_sighash,
      suicide_refund_address,
      reward_author,
      include_transaction,
      include_transaction_logs,
      include_subtraces,
      include_parents,
      limit,
      field_preset,
    }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_query_traces is only for EVM chains')
      }

      // Resolve timeframe or use explicit blocks
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const normalizedCreateFrom = normalizeAddresses(create_from, chainType)
      const normalizedCallFrom = normalizeAddresses(call_from, chainType)
      const normalizedCallTo = normalizeAddresses(call_to, chainType)
      const normalizedSuicideRefund = normalizeAddresses(suicide_refund_address, chainType)
      const normalizedRewardAuthor = normalizeAddresses(reward_author, chainType)
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      // Validate query size to prevent memory crashes
      const blockRange = endBlock - resolvedFromBlock
      const hasFilters = !!(
        type ||
        create_from ||
        call_from ||
        call_to ||
        call_sighash ||
        suicide_refund_address ||
        reward_author
      )
      const validation = validateQuerySize({
        blockRange,
        hasFilters,
        queryType: 'traces',
        limit,
      })

      if (!validation.valid && validation.error) {
        throw new Error(validation.error)
      }

      const traceFilter: Record<string, unknown> = {}
      if (type) traceFilter.type = type
      if (normalizedCreateFrom) traceFilter.createFrom = normalizedCreateFrom
      if (normalizedCallFrom) traceFilter.callFrom = normalizedCallFrom
      if (normalizedCallTo) traceFilter.callTo = normalizedCallTo
      if (call_sighash) traceFilter.callSighash = call_sighash
      if (normalizedSuicideRefund) traceFilter.suicideRefundAddress = normalizedSuicideRefund
      if (normalizedRewardAuthor) traceFilter.rewardAuthor = normalizedRewardAuthor
      if (include_transaction) traceFilter.transaction = true
      if (include_transaction_logs) traceFilter.transactionLogs = true
      if (include_subtraces) traceFilter.subtraces = true
      if (include_parents) traceFilter.parents = true

      // Use field preset for compact responses, fall back to full builder for 'full'
      const presetFields = getTraceFields(field_preset)
      const traceFields = field_preset === 'full' ? buildEvmTraceFields() : presetFields.trace
      const blockFieldsForTrace = presetFields.block || { number: true, timestamp: true, hash: true }

      const fields: Record<string, unknown> = {
        block: blockFieldsForTrace,
        trace: traceFields,
      }
      if (include_transaction || include_transaction_logs) {
        const includeL2 = isL2Chain(dataset)
        fields.transaction = buildEvmTransactionFields(includeL2)
      }
      if (include_transaction_logs) {
        fields.log = buildEvmLogFields()
      }

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields,
        traces: [traceFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allTraces = results
        .flatMap((block: unknown) => (block as { traces?: unknown[] }).traces || [])
        .slice(0, limit)
      return formatResult(allTraces, `Retrieved ${allTraces.length} traces`, {
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
