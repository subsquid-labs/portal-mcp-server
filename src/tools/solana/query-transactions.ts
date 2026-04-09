import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import {
  buildSolanaBalanceFields,
  buildSolanaInstructionFields,
  buildSolanaLogFields,
  buildSolanaRewardFields,
  buildSolanaTokenBalanceFields,
  buildSolanaTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { applyResponseFormat, type ResponseFormat } from '../../helpers/response-modes.js'
import { validateSolanaQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Solana Transactions
// ============================================================================

export function registerQuerySolanaTransactionsTool(server: McpServer) {
  server.tool(
    'portal_query_solana_transactions',
    'Query Solana transactions. Filter by fee payer or account involvement. Includes signature, fee, compute units, and error status.',
    {
      dataset: z.string().describe('Dataset name or alias'),
      timeframe: z.string().optional().describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting slot number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending slot number'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized slots'),
      fee_payer: z.array(z.string()).optional().describe('Fee payer addresses'),
      mentions_account: z
        .array(z.string())
        .optional()
        .describe('Accounts mentioned anywhere in the transaction'),
      include_instructions: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include instruction data'),
      include_balances: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include SOL balance changes'),
      include_token_balances: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include SPL token balance changes'),
      include_logs: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include program logs'),
      include_rewards: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include block rewards (validator staking rewards). Filter by pubkey using mentions_account.'),
      limit: z.number().optional().default(50).describe('Max transactions'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().default('full').describe("Response format: 'summary' (aggregated stats, ~90% smaller), 'compact' (signature+fee+error only, ~70% smaller), 'full' (all fields)"),
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      finalized_only,
      fee_payer,
      mentions_account,
      include_instructions,
      include_balances,
      include_token_balances,
      include_logs,
      include_rewards,
      limit,
      response_format,
    }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw new Error('portal_query_solana_transactions is only for Solana chains')
      }

      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset, timeframe, from_block, to_block,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      const slotRange = endBlock - resolvedFromBlock
      const hasFilters = !!(fee_payer || mentions_account)
      const validation = validateSolanaQuerySize({
        slotRange,
        hasFilters,
        queryType: 'transactions',
        limit,
      })
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      const txFilter: Record<string, unknown> = {}
      if (fee_payer) txFilter.feePayer = fee_payer
      if (mentions_account) txFilter.mentionsAccount = mentions_account
      if (include_instructions) txFilter.instructions = true
      if (include_balances) txFilter.balances = true
      if (include_token_balances) txFilter.tokenBalances = true
      if (include_logs) txFilter.logs = true

      const fields: Record<string, unknown> = {
        block: { number: true, hash: true, timestamp: true },
        transaction: buildSolanaTransactionFields(),
      }
      if (include_instructions) {
        fields.instruction = buildSolanaInstructionFields()
      }
      if (include_balances) {
        fields.balance = buildSolanaBalanceFields()
      }
      if (include_token_balances) {
        fields.tokenBalance = buildSolanaTokenBalanceFields()
      }
      if (include_logs) {
        fields.log = buildSolanaLogFields()
      }
      if (include_rewards) {
        fields.reward = buildSolanaRewardFields()
      }

      const query: Record<string, unknown> = {
        type: 'solana',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields,
        transactions: [txFilter],
      }
      if (include_rewards) {
        query.rewards = [{}]
      }

      const maxBlocks = Math.min(
        slotRange + 1,
        hasFilters ? Math.max(25, Math.ceil(limit / 2)) : Math.max(5, Math.ceil(limit / 50)),
      )

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        maxBlocks,
        stopAfterItems: {
          keys: ['transactions'],
          limit,
        },
      })

      const allTxs = results
        .flatMap((block: unknown) => (block as { transactions?: unknown[] }).transactions || [])
        .slice(0, limit)

      const formattedData = applyResponseFormat(allTxs, response_format as ResponseFormat, 'solana_transactions')

      return formatResult(formattedData, `Retrieved ${allTxs.length} Solana transactions`)
    },
  )
}
