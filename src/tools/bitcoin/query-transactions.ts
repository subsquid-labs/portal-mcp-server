import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { buildBitcoinBlockFields, buildBitcoinInputFields, buildBitcoinOutputFields, buildBitcoinTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeBitcoinInputResult, normalizeBitcoinOutputResult, normalizeBitcoinTransactionResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { applyResponseFormat, type ResponseFormat } from '../../helpers/response-modes.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'

export function registerQueryBitcoinTransactionsTool(server: McpServer) {
  type BitcoinTransactionsRequest = {
    timeframe?: string
    from_timestamp?: TimestampInput
    to_timestamp?: TimestampInput
    limit: number
    finalized_only: boolean
    include_inputs: boolean
    include_outputs: boolean
    response_format: ResponseFormat
  }

  type BitcoinTransactionsCursor = {
    tool: 'portal_bitcoin_query_transactions'
    dataset: string
    request: BitcoinTransactionsRequest
    window_from_block: number
    window_to_block: number
    page_to_block: number
    skip_inclusive_block: number
  }

  type BitcoinTransactionItem = Record<string, unknown> & {
    block_number?: number
    transactionIndex?: number
    txid?: string
    tx_hash?: string
  }

  const getBlockNumber = (item: BitcoinTransactionItem) => typeof item.block_number === 'number' ? item.block_number : undefined
  const getTransactionIndex = (item: BitcoinTransactionItem) => {
    if (typeof item.transactionIndex === 'number') return item.transactionIndex
    if (typeof item.transactionIndex === 'string') {
      const parsed = Number(item.transactionIndex)
      if (Number.isFinite(parsed)) return parsed
    }
    return 0
  }
  const sortTransactions = (items: BitcoinTransactionItem[]) =>
    items.sort((left, right) => {
      const leftBlock = getBlockNumber(left) ?? 0
      const rightBlock = getBlockNumber(right) ?? 0
      if (leftBlock !== rightBlock) return leftBlock - rightBlock

      const leftIndex = getTransactionIndex(left)
      const rightIndex = getTransactionIndex(right)
      if (leftIndex !== rightIndex) return leftIndex - rightIndex

      return String(left.txid ?? left.tx_hash ?? '').localeCompare(String(right.txid ?? right.tx_hash ?? ''))
    })

  server.tool(
    'portal_bitcoin_query_transactions',
    buildToolDescription('portal_bitcoin_query_transactions'),
    {
      network: z.string().optional().describe('Network name (default: bitcoin-mainnet). Optional when continuing with cursor.'),
      from_block: z.number().optional().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      include_inputs: z.boolean().optional().default(false).describe('Attach transaction inputs inline'),
      include_outputs: z.boolean().optional().default(false).describe('Attach transaction outputs inline'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().default('full').describe("Response format: 'summary' (stats only, ~90% smaller), 'compact' (hash+size+weight only, ~50% smaller), 'full' (all fields)"),
      limit: z.number().optional().default(50).describe('Max transactions to return (default: 50)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ network, from_block, to_block, timeframe, from_timestamp, to_timestamp, finalized_only, include_inputs, include_outputs, response_format, limit, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<BitcoinTransactionsRequest>(cursor, 'portal_bitcoin_query_transactions')
        : undefined
      let dataset = paginationCursor?.dataset ?? (network ? await resolveDataset(network) : 'bitcoin-mainnet')
      const chainType = detectChainType(dataset)

      if (chainType !== 'bitcoin') {
        throw createUnsupportedChainError({
          toolName: 'portal_bitcoin_query_transactions',
          dataset,
          actualChainType: chainType,
          supportedChains: ['bitcoin'],
          suggestions: [
            'Use portal_evm_query_transactions for EVM datasets.',
            'Use portal_solana_query_transactions for Solana datasets.',
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
        include_inputs = paginationCursor.request.include_inputs
        include_outputs = paginationCursor.request.include_outputs
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

      const query = {
        type: 'bitcoin',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields: {
          block: buildBitcoinBlockFields(),
          transaction: buildBitcoinTransactionFields(),
        },
        transactions: [{}],
      }

      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['transactions'],
        limit: fetchLimit,
        chunkSize: 20,
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
          normalizeBitcoinTransactionResult({
            ...tx,
            ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
          }) as BitcoinTransactionItem,
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
        ? encodeRecentPageCursor<BitcoinTransactionsRequest>({
            tool: 'portal_bitcoin_query_transactions',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              include_inputs,
              include_outputs,
              response_format: response_format as ResponseFormat,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined
      let pageItems = page.pageItems
      if ((include_inputs || include_outputs) && pageItems.length > 0) {
        const txKeys = new Set(
          pageItems
            .map((item) => {
              const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
              const transactionIndex = typeof item.transactionIndex === 'number'
                ? item.transactionIndex
                : typeof item.transactionIndex === 'string'
                  ? Number(item.transactionIndex)
                  : undefined
              return blockNumber !== undefined && Number.isFinite(transactionIndex) ? `${blockNumber}:${transactionIndex}` : undefined
            })
            .filter((value): value is string => Boolean(value)),
        )
        const [inputBlocks, outputBlocks] = await Promise.all([
          include_inputs
            ? portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, {
                type: 'bitcoin',
                fromBlock: resolvedFromBlock,
                toBlock: pageToBlock,
                fields: {
                  block: buildBitcoinBlockFields(),
                  input: buildBitcoinInputFields(),
                },
                inputs: [{}],
              }, {
                itemKeys: ['inputs'],
                limit: 5000,
                chunkSize: 20,
              })
            : Promise.resolve([]),
          include_outputs
            ? portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, {
                type: 'bitcoin',
                fromBlock: resolvedFromBlock,
                toBlock: pageToBlock,
                fields: {
                  block: buildBitcoinBlockFields(),
                  output: buildBitcoinOutputFields(),
                },
                outputs: [{}],
              }, {
                itemKeys: ['outputs'],
                limit: 5000,
                chunkSize: 20,
              })
            : Promise.resolve([]),
        ])

        const inputsByTx = new Map<string, Record<string, unknown>[]>()
        for (const block of inputBlocks as Array<any>) {
          const blockNumber = typeof block.number === 'number' ? block.number : typeof block.header?.number === 'number' ? block.header.number : undefined
          for (const input of block.inputs || []) {
            const transactionIndex = typeof input.transactionIndex === 'number'
              ? input.transactionIndex
              : typeof input.transactionIndex === 'string'
                ? Number(input.transactionIndex)
                : undefined
            if (blockNumber === undefined || !Number.isFinite(transactionIndex)) continue
            const txKey = `${blockNumber}:${transactionIndex}`
            if (!txKeys.has(txKey)) continue
            if (!inputsByTx.has(txKey)) inputsByTx.set(txKey, [])
            inputsByTx.get(txKey)!.push(normalizeBitcoinInputResult({
              ...input,
              block_number: blockNumber,
            }))
          }
        }
        const outputsByTx = new Map<string, Record<string, unknown>[]>()
        for (const block of outputBlocks as Array<any>) {
          const blockNumber = typeof block.number === 'number' ? block.number : typeof block.header?.number === 'number' ? block.header.number : undefined
          for (const output of block.outputs || []) {
            const transactionIndex = typeof output.transactionIndex === 'number'
              ? output.transactionIndex
              : typeof output.transactionIndex === 'string'
                ? Number(output.transactionIndex)
                : undefined
            if (blockNumber === undefined || !Number.isFinite(transactionIndex)) continue
            const txKey = `${blockNumber}:${transactionIndex}`
            if (!txKeys.has(txKey)) continue
            if (!outputsByTx.has(txKey)) outputsByTx.set(txKey, [])
            outputsByTx.get(txKey)!.push(normalizeBitcoinOutputResult({
              ...output,
              block_number: blockNumber,
            }))
          }
        }

        pageItems = pageItems.map((item) => {
          const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
          const transactionIndex = typeof item.transactionIndex === 'number'
            ? item.transactionIndex
            : typeof item.transactionIndex === 'string'
              ? Number(item.transactionIndex)
              : undefined
          const txKey = blockNumber !== undefined && Number.isFinite(transactionIndex) ? `${blockNumber}:${transactionIndex}` : ''
          return {
            ...item,
            ...(include_inputs ? { inputs: inputsByTx.get(txKey) || [] } : {}),
            ...(include_outputs ? { outputs: outputsByTx.get(txKey) || [] } : {}),
          }
        })
      }

      const formattedData = applyResponseFormat(pageItems, response_format as ResponseFormat, 'bitcoin_transactions')
      const notices = getTimestampWindowNotices(resolvedBlocks)
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

      const message = response_format === 'summary'
        ? `Summary of ${pageItems.length} Bitcoin transactions${page.hasMore ? ' (latest preview page)' : ''}`
        : `Retrieved ${pageItems.length} Bitcoin transactions${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
        toolName: 'portal_bitcoin_query_transactions',
        notices,
        pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
        ordering: buildChronologicalPageOrdering({
          sortedBy: 'block_number',
          tieBreakers: ['transactionIndex', 'txid'],
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
          normalized_output: true,
          notes: [
            include_inputs || include_outputs
              ? 'Inputs and/or outputs were attached inline to each transaction.'
              : 'Transaction-only Bitcoin view.',
          ],
        }),
        metadata: {
          network: dataset,
          dataset,
          from_block: resolvedFromBlock,
          to_block: pageToBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
