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
  buildSolanaTokenBalanceFields,
  buildSolanaTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
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
      limit: z.number().optional().default(50).describe('Max transactions'),
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
      limit,
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

      const hasFilters = !!(fee_payer || mentions_account)
      const validation = validateSolanaQuerySize({
        slotRange: endBlock - resolvedFromBlock,
        hasFilters,
        queryType: 'instructions', // transactions are similarly dense
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

      const query = {
        type: 'solana',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields,
        transactions: [txFilter],
      }

      // Solana slots are extremely dense — cap maxBlocks to prevent OOM.
      const maxBlocks = hasFilters ? 0 : Math.max(5, Math.ceil(limit / 50))

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query, undefined, maxBlocks)

      const allTxs = results
        .flatMap((block: unknown) => (block as { transactions?: unknown[] }).transactions || [])
        .slice(0, limit)

      return formatResult(allTxs, `Retrieved ${allTxs.length} Solana transactions`)
    },
  )
}
