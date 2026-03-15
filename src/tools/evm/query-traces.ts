import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmTraceFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
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
      from_block: z.number().describe('Starting block number'),
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
      limit: z.number().optional().default(1000).describe('Max traces'),
    },
    async ({
      dataset,
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
      limit,
    }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_query_traces is only for EVM chains')
      }

      const normalizedCreateFrom = normalizeAddresses(create_from, chainType)
      const normalizedCallFrom = normalizeAddresses(call_from, chainType)
      const normalizedCallTo = normalizeAddresses(call_to, chainType)
      const normalizedSuicideRefund = normalizeAddresses(suicide_refund_address, chainType)
      const normalizedRewardAuthor = normalizeAddresses(reward_author, chainType)
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      // Validate query size to prevent memory crashes
      const blockRange = endBlock - from_block
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

      const query = {
        type: 'evm',
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true, hash: true },
          trace: buildEvmTraceFields(),
        },
        traces: [traceFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allTraces = results
        .flatMap((block: unknown) => (block as { traces?: unknown[] }).traces || [])
        .slice(0, limit)
      return formatResult(allTraces, `Retrieved ${allTraces.length} traces`, {
        metadata: {
          dataset,
          from_block,
          to_block: endBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
