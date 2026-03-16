import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
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
// Tool: Query Solana Instructions
// ============================================================================

export function registerQuerySolanaInstructionsTool(server: McpServer) {
  server.tool(
    'portal_query_solana_instructions',
    "Query instruction data from a Solana dataset with advanced filters. Wrapper for Portal API POST /datasets/{dataset}/stream with type: 'solana'.",
    {
      dataset: z.string().describe('Dataset name or alias'),
      from_block: z.number().describe('Starting slot number'),
      to_block: z.number().optional().describe('Ending slot number. Keep ranges reasonable for performance.'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized slots'),
      program_id: z.array(z.string()).optional().describe('Program IDs'),
      d1: z.array(z.string()).optional().describe('1-byte discriminator filter (0x-prefixed hex)'),
      d2: z.array(z.string()).optional().describe('2-byte discriminator filter (0x-prefixed hex)'),
      d4: z.array(z.string()).optional().describe('4-byte discriminator filter (0x-prefixed hex)'),
      d8: z.array(z.string()).optional().describe('8-byte discriminator filter - Anchor (0x-prefixed hex)'),
      a0: z.array(z.string()).optional().describe('Account at index 0'),
      a1: z.array(z.string()).optional().describe('Account at index 1'),
      a2: z.array(z.string()).optional().describe('Account at index 2'),
      a3: z.array(z.string()).optional().describe('Account at index 3'),
      a4: z.array(z.string()).optional().describe('Account at index 4'),
      a5: z.array(z.string()).optional().describe('Account at index 5'),
      a6: z.array(z.string()).optional().describe('Account at index 6'),
      a7: z.array(z.string()).optional().describe('Account at index 7'),
      a8: z.array(z.string()).optional().describe('Account at index 8'),
      a9: z.array(z.string()).optional().describe('Account at index 9'),
      a10: z.array(z.string()).optional().describe('Account at index 10'),
      a11: z.array(z.string()).optional().describe('Account at index 11'),
      a12: z.array(z.string()).optional().describe('Account at index 12'),
      a13: z.array(z.string()).optional().describe('Account at index 13'),
      a14: z.array(z.string()).optional().describe('Account at index 14'),
      a15: z.array(z.string()).optional().describe('Account at index 15'),
      mentions_account: z.array(z.string()).optional().describe('Accounts mentioned anywhere in the instruction'),
      is_committed: z.boolean().optional().describe('Only committed transactions'),
      transaction_fee_payer: z.array(z.string()).optional().describe('Fee payer filter'),
      limit: z.number().optional().default(50).describe('Max instructions'),
      include_transaction: z.boolean().optional().default(false).describe('Include transaction data'),
      include_transaction_balances: z.boolean().optional().default(false).describe('Include SOL balance changes'),
      include_transaction_token_balances: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include token balance changes'),
      include_inner_instructions: z.boolean().optional().default(false).describe('Include inner (CPI) instructions'),
      include_logs: z.boolean().optional().default(false).describe('Include program logs'),
    },
    async ({
      dataset,
      from_block,
      to_block,
      finalized_only,
      program_id,
      d1,
      d2,
      d4,
      d8,
      a0,
      a1,
      a2,
      a3,
      a4,
      a5,
      a6,
      a7,
      a8,
      a9,
      a10,
      a11,
      a12,
      a13,
      a14,
      a15,
      mentions_account,
      is_committed,
      transaction_fee_payer,
      limit,
      include_transaction,
      include_transaction_balances,
      include_transaction_token_balances,
      include_inner_instructions,
      include_logs,
    }) => {
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw new Error('portal_query_solana_instructions is only for Solana chains')
      }

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      const hasFilters = !!(program_id || d1 || d2 || d4 || d8 || a0 || mentions_account || transaction_fee_payer)
      const validation = validateSolanaQuerySize({
        slotRange: endBlock - from_block,
        hasFilters,
        queryType: 'instructions',
        limit,
      })
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      const instructionFilter: Record<string, unknown> = {}
      if (program_id) instructionFilter.programId = program_id
      if (d1) instructionFilter.d1 = d1
      if (d2) instructionFilter.d2 = d2
      if (d4) instructionFilter.d4 = d4
      if (d8) instructionFilter.d8 = d8
      if (a0) instructionFilter.a0 = a0
      if (a1) instructionFilter.a1 = a1
      if (a2) instructionFilter.a2 = a2
      if (a3) instructionFilter.a3 = a3
      if (a4) instructionFilter.a4 = a4
      if (a5) instructionFilter.a5 = a5
      if (a6) instructionFilter.a6 = a6
      if (a7) instructionFilter.a7 = a7
      if (a8) instructionFilter.a8 = a8
      if (a9) instructionFilter.a9 = a9
      if (a10) instructionFilter.a10 = a10
      if (a11) instructionFilter.a11 = a11
      if (a12) instructionFilter.a12 = a12
      if (a13) instructionFilter.a13 = a13
      if (a14) instructionFilter.a14 = a14
      if (a15) instructionFilter.a15 = a15
      if (mentions_account) instructionFilter.mentionsAccount = mentions_account
      if (is_committed !== undefined) instructionFilter.isCommitted = is_committed
      if (transaction_fee_payer) instructionFilter.transactionFeePayer = transaction_fee_payer
      if (include_transaction) instructionFilter.transaction = true
      if (include_transaction_balances) instructionFilter.transactionBalances = true
      if (include_transaction_token_balances) instructionFilter.transactionTokenBalances = true
      if (include_inner_instructions) instructionFilter.innerInstructions = true
      if (include_logs) instructionFilter.logs = true

      const hasDiscriminators = d1 || d2 || d4 || d8
      const fields: Record<string, unknown> = {
        block: { number: true, hash: true, timestamp: true },
        instruction: buildSolanaInstructionFields(!!hasDiscriminators),
      }
      if (include_transaction || include_transaction_balances || include_transaction_token_balances) {
        fields.transaction = buildSolanaTransactionFields()
      }
      if (include_transaction_balances) {
        fields.balance = buildSolanaBalanceFields()
      }
      if (include_transaction_token_balances) {
        fields.tokenBalance = buildSolanaTokenBalanceFields()
      }
      if (include_logs) {
        fields.log = buildSolanaLogFields()
      }

      const query = {
        type: 'solana',
        fromBlock: from_block,
        toBlock: endBlock,
        fields,
        instructions: [instructionFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allInstructions = results
        .flatMap((block: unknown) => (block as { instructions?: unknown[] }).instructions || [])
        .slice(0, limit)

      return formatResult(allInstructions, `Retrieved ${allInstructions.length} instructions`)
    },
  )
}
