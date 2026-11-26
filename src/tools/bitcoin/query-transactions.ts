import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { scanBoundedBlockRange } from '../../helpers/bounded-search.js'
import { detectChainType } from '../../helpers/chain.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecordsWithScan, portalFetchStreamRange } from '../../helpers/fetch.js'
import { buildBitcoinBlockFields, buildBitcoinTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import {
  normalizeBitcoinInputResult,
  normalizeBitcoinOutputResult,
  normalizeBitcoinTransactionResult,
} from '../../helpers/normalized-results.js'
import {
  buildPaginationInfo,
  decodeRecentPageCursor,
  encodeRecentPageCursor,
  paginateAscendingItems,
} from '../../helpers/pagination.js'
import { type ResponseFormat, applyResponseFormat, resolveDefaultResponseFormat } from '../../helpers/response-modes.js'
import {
  buildChronologicalPageOrdering,
  buildQueryCoverage,
  buildQueryFreshness,
} from '../../helpers/result-metadata.js'
import { type TimestampInput, getTimestampWindowNotices, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { isValidBitcoinAddress, normalizeBitcoinAddressForPortal } from '../../helpers/validation.js'

export function registerQueryBitcoinTransactionsTool(server: McpServer) {
  type BitcoinTransactionsRequest = {
    timeframe?: string
    from_timestamp?: TimestampInput
    to_timestamp?: TimestampInput
    limit: number
    finalized_only: boolean
    address?: string
    txid?: string
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

  const getBlockNumber = (item: BitcoinTransactionItem) =>
    typeof item.block_number === 'number' ? item.block_number : undefined
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

  const inlineInputFields = {
    transactionIndex: true,
    inputIndex: true,
    type: true,
    prevoutValue: true,
    prevoutScriptPubKeyType: true,
    prevoutScriptPubKeyAddress: true,
  }

  const inlineOutputFields = {
    transactionIndex: true,
    outputIndex: true,
    value: true,
    scriptPubKeyType: true,
    scriptPubKeyAddress: true,
  }

  registerPortalTool(
    server,
    'portal_bitcoin_query_transactions',
    buildToolDescription('portal_bitcoin_query_transactions'),
    {
      network: z
        .string()
        .optional()
        .describe('Network name (default: bitcoin-mainnet). Optional when continuing with cursor.'),
      from_block: z.number().optional().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      timeframe: z.string().optional().describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".',
        ),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".',
        ),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      address: z
        .string()
        .optional()
        .describe('FILTER: Bitcoin address (bc1..., 1..., 3...) appearing in transaction inputs or outputs.'),
      txid: z
        .string()
        .optional()
        .describe(
          'FILTER: Exact 64-character hex Bitcoin transaction ID (txid/hash). Combine with from_block/to_block or timeframe; stops as soon as matched.',
        ),
      include_inputs: z.boolean().optional().default(false).describe('Attach transaction inputs inline'),
      include_outputs: z.boolean().optional().default(false).describe('Attach transaction outputs inline'),
      response_format: z
        .enum(['full', 'compact', 'summary'])
        .optional()
        .describe(
          "Response format: defaults to 'compact' for chat-friendly output. Compact mode keeps inline inputs and outputs in a smaller shape when requested.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .default(20)
        .describe(
          'Max transactions to return (default: 20, max: 25). With include_inputs or include_outputs and response_format "full", a page near the maximum can exceed the 50,000-byte response budget; the response_too_large error then names the limit to retry with.',
        ),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({
      network,
      from_block,
      to_block,
      timeframe,
      from_timestamp,
      to_timestamp,
      finalized_only,
      address,
      txid,
      include_inputs,
      include_outputs,
      response_format,
      limit,
      cursor,
    }) => {
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
        address = paginationCursor.request.address
        txid = paginationCursor.request.txid
        include_inputs = paginationCursor.request.include_inputs
        include_outputs = paginationCursor.request.include_outputs
        response_format = paginationCursor.request.response_format
      }
      let normalizedAddress: string | undefined
      if (address !== undefined && address.trim() !== '') {
        const trimmed = address.trim()
        if (!isValidBitcoinAddress(trimmed)) {
          throw new ActionableError(
            `Invalid Bitcoin address: ${address}.`,
            ['Provide a valid Bitcoin address starting with bc1, 1, or 3.'],
            { field: 'address' },
            { code: 'invalid_request', origin: 'client_input', retryable: false },
          )
        }
        normalizedAddress = normalizeBitcoinAddressForPortal(trimmed)
      }

      let normalizedTxid: string | undefined
      if (txid !== undefined && txid.trim() !== '') {
        const cleaned = txid.trim().toLowerCase().replace(/^0x/, '')
        if (!/^[0-9a-f]{64}$/.test(cleaned)) {
          throw new ActionableError(
            `Invalid Bitcoin txid: ${txid}. Expected a 64-character hex transaction ID.`,
            ['Provide a 64-character hex Bitcoin txid/hash and narrow the block window or timeframe.'],
            { field: 'txid' },
            { code: 'invalid_request', origin: 'client_input', retryable: false },
          )
        }
        normalizedTxid = cleaned
      }

      const effectiveResponseFormat = resolveDefaultResponseFormat(response_format)

      const resolvedBlocks = paginationCursor
        ? {
            from_block: paginationCursor.window_from_block,
            to_block: paginationCursor.window_to_block,
            range_kind:
              paginationCursor.request.from_timestamp !== undefined ||
              paginationCursor.request.to_timestamp !== undefined
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

      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      let results: unknown[] = []
      let recentScan: { exhausted: boolean } | undefined
      let txidScannedBlocks: number | undefined

      if (normalizedTxid) {
        const matchedBlocks: unknown[] = []
        let foundMatch = false
        const txidScan = await scanBoundedBlockRange<unknown>({
          fromBlock: resolvedFromBlock,
          toBlock: pageToBlock,
          chunkSize: 10,
          scanOrder: 'latest',
          maxScanBlocks: Math.min(200, pageToBlock - resolvedFromBlock + 1),
          shouldContinue: () => !foundMatch,
          fetchChunk: async (chunk) => {
            const chunkBlocks = await portalFetchStreamRange(`${PORTAL_URL}/datasets/${dataset}/stream`, {
              type: 'bitcoin',
              fromBlock: chunk.fromBlock,
              toBlock: chunk.toBlock,
              fields: {
                block: buildBitcoinBlockFields(),
                transaction: buildBitcoinTransactionFields(),
                ...(normalizedAddress
                  ? {
                      input: { transactionIndex: true, prevoutScriptPubKeyAddress: true },
                      output: { transactionIndex: true, scriptPubKeyAddress: true },
                    }
                  : {}),
              },
              transactions: [{}],
              ...(normalizedAddress
                ? {
                    inputs: [{ prevoutScriptPubKeyAddress: [normalizedAddress] }],
                    outputs: [{ scriptPubKeyAddress: [normalizedAddress] }],
                  }
                : {}),
            })
            const matching = chunkBlocks
              .map((rawBlock) => {
                const block = rawBlock as Record<string, unknown> & {
                  transactions?: Record<string, unknown>[]
                  inputs?: Array<{ transactionIndex?: number; prevoutScriptPubKeyAddress?: string }>
                  outputs?: Array<{ transactionIndex?: number; scriptPubKeyAddress?: string }>
                }
                const addressTxIndices = normalizedAddress
                  ? new Set<number>([
                      ...(block.inputs ?? [])
                        .filter((inp) => inp.prevoutScriptPubKeyAddress === normalizedAddress)
                        .map((inp) => inp.transactionIndex)
                        .filter((idx): idx is number => typeof idx === 'number'),
                      ...(block.outputs ?? [])
                        .filter((out) => out.scriptPubKeyAddress === normalizedAddress)
                        .map((out) => out.transactionIndex)
                        .filter((idx): idx is number => typeof idx === 'number'),
                    ])
                  : undefined
                const matchingTxs = (block.transactions ?? []).filter((tx) => {
                  const rawTxid = String(tx.txid ?? '').toLowerCase()
                  const rawHash = String(tx.hash ?? '').toLowerCase()
                  if (rawTxid !== normalizedTxid && rawHash !== normalizedTxid) return false
                  if (addressTxIndices) {
                    const idx = typeof tx.transactionIndex === 'number' ? tx.transactionIndex : undefined
                    return idx !== undefined && addressTxIndices.has(idx)
                  }
                  return true
                })
                if (matchingTxs.length === 0) return undefined
                foundMatch = true
                return { ...block, transactions: matchingTxs }
              })
              .filter(Boolean)
            matchedBlocks.push(...matching)
            return matching
          },
        })
        results = matchedBlocks
        txidScannedBlocks = txidScan.scannedBlocks
        recentScan = { exhausted: !txidScan.hasUnscannedBlocks || foundMatch }
      } else if (normalizedAddress) {
        const streamUrl = `${PORTAL_URL}/datasets/${dataset}/stream`
        const [outputFetch, inputFetch] = await Promise.all([
          portalFetchRecentRecordsWithScan(
            streamUrl,
            {
              type: 'bitcoin',
              fromBlock: resolvedFromBlock,
              toBlock: pageToBlock,
              fields: {
                block: buildBitcoinBlockFields(),
                output: { transactionIndex: true, scriptPubKeyAddress: true },
                transaction: buildBitcoinTransactionFields(),
              },
              outputs: [{ scriptPubKeyAddress: [normalizedAddress], transaction: true }],
            },
            {
              itemKeys: ['transactions'],
              limit: fetchLimit,
              chunkSize: 50,
            },
          ),
          portalFetchRecentRecordsWithScan(
            streamUrl,
            {
              type: 'bitcoin',
              fromBlock: resolvedFromBlock,
              toBlock: pageToBlock,
              fields: {
                block: buildBitcoinBlockFields(),
                input: { transactionIndex: true, prevoutScriptPubKeyAddress: true },
                transaction: buildBitcoinTransactionFields(),
              },
              inputs: [{ prevoutScriptPubKeyAddress: [normalizedAddress], transaction: true }],
            },
            {
              itemKeys: ['transactions'],
              limit: fetchLimit,
              chunkSize: 50,
            },
          ),
        ])
        results = [...outputFetch.records, ...inputFetch.records]
        recentScan = {
          exhausted: (outputFetch.scan?.exhausted ?? true) && (inputFetch.scan?.exhausted ?? true),
        }
      } else {
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
        const fetched = await portalFetchRecentRecordsWithScan(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
          itemKeys: ['transactions'],
          limit: fetchLimit,
          chunkSize: 20,
        })
        results = fetched.records
        recentScan = fetched.scan
      }

      const seenTxKeys = new Set<string>()
      const allTxs = sortTransactions(
        results.flatMap((block: unknown) => {
          const typedBlock = block as {
            number?: number
            timestamp?: number
            header?: { number?: number; timestamp?: number }
            transactions?: Record<string, unknown>[]
          }
          const blockNumber = typedBlock.number ?? typedBlock.header?.number
          const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

          return (typedBlock.transactions || [])
            .map(
              (tx) =>
                normalizeBitcoinTransactionResult({
                  ...tx,
                  ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
                  ...(timestamp !== undefined ? { timestamp } : {}),
                }) as BitcoinTransactionItem,
            )
            .filter((tx) => {
              const dedupeKey = `${tx.block_number ?? ''}:${tx.transactionIndex ?? ''}:${tx.txid ?? tx.tx_hash ?? ''}`
              if (seenTxKeys.has(dedupeKey)) return false
              seenTxKeys.add(dedupeKey)
              return true
            })
        }),
      )
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
      const nextCursor =
        page.hasMore && page.nextBoundary
          ? encodeRecentPageCursor<BitcoinTransactionsRequest>({
              tool: 'portal_bitcoin_query_transactions',
              dataset,
              request: {
                ...(timeframe ? { timeframe } : {}),
                ...(from_timestamp !== undefined ? { from_timestamp } : {}),
                ...(to_timestamp !== undefined ? { to_timestamp } : {}),
                limit,
                finalized_only,
                ...(normalizedAddress ? { address: normalizedAddress } : {}),
                ...(normalizedTxid ? { txid: normalizedTxid } : {}),
                include_inputs,
                include_outputs,
                response_format: effectiveResponseFormat,
              },
              window_from_block: resolvedFromBlock,
              window_to_block: endBlock,
              page_to_block: page.nextBoundary.page_to_block,
              skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
            })
          : undefined
      let pageItems = page.pageItems
      let inlineHydratedBlockCount = 0
      if ((include_inputs || include_outputs) && pageItems.length > 0) {
        const txKeys = new Set(
          pageItems
            .map((item) => {
              const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
              const transactionIndex =
                typeof item.transactionIndex === 'number'
                  ? item.transactionIndex
                  : typeof item.transactionIndex === 'string'
                    ? Number(item.transactionIndex)
                    : undefined
              return blockNumber !== undefined && Number.isFinite(transactionIndex)
                ? `${blockNumber}:${transactionIndex}`
                : undefined
            })
            .filter((value): value is string => Boolean(value)),
        )
        const selectedBlockNumbers = Array.from(
          new Set(
            pageItems
              .map((item) => (typeof item.block_number === 'number' ? item.block_number : undefined))
              .filter((value): value is number => value !== undefined),
          ),
        )
        inlineHydratedBlockCount = selectedBlockNumbers.length
        const inlineBlocks = (
          await Promise.all(
            selectedBlockNumbers.map((blockNumber) =>
              portalFetchStreamRange(`${PORTAL_URL}/datasets/${dataset}/stream`, {
                type: 'bitcoin',
                fromBlock: blockNumber,
                toBlock: blockNumber,
                fields: {
                  block: { number: true },
                  ...(include_inputs ? { input: inlineInputFields } : {}),
                  ...(include_outputs ? { output: inlineOutputFields } : {}),
                },
                ...(include_inputs ? { inputs: [{}] } : {}),
                ...(include_outputs ? { outputs: [{}] } : {}),
              }),
            ),
          )
        ).flat()

        const inputsByTx = new Map<string, Record<string, unknown>[]>()
        for (const block of inlineBlocks as any[]) {
          const blockNumber =
            typeof block.number === 'number'
              ? block.number
              : typeof block.header?.number === 'number'
                ? block.header.number
                : undefined
          for (const input of block.inputs || []) {
            const transactionIndex =
              typeof input.transactionIndex === 'number'
                ? input.transactionIndex
                : typeof input.transactionIndex === 'string'
                  ? Number(input.transactionIndex)
                  : undefined
            if (blockNumber === undefined || !Number.isFinite(transactionIndex)) continue
            const txKey = `${blockNumber}:${transactionIndex}`
            if (!txKeys.has(txKey)) continue
            if (!inputsByTx.has(txKey)) inputsByTx.set(txKey, [])
            inputsByTx.get(txKey)!.push(
              normalizeBitcoinInputResult({
                ...input,
                block_number: blockNumber,
              }),
            )
          }
        }
        const outputsByTx = new Map<string, Record<string, unknown>[]>()
        for (const block of inlineBlocks as any[]) {
          const blockNumber =
            typeof block.number === 'number'
              ? block.number
              : typeof block.header?.number === 'number'
                ? block.header.number
                : undefined
          for (const output of block.outputs || []) {
            const transactionIndex =
              typeof output.transactionIndex === 'number'
                ? output.transactionIndex
                : typeof output.transactionIndex === 'string'
                  ? Number(output.transactionIndex)
                  : undefined
            if (blockNumber === undefined || !Number.isFinite(transactionIndex)) continue
            const txKey = `${blockNumber}:${transactionIndex}`
            if (!txKeys.has(txKey)) continue
            if (!outputsByTx.has(txKey)) outputsByTx.set(txKey, [])
            outputsByTx.get(txKey)!.push(
              normalizeBitcoinOutputResult({
                ...output,
                block_number: blockNumber,
              }),
            )
          }
        }

        pageItems = pageItems.map((item) => {
          const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
          const transactionIndex =
            typeof item.transactionIndex === 'number'
              ? item.transactionIndex
              : typeof item.transactionIndex === 'string'
                ? Number(item.transactionIndex)
                : undefined
          const txKey =
            blockNumber !== undefined && Number.isFinite(transactionIndex) ? `${blockNumber}:${transactionIndex}` : ''
          return {
            ...item,
            ...(include_inputs ? { inputs: inputsByTx.get(txKey) || [] } : {}),
            ...(include_outputs ? { outputs: outputsByTx.get(txKey) || [] } : {}),
          }
        })
      }

      const formattedData = applyResponseFormat(pageItems, effectiveResponseFormat, 'bitcoin_transactions')
      const notices = getTimestampWindowNotices(resolvedBlocks)
      if (normalizedTxid && pageItems.length === 0 && recentScan?.exhausted === false) {
        notices.push(
          `Transaction lookup stopped after scanning ${txidScannedBlocks ?? 0} Bitcoin blocks without a match. Pass from_block/to_block around the target block to search an older window.`,
        )
      }
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
        windowComplete: recentScan?.exhausted ?? true,
      })

      const message =
        effectiveResponseFormat === 'summary'
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
          response_format: effectiveResponseFormat,
          finalized_only,
          limit,
          from_block: resolvedFromBlock,
          to_block: endBlock,
          page_to_block: pageToBlock,
          range_kind: resolvedBlocks.range_kind,
          normalized_output: true,
          notes: [
            include_inputs || include_outputs
              ? `Inputs and/or outputs were attached inline for returned transactions by hydrating ${inlineHydratedBlockCount} selected block${inlineHydratedBlockCount === 1 ? '' : 's'}.`
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
