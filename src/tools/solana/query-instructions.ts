import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import {
  buildSolanaBalanceFields,
  buildSolanaInstructionFields,
  buildSolanaLogFields,
  buildSolanaTokenBalanceFields,
  buildSolanaTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeSolanaInstructionResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { getValidationNotices, validateSolanaQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Solana Instructions
// ============================================================================

export function registerQuerySolanaInstructionsTool(server: McpServer) {
  type SolanaInstructionsRequest = {
    timeframe?: string
    from_timestamp?: TimestampInput
    to_timestamp?: TimestampInput
    limit: number
    finalized_only: boolean
    program_id?: string[]
    d1?: string[]
    d2?: string[]
    d4?: string[]
    d8?: string[]
    a0?: string[]
    a1?: string[]
    a2?: string[]
    a3?: string[]
    a4?: string[]
    a5?: string[]
    a6?: string[]
    a7?: string[]
    a8?: string[]
    a9?: string[]
    a10?: string[]
    a11?: string[]
    a12?: string[]
    a13?: string[]
    a14?: string[]
    a15?: string[]
    mentions_account?: string[]
    is_committed?: boolean
    transaction_fee_payer?: string[]
    include_transaction: boolean
    include_transaction_balances: boolean
    include_transaction_token_balances: boolean
    include_inner_instructions: boolean
    include_logs: boolean
    include_transaction_instructions: boolean
  }

  type SolanaInstructionsCursor = {
    tool: 'portal_query_solana_instructions'
    dataset: string
    request: SolanaInstructionsRequest
    window_from_block: number
    window_to_block: number
    page_to_block: number
    skip_inclusive_block: number
  }

  type SolanaInstructionItem = Record<string, unknown> & {
    block_number?: number
    transactionIndex?: number
    instructionAddress?: number[] | string
  }

  const getBlockNumber = (item: SolanaInstructionItem) => typeof item.block_number === 'number' ? item.block_number : undefined
  const getTransactionIndex = (item: SolanaInstructionItem) => {
    if (typeof item.transactionIndex === 'number') return item.transactionIndex
    if (typeof item.transactionIndex === 'string') {
      const parsed = Number(item.transactionIndex)
      if (Number.isFinite(parsed)) return parsed
    }
    return 0
  }
  const instructionPath = (item: SolanaInstructionItem) =>
    Array.isArray(item.instructionAddress) ? item.instructionAddress.join('.') : String(item.instructionAddress ?? '')
  const sortInstructions = (items: SolanaInstructionItem[]) =>
    items.sort((left, right) => {
      const leftBlock = getBlockNumber(left) ?? 0
      const rightBlock = getBlockNumber(right) ?? 0
      if (leftBlock !== rightBlock) return leftBlock - rightBlock

      const leftIndex = getTransactionIndex(left)
      const rightIndex = getTransactionIndex(right)
      if (leftIndex !== rightIndex) return leftIndex - rightIndex

      return instructionPath(left).localeCompare(instructionPath(right))
    })

  server.tool(
    'portal_query_solana_instructions',
    "Query instruction data from a Solana dataset with advanced filters. Wrapper for Portal API POST /datasets/{dataset}/stream with type: 'solana'.",
    {
      dataset: z.string().optional().describe('Dataset name or alias. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block. Solana slots are ~400ms."),
      from_block: z.number().optional().describe('Starting slot number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending slot number. Keep ranges reasonable for performance.'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
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
      include_transaction_instructions: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include all instructions from the parent transaction (sibling instructions)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      from_timestamp,
      to_timestamp,
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
      include_transaction_instructions,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<SolanaInstructionsRequest>(cursor, 'portal_query_solana_instructions')
        : undefined
      dataset = paginationCursor?.dataset ?? (dataset ? await resolveDataset(dataset) : undefined)
      if (!dataset) {
        throw new Error('dataset is required unless you are continuing with cursor.')
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw createUnsupportedChainError({
          toolName: 'portal_query_solana_instructions',
          dataset,
          actualChainType: chainType,
          supportedChains: ['solana'],
          suggestions: [
            'Use portal_query_transactions or portal_query_logs for EVM datasets.',
            'Use portal_query_bitcoin_transactions for Bitcoin datasets.',
          ],
        })
      }
      if (paginationCursor) {
        dataset = paginationCursor.dataset
        timeframe = paginationCursor.request.timeframe
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
        limit = paginationCursor.request.limit
        finalized_only = paginationCursor.request.finalized_only
        program_id = paginationCursor.request.program_id
        d1 = paginationCursor.request.d1
        d2 = paginationCursor.request.d2
        d4 = paginationCursor.request.d4
        d8 = paginationCursor.request.d8
        a0 = paginationCursor.request.a0
        a1 = paginationCursor.request.a1
        a2 = paginationCursor.request.a2
        a3 = paginationCursor.request.a3
        a4 = paginationCursor.request.a4
        a5 = paginationCursor.request.a5
        a6 = paginationCursor.request.a6
        a7 = paginationCursor.request.a7
        a8 = paginationCursor.request.a8
        a9 = paginationCursor.request.a9
        a10 = paginationCursor.request.a10
        a11 = paginationCursor.request.a11
        a12 = paginationCursor.request.a12
        a13 = paginationCursor.request.a13
        a14 = paginationCursor.request.a14
        a15 = paginationCursor.request.a15
        mentions_account = paginationCursor.request.mentions_account
        is_committed = paginationCursor.request.is_committed
        transaction_fee_payer = paginationCursor.request.transaction_fee_payer
        include_transaction = paginationCursor.request.include_transaction
        include_transaction_balances = paginationCursor.request.include_transaction_balances
        include_transaction_token_balances = paginationCursor.request.include_transaction_token_balances
        include_inner_instructions = paginationCursor.request.include_inner_instructions
        include_logs = paginationCursor.request.include_logs
        include_transaction_instructions = paginationCursor.request.include_transaction_instructions
      }

      // Resolve timeframe or use explicit blocks
      const resolvedBlocks = paginationCursor
        ? {
            from_block: paginationCursor.window_from_block,
            to_block: paginationCursor.window_to_block,
            range_kind:
              paginationCursor.request.from_timestamp !== undefined || paginationCursor.request.to_timestamp !== undefined
                ? 'timestamp_range'
                : paginationCursor.request.timeframe
                  ? 'timeframe'
                  : 'block_range',
          }
        : await resolveTimeframeOrBlocks({
            dataset,
            timeframe,
            from_block,
            to_block,
            from_timestamp,
            to_timestamp,
          })
      const resolvedFromBlock = resolvedBlocks.from_block
      const resolvedToBlock = resolvedBlocks.to_block

      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock

      const slotRange = pageToBlock - resolvedFromBlock
      const hasFilters = !!(program_id || d1 || d2 || d4 || d8 || a0 || mentions_account || transaction_fee_payer)
      const validation = validateSolanaQuerySize({
        slotRange,
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
      if (include_transaction_instructions) instructionFilter.transactionInstructions = true

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
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields,
        instructions: [instructionFilter],
      }

      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['instructions'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 500 : 100,
      })

      const allInstructions = sortInstructions(results.flatMap((block: unknown) => {
        const typedBlock = block as {
          number?: number
          timestamp?: number
          header?: { number?: number; timestamp?: number }
          instructions?: Array<Record<string, unknown>>
        }
        const blockNumber = typedBlock.number ?? typedBlock.header?.number
        const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

        return (typedBlock.instructions || []).map((instruction) =>
          normalizeSolanaInstructionResult({
            ...instruction,
            ...(blockNumber !== undefined ? { block_number: blockNumber, slot_number: blockNumber } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
          }) as SolanaInstructionItem,
        )
      }))
      const page = paginateAscendingItems(
        allInstructions,
        limit,
        getBlockNumber,
        paginationCursor
          ? {
              page_to_block: paginationCursor.page_to_block,
              skip_inclusive_block: paginationCursor.skip_inclusive_block,
            }
          : undefined,
      )
      const nextCursor = page.hasMore && page.nextBoundary
        ? encodeRecentPageCursor<SolanaInstructionsRequest>({
            tool: 'portal_query_solana_instructions',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(program_id ? { program_id } : {}),
              ...(d1 ? { d1 } : {}),
              ...(d2 ? { d2 } : {}),
              ...(d4 ? { d4 } : {}),
              ...(d8 ? { d8 } : {}),
              ...(a0 ? { a0 } : {}),
              ...(a1 ? { a1 } : {}),
              ...(a2 ? { a2 } : {}),
              ...(a3 ? { a3 } : {}),
              ...(a4 ? { a4 } : {}),
              ...(a5 ? { a5 } : {}),
              ...(a6 ? { a6 } : {}),
              ...(a7 ? { a7 } : {}),
              ...(a8 ? { a8 } : {}),
              ...(a9 ? { a9 } : {}),
              ...(a10 ? { a10 } : {}),
              ...(a11 ? { a11 } : {}),
              ...(a12 ? { a12 } : {}),
              ...(a13 ? { a13 } : {}),
              ...(a14 ? { a14 } : {}),
              ...(a15 ? { a15 } : {}),
              ...(mentions_account ? { mentions_account } : {}),
              ...(is_committed !== undefined ? { is_committed } : {}),
              ...(transaction_fee_payer ? { transaction_fee_payer } : {}),
              include_transaction,
              include_transaction_balances,
              include_transaction_token_balances,
              include_inner_instructions,
              include_logs,
              include_transaction_instructions,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined

      const notices = [...getTimestampWindowNotices(resolvedBlocks), ...getValidationNotices(validation)]
      if (nextCursor) notices.push('Older results are available via _pagination.next_cursor.')
      const freshness = buildQueryFreshness({
        finality: finalized_only ? 'finalized' : 'latest',
        headBlockNumber: head.number,
        windowToBlock: endBlock,
        resolvedWindow: resolvedBlocks,
      })
      const coverage = buildQueryCoverage({
        windowFromBlock: resolvedFromBlock,
        windowToBlock: endBlock,
        pageToBlock,
        items: page.pageItems,
        getBlockNumber,
        hasMore: page.hasMore,
      })

      return formatResult(
        page.pageItems,
        `Retrieved ${page.pageItems.length} instructions${page.hasMore ? ` from the most recent matching slots (preview page limited to ${limit})` : ''}`,
        {
          notices,
          pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
          freshness,
          coverage,
          metadata: {
            dataset,
            from_block: resolvedFromBlock,
            to_block: pageToBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
