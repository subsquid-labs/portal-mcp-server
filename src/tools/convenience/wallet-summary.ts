import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { getKnownTokenDecimals } from '../../helpers/conversions.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatTokenAmount, formatTransactionFields, hexToBigInt } from '../../helpers/formatting.js'
import { encodeCursor, decodeCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { normalizeEvmAddress } from '../../helpers/validation.js'

// ============================================================================
// Tool: Get Wallet Summary (Convenience Wrapper)
// ============================================================================

/**
 * One-call wallet activity summary.
 * Combines multiple queries into a single comprehensive view:
 * - Recent transactions sent
 * - Recent transactions received
 * - Token transfers (ERC20)
 * - NFT transfers (ERC721/1155)
 */

type WalletBoundaryCursor = {
  page_to_block: number
  skip_inclusive_block: number
}

type WalletSummaryCursor = {
  tool: 'portal_get_wallet_summary'
  dataset: string
  address: string
  timeframe: string
  include_tokens: boolean
  include_nfts: boolean
  limit_per_type: number
  window_from_block: number
  window_to_block: number
  sections: {
    transactions: WalletBoundaryCursor | null
    token_transfers?: WalletBoundaryCursor | null
    nft_transfers?: WalletBoundaryCursor | null
  }
}

type WalletTransactionItem = Record<string, unknown> & {
  block_number?: number
  transactionIndex?: number
  from?: string
}

type WalletLogItem = Record<string, unknown> & {
  block_number?: number
  log_index?: number
}

function getBlockNumber(item: { block_number?: number }) {
  return typeof item.block_number === 'number' ? item.block_number : undefined
}

function getTransactionIndex(item: WalletTransactionItem): number {
  if (typeof item.transactionIndex === 'number') {
    return item.transactionIndex
  }
  if (typeof item.transactionIndex === 'string') {
    const parsed = Number(item.transactionIndex)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function getLogIndex(item: WalletLogItem): number {
  if (typeof item.log_index === 'number') {
    return item.log_index
  }
  if (typeof item.log_index === 'string') {
    const parsed = Number(item.log_index)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function sortTransactions(items: WalletTransactionItem[]) {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) {
      return leftBlock - rightBlock
    }

    const leftIndex = getTransactionIndex(left)
    const rightIndex = getTransactionIndex(right)
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex
    }

    return String(left['hash'] ?? '').localeCompare(String(right['hash'] ?? ''))
  })
}

function sortLogs(items: WalletLogItem[]) {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) {
      return leftBlock - rightBlock
    }

    const leftIndex = getLogIndex(left)
    const rightIndex = getLogIndex(right)
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex
    }

    return String(left['transaction_hash'] ?? '').localeCompare(String(right['transaction_hash'] ?? ''))
  })
}

function describeWalletWindow(timeframe: string) {
  return /^\d+$/.test(timeframe) ? `last ${timeframe} blocks` : `last ${timeframe}`
}

function createWalletSummaryCursor(params: Omit<WalletSummaryCursor, 'tool'>) {
  return encodeCursor({
    tool: 'portal_get_wallet_summary',
    ...params,
  })
}

function buildSectionPagination(returned: number, hasMore: boolean) {
  return {
    returned,
    has_more: hasMore,
  }
}

export function registerGetWalletSummaryTool(server: McpServer) {
  server.tool(
    'portal_get_wallet_summary',
    `Get wallet activity summary: recent transactions, ERC20 token transfers, and optionally NFT transfers for an address over a time period.`,
    {
      dataset: z.string().optional().describe('Dataset name or alias. Optional when continuing with cursor.'),
      address: z.string().optional().describe('Wallet address to analyze. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .default('1000')
        .describe("Look-back period as timeframe or block count. Examples: '1h', '24h', '7d', '3d', '1000'."),
      include_tokens: z.boolean().optional().default(true).describe('Include ERC20 token transfers'),
      include_nfts: z.boolean().optional().default(false).describe('Include NFT transfers (ERC721/1155)'),
      limit_per_type: z.number().optional().default(10).describe('Max items per category (txs, tokens, nfts)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ dataset, address, timeframe, include_tokens, include_nfts, limit_per_type, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor ? decodeCursor<WalletSummaryCursor>(cursor, 'portal_get_wallet_summary') : undefined
      const requestedDataset = dataset ? await resolveDataset(dataset) : undefined
      dataset = paginationCursor?.dataset ?? requestedDataset
      if (!dataset) {
        throw new ActionableError('dataset is required unless you are continuing with cursor.', [
          'Provide dataset for a fresh wallet summary.',
          'Reuse _pagination.next_cursor from a previous response to continue paging.',
        ])
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_wallet_summary',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_get_recent_transactions for Solana or Bitcoin wallet previews.',
            'Use portal_query_hyperliquid_fills for Hyperliquid accounts.',
          ],
        })
      }

      const requestedAddress = address ? normalizeEvmAddress(address) : undefined
      const normalizedAddress = paginationCursor?.address ?? requestedAddress
      if (!normalizedAddress) {
        throw new ActionableError('address is required unless you are continuing with cursor.', [
          'Provide address for a fresh wallet summary.',
          'Reuse _pagination.next_cursor from a previous response to continue paging.',
        ])
      }

      if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
        throw new ActionableError('This cursor belongs to a different dataset.', [
          'Reuse the cursor with the same dataset and wallet address.',
          'Omit cursor to start a fresh wallet summary.',
        ], {
          cursor_dataset: paginationCursor.dataset,
          requested_dataset: requestedDataset,
        })
      }
      if (paginationCursor && requestedAddress && paginationCursor.address !== requestedAddress) {
        throw new ActionableError('This cursor belongs to a different wallet address.', [
          'Reuse the cursor with the same wallet address as the previous response.',
          'Omit cursor to start a fresh wallet summary.',
        ], {
          cursor_address: paginationCursor.address,
          requested_address: requestedAddress,
        })
      }

      if (paginationCursor) {
        timeframe = paginationCursor.timeframe
        include_tokens = paginationCursor.include_tokens
        include_nfts = paginationCursor.include_nfts
        limit_per_type = paginationCursor.limit_per_type
      }

      // Resolve block range — numeric values are exact block counts,
      // time-based values use Portal's /timestamps/ API
      let fromBlock: number
      let windowToBlock: number

      if (paginationCursor) {
        fromBlock = paginationCursor.window_from_block
        windowToBlock = paginationCursor.window_to_block
      } else {
        const isBlockCount = /^\d+$/.test(timeframe)
        if (isBlockCount) {
          const head = await getBlockHead(dataset)
          const blockRange = parseInt(timeframe, 10)
          windowToBlock = head.number
          fromBlock = Math.max(0, windowToBlock - blockRange)
        } else {
          const resolved = await resolveTimeframeOrBlocks({ dataset, timeframe })
          fromBlock = resolved.from_block
          windowToBlock = resolved.to_block
        }
      }

      const includeL2 = isL2Chain(dataset)
      const sectionCursors = paginationCursor?.sections ?? {
        transactions: undefined,
        token_transfers: include_tokens ? undefined : null,
        nft_transfers: include_nfts ? undefined : null,
      }

      // Query 1: Transactions
      // Use minimal transaction fields for summary (avoid context bloat)
      const txFields: Record<string, boolean> = {
        transactionIndex: true,
        hash: true,
        from: true,
        to: true,
        value: true,
        nonce: true,
        gas: true,
        gasPrice: true,
        gasUsed: true,
        effectiveGasPrice: true,
        type: true,
        status: true,
        sighash: true,
        contractAddress: true,
      }

      if (includeL2) {
        txFields.l1Fee = true
        txFields.l1GasUsed = true
      }

      let transactions: WalletTransactionItem[] = []
      let txHasMore = false
      let txNextBoundary: WalletBoundaryCursor | null = null

      if (sectionCursors.transactions !== null) {
        const txCursor = sectionCursors.transactions ?? undefined
        const txQuery = {
          type: 'evm',
          fromBlock,
          toBlock: txCursor?.page_to_block ?? windowToBlock,
          fields: {
            block: { number: true, timestamp: true },
            transaction: txFields,
          },
          transactions: [{ from: [normalizedAddress] }, { to: [normalizedAddress] }],
        }

        const txFetchLimit = limit_per_type + (txCursor?.skip_inclusive_block ?? 0) + 1
        const txResults = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, txQuery, {
          itemKeys: ['transactions'],
          limit: txFetchLimit,
          chunkSize: 250,
        })

        const pagedTransactions = paginateAscendingItems(
          sortTransactions(
            txResults.flatMap((block: unknown) => {
              const typedBlock = block as {
                number?: number
                timestamp?: number
                header?: { number?: number; timestamp?: number }
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
                }) as WalletTransactionItem,
              )
            }),
          ),
          limit_per_type,
          getBlockNumber,
          txCursor,
        )

        transactions = pagedTransactions.pageItems
        txHasMore = pagedTransactions.hasMore
        txNextBoundary = pagedTransactions.hasMore ? pagedTransactions.nextBoundary ?? null : null
      }

      // Query 2: Token Transfers (if requested)
      let tokenTransfers: WalletLogItem[] = []
      let tokenHasMore = false
      let tokenNextBoundary: WalletBoundaryCursor | null = null

      if (include_tokens && sectionCursors.token_transfers !== null) {
        const tokenCursor = sectionCursors.token_transfers ?? undefined
        const paddedAddress = '0x' + normalizedAddress.slice(2).padStart(64, '0')
        const tokenQuery = {
          type: 'evm',
          fromBlock,
          toBlock: tokenCursor?.page_to_block ?? windowToBlock,
          fields: {
            block: { number: true, timestamp: true },
            log: buildEvmLogFields(),
          },
          logs: [
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
              topic1: [paddedAddress],
            },
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
              topic2: [paddedAddress],
            },
          ],
        }

        const tokenFetchLimit = limit_per_type + (tokenCursor?.skip_inclusive_block ?? 0) + 1
        const tokenResults = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, tokenQuery, {
          itemKeys: ['logs'],
          limit: tokenFetchLimit,
          chunkSize: 250,
        })

        const pagedTokens = paginateAscendingItems(
          sortLogs(
            tokenResults.flatMap((block: unknown) => {
              const typedBlock = block as {
                header?: { number: number; timestamp: number }
                logs?: Array<{
                  transactionHash: string
                  logIndex: number
                  address: string
                  topics?: string[]
                  data: string
                }>
              }

              return (typedBlock.logs || []).map((log) => {
                const tokenAddress = log.address.toLowerCase()
                const rawValue = log.data
                const decimals = getKnownTokenDecimals(tokenAddress) ?? 18
                const formattedValue = formatTokenAmount(rawValue, decimals, undefined)

                return {
                  block_number: typedBlock.header?.number,
                  timestamp: typedBlock.header?.timestamp,
                  timestamp_human: typedBlock.header?.timestamp ? formatTimestamp(typedBlock.header.timestamp) : undefined,
                  transaction_hash: log.transactionHash,
                  log_index: log.logIndex,
                  token_address: tokenAddress,
                  token_name: undefined,
                  token_symbol: undefined,
                  from: '0x' + (log.topics?.[1]?.slice(-40) || ''),
                  to: '0x' + (log.topics?.[2]?.slice(-40) || ''),
                  value_raw: rawValue,
                  value: formattedValue,
                  value_decimal: hexToBigInt(rawValue).toString(),
                  direction: '0x' + (log.topics?.[1]?.slice(-40) || '') === normalizedAddress ? 'out' : 'in',
                } as WalletLogItem
              })
            }),
          ),
          limit_per_type,
          getBlockNumber,
          tokenCursor,
        )

        tokenTransfers = pagedTokens.pageItems
        tokenHasMore = pagedTokens.hasMore
        tokenNextBoundary = pagedTokens.hasMore ? pagedTokens.nextBoundary ?? null : null
      }

      // Query 3: NFT Transfers (if requested)
      let nftTransfers: WalletLogItem[] = []
      let nftHasMore = false
      let nftNextBoundary: WalletBoundaryCursor | null = null

      if (include_nfts && sectionCursors.nft_transfers !== null) {
        const nftCursor = sectionCursors.nft_transfers ?? undefined
        const paddedAddress = '0x' + normalizedAddress.slice(2).padStart(64, '0')
        const nftQuery = {
          type: 'evm',
          fromBlock,
          toBlock: nftCursor?.page_to_block ?? windowToBlock,
          fields: {
            block: { number: true, timestamp: true },
            log: buildEvmLogFields(),
          },
          logs: [
            {
              topic0: [
                EVENT_SIGNATURES.TRANSFER_ERC721,
                EVENT_SIGNATURES.TRANSFER_SINGLE,
                EVENT_SIGNATURES.TRANSFER_BATCH,
              ],
              topic1: [paddedAddress],
            },
            {
              topic0: [
                EVENT_SIGNATURES.TRANSFER_ERC721,
                EVENT_SIGNATURES.TRANSFER_SINGLE,
                EVENT_SIGNATURES.TRANSFER_BATCH,
              ],
              topic2: [paddedAddress],
            },
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_SINGLE, EVENT_SIGNATURES.TRANSFER_BATCH],
              topic3: [paddedAddress],
            },
          ],
        }

        const nftFetchLimit = limit_per_type + (nftCursor?.skip_inclusive_block ?? 0) + 1
        const nftResults = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, nftQuery, {
          itemKeys: ['logs'],
          limit: nftFetchLimit,
          chunkSize: 250,
        })

        const pagedNfts = paginateAscendingItems(
          sortLogs(
            nftResults.flatMap((block: unknown) => {
              const typedBlock = block as {
                header?: { number: number; timestamp: number }
                logs?: Array<{
                  transactionHash: string
                  logIndex: number
                  address: string
                  topics?: string[]
                  data: string
                }>
              }

              return (typedBlock.logs || []).map((log) => ({
                block_number: typedBlock.header?.number,
                timestamp: typedBlock.header?.timestamp,
                transaction_hash: log.transactionHash,
                log_index: log.logIndex,
                contract_address: log.address,
                token_id: log.topics?.[3],
                data: log.data,
              }) as WalletLogItem)
            }),
          ),
          limit_per_type,
          getBlockNumber,
          nftCursor,
        )

        nftTransfers = pagedNfts.pageItems
        nftHasMore = pagedNfts.hasMore
        nftNextBoundary = pagedNfts.hasMore ? pagedNfts.nextBoundary ?? null : null
      }

      const hasMore = txHasMore || tokenHasMore || nftHasMore
      const nextCursor = hasMore
        ? createWalletSummaryCursor({
            dataset,
            address: normalizedAddress,
            timeframe,
            include_tokens,
            include_nfts,
            limit_per_type,
            window_from_block: fromBlock,
            window_to_block: windowToBlock,
            sections: {
              transactions: txNextBoundary,
              ...(include_tokens ? { token_transfers: tokenNextBoundary } : {}),
              ...(include_nfts ? { nft_transfers: nftNextBoundary } : {}),
            },
          })
        : undefined

      const notices: string[] = []
      if (hasMore) {
        const limitedItems = []
        if (txHasMore) limitedItems.push('transactions')
        if (tokenHasMore) limitedItems.push('token transfers')
        if (nftHasMore) limitedItems.push('NFT transfers')
        notices.push(
          `Showing the latest ${limit_per_type} ${limitedItems.join(', ')} in this page. Use _pagination.next_cursor to continue.`,
        )
      }

      const summary: Record<string, unknown> = {
        address: normalizedAddress,
        timeframe: {
          from_block: fromBlock,
          to_block: windowToBlock,
          description: timeframe,
        },
        transactions: {
          count: transactions.length,
          sent: transactions.filter((tx) => String(tx.from || '').toLowerCase() === normalizedAddress).length,
          received: transactions.filter((tx) => String(tx.from || '').toLowerCase() !== normalizedAddress).length,
          items: transactions,
        },
        token_transfers: include_tokens
          ? {
              count: tokenTransfers.length,
              items: tokenTransfers,
            }
          : null,
        nft_transfers: include_nfts
          ? {
              count: nftTransfers.length,
              items: nftTransfers,
            }
          : null,
      }

      const message = hasMore
        ? `Wallet summary for ${normalizedAddress}: ${transactions.length} txs, ${tokenTransfers.length} token transfers, ${nftTransfers.length} NFT transfers from ${describeWalletWindow(timeframe)} (preview page capped at ${limit_per_type}).`
        : `Wallet summary for ${normalizedAddress}: ${transactions.length} txs, ${tokenTransfers.length} token transfers, ${nftTransfers.length} NFT transfers from ${describeWalletWindow(timeframe)}.`

      return formatResult(summary, message, {
        notices,
        pagination: {
          type: 'cursor',
          page_size: limit_per_type,
          returned: transactions.length + tokenTransfers.length + nftTransfers.length,
          has_more: hasMore,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
          sections: {
            transactions: buildSectionPagination(transactions.length, txHasMore),
            ...(include_tokens ? { token_transfers: buildSectionPagination(tokenTransfers.length, tokenHasMore) } : {}),
            ...(include_nfts ? { nft_transfers: buildSectionPagination(nftTransfers.length, nftHasMore) } : {}),
          },
        },
        metadata: {
          dataset,
          from_block: fromBlock,
          to_block: windowToBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
