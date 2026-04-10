import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { normalizeSolanaTransactionResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
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
import { getValidationNotices, validateSolanaQuerySize } from '../../helpers/validation.js'

// ============================================================================
// Tool: Query Solana Transactions
// ============================================================================

export function registerQuerySolanaTransactionsTool(server: McpServer) {
  type SolanaTransactionsRequest = {
    timeframe?: string
    from_timestamp?: TimestampInput
    to_timestamp?: TimestampInput
    limit: number
    finalized_only: boolean
    fee_payer?: string[]
    mentions_account?: string[]
    include_instructions: boolean
    include_balances: boolean
    include_token_balances: boolean
    include_logs: boolean
    include_rewards: boolean
    response_format: ResponseFormat
  }

  type SolanaTransactionsCursor = {
    tool: 'portal_solana_query_transactions'
    dataset: string
    request: SolanaTransactionsRequest
    window_from_block: number
    window_to_block: number
    page_to_block: number
    skip_inclusive_block: number
  }

  type SolanaTransactionItem = Record<string, unknown> & {
    block_number?: number
    transactionIndex?: number
    tx_hash?: string
  }

  const getBlockNumber = (item: SolanaTransactionItem) => typeof item.block_number === 'number' ? item.block_number : undefined
  const getTransactionIndex = (item: SolanaTransactionItem) => {
    if (typeof item.transactionIndex === 'number') return item.transactionIndex
    if (typeof item.transactionIndex === 'string') {
      const parsed = Number(item.transactionIndex)
      if (Number.isFinite(parsed)) return parsed
    }
    return 0
  }
  const sortTransactions = (items: SolanaTransactionItem[]) =>
    items.sort((left, right) => {
      const leftBlock = getBlockNumber(left) ?? 0
      const rightBlock = getBlockNumber(right) ?? 0
      if (leftBlock !== rightBlock) return leftBlock - rightBlock

      const leftIndex = getTransactionIndex(left)
      const rightIndex = getTransactionIndex(right)
      if (leftIndex !== rightIndex) return leftIndex - rightIndex

      return String(left.tx_hash ?? '').localeCompare(String(right.tx_hash ?? ''))
    })

  server.tool(
    'portal_solana_query_transactions',
    buildToolDescription('portal_solana_query_transactions'),
    {
      network: z.string().optional().describe('Network name or alias. Optional when continuing with cursor.'),
      timeframe: z.string().optional().describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting slot number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending slot number'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
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
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({
      network,
      timeframe,
      from_block,
      to_block,
      from_timestamp,
      to_timestamp,
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
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<SolanaTransactionsRequest>(cursor, 'portal_solana_query_transactions')
        : undefined
      let dataset = paginationCursor?.dataset ?? (network ? await resolveDataset(network) : undefined)
      if (!dataset) {
        throw new Error('network is required unless you are continuing with cursor.')
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw createUnsupportedChainError({
          toolName: 'portal_solana_query_transactions',
          dataset,
          actualChainType: chainType,
          supportedChains: ['solana'],
          suggestions: [
            'Use portal_evm_query_transactions for EVM datasets.',
            'Use portal_bitcoin_query_transactions for Bitcoin datasets.',
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
        fee_payer = paginationCursor.request.fee_payer
        mentions_account = paginationCursor.request.mentions_account
        include_instructions = paginationCursor.request.include_instructions
        include_balances = paginationCursor.request.include_balances
        include_token_balances = paginationCursor.request.include_token_balances
        include_logs = paginationCursor.request.include_logs
        include_rewards = paginationCursor.request.include_rewards
        response_format = paginationCursor.request.response_format
      }

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
            dataset, timeframe, from_block, to_block, from_timestamp, to_timestamp,
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
        toBlock: pageToBlock,
        fields,
        transactions: [txFilter],
      }
      if (include_rewards) {
        query.rewards = [{}]
      }

      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['transactions'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 500 : 100,
      })

      const allTxs = sortTransactions(results.flatMap((block: unknown) => {
        const typedBlock = block as {
          number?: number
          timestamp?: number
          header?: { number?: number; timestamp?: number }
          transactions?: Array<Record<string, unknown>>
        }
        const blockNumber = typedBlock.number ?? typedBlock.header?.number
        const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

        return (typedBlock.transactions || []).map((tx) =>
          normalizeSolanaTransactionResult({
            ...tx,
            ...(blockNumber !== undefined ? { block_number: blockNumber, slot_number: blockNumber } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
          }) as SolanaTransactionItem,
        )
      }))
      const page = paginateAscendingItems(
        allTxs,
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
        ? encodeRecentPageCursor<SolanaTransactionsRequest>({
            tool: 'portal_solana_query_transactions',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(fee_payer ? { fee_payer } : {}),
              ...(mentions_account ? { mentions_account } : {}),
              include_instructions,
              include_balances,
              include_token_balances,
              include_logs,
              include_rewards,
              response_format: response_format as ResponseFormat,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined

      const formattedData = applyResponseFormat(page.pageItems, response_format as ResponseFormat, 'solana_transactions')
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
        formattedData,
        `Retrieved ${page.pageItems.length} Solana transactions${page.hasMore ? ` from the most recent matching slots (preview page limited to ${limit})` : ''}`,
        {
          toolName: 'portal_solana_query_transactions',
          notices,
          pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
          ordering: buildChronologicalPageOrdering({
            sortedBy: 'slot_number',
            tieBreakers: ['transactionIndex', 'signatures[0]'],
          }),
          freshness,
          coverage,
          execution: buildExecutionMetadata({
            response_format,
            finalized_only,
            limit,
            from_block: resolvedFromBlock,
            to_block: endBlock,
            page_to_block: pageToBlock,
            range_kind: resolvedBlocks.range_kind,
            notes: [
              include_instructions || include_balances || include_token_balances || include_logs || include_rewards
                ? 'Expanded Solana transaction context was requested with include flags.'
                : 'Using the default Solana transaction view.',
            ],
            normalized_output: true,
          }),
          metadata: {
            network: dataset,
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
