import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { buildTableDescriptor } from '../../helpers/chart-metadata.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { getKnownTokenDecimals } from '../../helpers/conversions.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatTokenAmount, formatTransactionFields, hexToBigInt } from '../../helpers/formatting.js'
import { normalizeEvmTransactionResult } from '../../helpers/normalized-results.js'
import { encodeCursor, decodeCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildQueryFreshness, buildSectionCoverage } from '../../helpers/result-metadata.js'
import { resolveTimeframeOrBlocks, type TimestampInput } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { buildMetricCard, buildPortalUi, buildTablePanel, buildTimelinePanel, buildStatListPanel } from '../../helpers/ui-metadata.js'
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
  mode: 'fast' | 'deep'
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
  if (timeframe.includes('->')) {
    return timeframe
  }
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

function compactWalletTransactionItem(tx: WalletTransactionItem) {
  const txHash = typeof tx['hash'] === 'string' ? String(tx['hash']) : typeof tx['tx_hash'] === 'string' ? String(tx['tx_hash']) : undefined
  const timestamp = typeof tx['timestamp'] === 'number' ? Number(tx['timestamp']) : undefined

  return {
    chain_kind: 'evm',
    record_type: 'transaction',
    primary_id: txHash,
    tx_hash: txHash,
    sender: typeof tx['from'] === 'string' ? String(tx['from']) : undefined,
    recipient: typeof tx['to'] === 'string' ? String(tx['to']) : undefined,
    block_number: getBlockNumber(tx),
    transactionIndex: getTransactionIndex(tx),
    ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
    ...(tx['value'] !== undefined ? { value: tx['value'] } : {}),
    ...(tx['nonce'] !== undefined ? { nonce: tx['nonce'] } : {}),
    ...(tx['status'] !== undefined ? { status: tx['status'] } : {}),
  }
}

function compactWalletTokenTransferItem(item: WalletLogItem) {
  const txHash = typeof item['transaction_hash'] === 'string' ? String(item['transaction_hash']) : undefined
  const logIndex = typeof item['log_index'] === 'number' ? Number(item['log_index']) : undefined
  const timestamp = typeof item['timestamp'] === 'number' ? Number(item['timestamp']) : undefined

  return {
    chain_kind: 'evm',
    record_type: 'token_transfer',
    primary_id: txHash && logIndex !== undefined ? `${txHash}:${logIndex}` : txHash,
    tx_hash: txHash,
    sender: typeof item['from'] === 'string' ? String(item['from']) : undefined,
    recipient: typeof item['to'] === 'string' ? String(item['to']) : undefined,
    block_number: getBlockNumber(item),
    ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
    token_address: typeof item['token_address'] === 'string' ? String(item['token_address']) : undefined,
    value: item['value'],
    direction: item['direction'],
  }
}

function compactWalletNftTransferItem(item: WalletLogItem) {
  const txHash = typeof item['transaction_hash'] === 'string' ? String(item['transaction_hash']) : undefined
  const logIndex = typeof item['log_index'] === 'number' ? Number(item['log_index']) : undefined
  const timestamp = typeof item['timestamp'] === 'number' ? Number(item['timestamp']) : undefined

  return {
    chain_kind: 'evm',
    record_type: 'nft_transfer',
    primary_id: txHash && logIndex !== undefined ? `${txHash}:${logIndex}` : txHash,
    tx_hash: txHash,
    block_number: getBlockNumber(item),
    ...(timestamp !== undefined ? { timestamp, timestamp_human: formatTimestamp(timestamp) } : {}),
    contract_address: typeof item['contract_address'] === 'string' ? String(item['contract_address']) : undefined,
    token_id: item['token_id'],
  }
}

function buildWalletActivityTable(title: string, rowCount: number) {
  return buildTableDescriptor({
    id: 'activity',
    dataKey: 'activity.items',
    rowCount,
    title,
    subtitle: 'Normalized wallet activity rows across the selected window',
    keyField: 'primary_id',
    defaultSort: { key: 'timestamp', direction: 'asc' },
    dense: true,
    columns: [
      { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
      { key: 'record_type', label: 'Type', kind: 'dimension' },
      { key: 'primary_id', label: 'Primary id', kind: 'dimension' },
      { key: 'sender', label: 'Sender', kind: 'dimension', format: 'address' },
      { key: 'recipient', label: 'Recipient', kind: 'dimension', format: 'address' },
      { key: 'block_number', label: 'Block', kind: 'metric', format: 'integer', align: 'right' },
    ],
  })
}

function buildWalletUi(params: {
  title: string
  subtitle: string
  activityCountPath?: string
  primaryValuePath?: string
  primaryLabel?: string
  primaryFormat?: 'integer' | 'decimal' | 'currency_usd' | 'btc'
  primaryUnit?: string
  secondaryCards?: Array<ReturnType<typeof buildMetricCard>>
  panels?: Array<ReturnType<typeof buildTablePanel> | ReturnType<typeof buildTimelinePanel> | ReturnType<typeof buildStatListPanel>>
  followUpActions?: Array<{ label: string; intent: 'continue' | 'show_raw' | 'drilldown'; target?: string }>
}) {
  return buildPortalUi({
    version: 'portal_ui_v1',
    layout: 'dashboard',
    density: 'compact',
    design_intent: 'activity_investigator',
    headline: {
      title: params.title,
      subtitle: params.subtitle,
    },
    metric_cards: [
      ...(params.activityCountPath
        ? [buildMetricCard({
            id: 'activity-count',
            label: 'Activity',
            value_path: params.activityCountPath,
            format: 'integer',
            emphasis: 'primary',
          })]
        : []),
      ...(params.primaryValuePath
        ? [buildMetricCard({
            id: 'primary-value',
            label: params.primaryLabel ?? 'Primary',
            value_path: params.primaryValuePath,
            ...(params.primaryFormat ? { format: params.primaryFormat } : {}),
            ...(params.primaryUnit ? { unit: params.primaryUnit } : {}),
          })]
        : []),
      ...(params.secondaryCards ?? []),
    ],
    panels: params.panels ?? [
      buildTimelinePanel({
        id: 'wallet-timeline',
        kind: 'timeline_panel',
        title: 'Activity timeline',
        subtitle: 'Chronological wallet activity with timestamps and normalized labels.',
        data_key: 'activity.items',
        timestamp_key: 'timestamp_human',
        title_key: 'primary_id',
        subtitle_keys: ['record_type', 'sender', 'recipient'],
        badge_key: 'record_type',
        emphasis: 'primary',
      }),
      buildTablePanel({
        id: 'wallet-table',
        kind: 'table_panel',
        title: 'Activity table',
        subtitle: 'Exact normalized rows for the selected wallet window.',
        table_id: 'activity',
      }),
    ],
    follow_up_actions: params.followUpActions,
  })
}

function buildWalletLlmOverrides(vm: 'evm' | 'solana' | 'bitcoin' | 'hyperliquid') {
  const answerSequenceByVm: Record<typeof vm, string[]> = {
    evm: ['overview', 'activity.count', 'evm.transactions.count', 'assets.token_transfers', 'assets.nft_transfers', 'activity.items'],
    solana: ['overview', 'activity.count', 'solana.fee_summary.total_fees_lamports', 'solana.fee_summary.avg_fee_lamports', 'activity.items'],
    bitcoin: ['overview', 'activity.count', 'assets.total_btc_received_sats', 'assets.total_btc_spent_sats', 'bitcoin.outputs_count', 'bitcoin.inputs_count', 'activity.items'],
    hyperliquid: ['overview', 'activity.count', 'hyperliquid.fee_summary.total_fees', 'assets.volume_by_coin', 'activity.items'],
  }

  const parserNotesByVm: Record<typeof vm, string[]> = {
    evm: [
      'Start with overview and activity.count, then mention EVM transactions plus token or NFT transfer counts.',
      'activity.items is the normalized cross-chain wallet feed; evm contains the EVM-specific count breakdown.',
    ],
    solana: [
      'Start with overview and activity.count, then mention the fee summary before drilling into activity.items.',
      'activity.items is the normalized transaction feed; solana.fee_summary is the VM-specific wallet section.',
    ],
    bitcoin: [
      'Start with overview and activity.count, then mention BTC received and spent totals plus input and output counts.',
      'activity.items mixes normalized inputs and outputs; bitcoin contains the UTXO-style wallet breakdown.',
    ],
    hyperliquid: [
      'Start with overview and activity.count, then mention fee_summary and volume_by_coin before listing individual fills.',
      'activity.items is the normalized fill feed; assets.volume_by_coin is the best section for what this wallet traded.',
    ],
  }

  return {
    answer_sequence: answerSequenceByVm[vm],
    parser_notes: [
      ...parserNotesByVm[vm],
      'If _pagination.has_more is true, treat the wallet response as a preview page rather than a complete lifetime history.',
    ],
  }
}

export function registerGetWalletSummaryTool(server: McpServer) {
  const FAST_MODE_BLOCK_CAP = 3000

  server.tool(
    'portal_get_wallet_summary',
    buildToolDescription('portal_get_wallet_summary'),
    {
      network: z.string().optional().describe('Network name or alias. Optional when continuing with cursor.'),
      address: z.string().optional().describe('Wallet address to analyze. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .default('1000')
        .describe("Look-back period as timeframe or block count. Examples: '1h', '24h', '7d', '3d', '1000'."),
      from_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Natural start time like "1h ago", ISO datetime, or Unix timestamp'),
      to_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Natural end time like "now", ISO datetime, or Unix timestamp'),
      include_tokens: z.boolean().optional().default(true).describe('Include ERC20 token transfers'),
      include_nfts: z.boolean().optional().default(false).describe('Include NFT transfers (ERC721/1155)'),
      limit_per_type: z.number().optional().default(10).describe('Max items per category (txs, tokens, nfts)'),
      mode: z
        .enum(['fast', 'deep'])
        .optional()
        .default('fast')
        .describe('fast = cap the scanned window for responsiveness, deep = use the full requested wallet window'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ network, address, timeframe, from_timestamp, to_timestamp, include_tokens, include_nfts, limit_per_type, mode, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor ? decodeCursor<WalletSummaryCursor>(cursor, 'portal_get_wallet_summary') : undefined
      const requestedDataset = network ? await resolveDataset(network) : undefined
      let dataset = paginationCursor?.dataset ?? requestedDataset
      if (!dataset) {
        throw new ActionableError('network is required unless you are continuing with cursor.', [
          'Provide network for a fresh wallet summary.',
          'Reuse _pagination.next_cursor from a previous response to continue paging.',
        ])
      }
      const chainType = detectChainType(dataset)

      if (chainType === 'substrate') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_wallet_summary',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin', 'hyperliquidFills'],
          suggestions: [
            'Use portal_debug_query_blocks plus a Substrate-specific event or call query for now.',
            'Add a dedicated Substrate wallet summary once address and account filters are productized for Substrate networks.',
          ],
        })
      }

      if (chainType !== 'evm') {
        return await buildNonEvmWalletSummary({
          dataset,
          chainType,
          address,
          timeframe,
          from_timestamp,
          to_timestamp,
          mode,
          limit_per_type,
          queryStartTime,
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
        mode = paginationCursor.mode
        include_tokens = paginationCursor.include_tokens
        include_nfts = paginationCursor.include_nfts
        limit_per_type = paginationCursor.limit_per_type
      }

      // Resolve block range — numeric values are exact block counts,
      // time-based values use Portal's /timestamps/ API
      let fromBlock: number
      let windowToBlock: number
      let head = paginationCursor ? await getBlockHead(dataset) : undefined
      let resolvedWindow: { range_kind: string; from_lookup?: never; to_lookup?: never } | Awaited<ReturnType<typeof resolveTimeframeOrBlocks>>
      let windowDescription = timeframe

      if (paginationCursor) {
        fromBlock = paginationCursor.window_from_block
        windowToBlock = paginationCursor.window_to_block
        windowDescription = paginationCursor.timeframe
        resolvedWindow = {
          range_kind: /^\d+$/.test(timeframe) ? 'block_range' : 'timeframe',
        }
      } else {
        const isBlockCount = /^\d+$/.test(timeframe)
        if (isBlockCount && from_timestamp === undefined && to_timestamp === undefined) {
          head = await getBlockHead(dataset)
          const blockRange = parseInt(timeframe, 10)
          windowToBlock = head.number
          fromBlock = Math.max(0, windowToBlock - blockRange)
          resolvedWindow = {
            range_kind: 'block_range',
          }
        } else {
          const resolved = await resolveTimeframeOrBlocks({
            dataset,
            ...(from_timestamp !== undefined || to_timestamp !== undefined
              ? {
                  from_timestamp: from_timestamp as TimestampInput | undefined,
                  to_timestamp: to_timestamp as TimestampInput | undefined,
                }
              : { timeframe }),
          })
          fromBlock = resolved.from_block
          windowToBlock = resolved.to_block
          resolvedWindow = resolved
          head = await getBlockHead(dataset)
          if (from_timestamp !== undefined || to_timestamp !== undefined) {
            const fromLabel = resolved.from_lookup?.normalized_input ?? (from_timestamp !== undefined ? String(from_timestamp) : 'start')
            const toLabel = resolved.to_lookup?.normalized_input ?? (to_timestamp !== undefined ? String(to_timestamp) : 'now')
            windowDescription = `${fromLabel} -> ${toLabel}`
          }
        }
      }

      const requestedFromBlock = fromBlock
      if (!paginationCursor && mode === 'fast') {
        const requestedRange = windowToBlock - fromBlock + 1
        if (requestedRange > FAST_MODE_BLOCK_CAP) {
          fromBlock = Math.max(fromBlock, windowToBlock - FAST_MODE_BLOCK_CAP + 1)
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
                normalizeEvmTransactionResult(
                  formatTransactionFields({
                    ...tx,
                    ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
                    ...(timestamp !== undefined
                      ? {
                          timestamp,
                          timestamp_human: formatTimestamp(timestamp),
                        }
                      : {}),
                  }),
                ) as WalletTransactionItem,
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
            timeframe: windowDescription,
            mode,
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
      if (!paginationCursor && mode === 'fast' && fromBlock > requestedFromBlock) {
        notices.push(
          `Fast mode analyzed the most recent ${FAST_MODE_BLOCK_CAP.toLocaleString()} blocks in the requested wallet window.`,
        )
      }

      const compactTransactions = transactions.map(compactWalletTransactionItem)
      const compactTokenTransfers = tokenTransfers.map(compactWalletTokenTransferItem)
      const compactNftTransfers = nftTransfers.map(compactWalletNftTransferItem)
      const combinedActivity = [...compactTransactions, ...compactTokenTransfers, ...compactNftTransfers].sort(
        (left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0),
      )

      const summary: Record<string, unknown> = {
        overview: {
          network: dataset,
          vm: 'evm',
          address: normalizedAddress,
          from_block: requestedFromBlock,
          to_block: windowToBlock,
          analyzed_from_block: fromBlock,
          description: windowDescription,
          mode,
        },
        activity: {
          count: combinedActivity.length,
          items: combinedActivity,
        },
        assets: {
          token_transfers: include_tokens ? compactTokenTransfers.length : 0,
          nft_transfers: include_nfts ? compactNftTransfers.length : 0,
        },
        evm: {
          transactions: {
            count: compactTransactions.length,
            sent: transactions.filter((tx) => String(tx.from || '').toLowerCase() === normalizedAddress).length,
            received: transactions.filter((tx) => String(tx.from || '').toLowerCase() !== normalizedAddress).length,
          },
          token_transfers: include_tokens
            ? {
                count: compactTokenTransfers.length,
              }
            : null,
          nft_transfers: include_nfts
            ? {
                count: compactNftTransfers.length,
              }
            : null,
        },
        tables: [
          buildWalletActivityTable('Wallet activity', combinedActivity.length),
        ],
      }

      const message = hasMore
        ? `Wallet summary for ${normalizedAddress}: ${transactions.length} txs, ${tokenTransfers.length} token transfers, ${nftTransfers.length} NFT transfers from ${describeWalletWindow(windowDescription)} (preview page capped at ${limit_per_type}).`
        : `Wallet summary for ${normalizedAddress}: ${transactions.length} txs, ${tokenTransfers.length} token transfers, ${nftTransfers.length} NFT transfers from ${describeWalletWindow(windowDescription)}.`

      return formatResult(summary, message, {
        toolName: 'portal_get_wallet_summary',
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
        freshness: buildQueryFreshness({
          finality: 'latest',
          headBlockNumber: head?.number ?? windowToBlock,
          windowToBlock,
          resolvedWindow,
        }),
        coverage: buildSectionCoverage({
          windowFromBlock: requestedFromBlock,
          windowToBlock,
          hasMore,
          sections: {
            transactions: buildSectionPagination(transactions.length, txHasMore),
            ...(include_tokens ? { token_transfers: buildSectionPagination(tokenTransfers.length, tokenHasMore) } : {}),
            ...(include_nfts ? { nft_transfers: buildSectionPagination(nftTransfers.length, nftHasMore) } : {}),
          },
        }),
        execution: buildExecutionMetadata({
          mode,
          from_block: fromBlock,
          to_block: windowToBlock,
          range_kind: resolvedWindow.range_kind,
          limit: limit_per_type,
          notes: [
            include_tokens ? 'Token-transfer section included.' : 'Token-transfer section omitted.',
            include_nfts ? 'NFT section included.' : 'NFT section omitted.',
          ],
        }),
        ui: buildWalletUi({
          title: `Wallet summary: ${normalizedAddress}`,
          subtitle: `${describeWalletWindow(windowDescription)} on ${dataset}`,
          activityCountPath: 'activity.count',
          primaryValuePath: 'evm.transactions.count',
          primaryLabel: 'Transactions',
          primaryFormat: 'integer',
          secondaryCards: [
            buildMetricCard({ id: 'token-transfers', label: 'Token transfers', value_path: 'assets.token_transfers', format: 'integer' }),
            buildMetricCard({ id: 'nft-transfers', label: 'NFT transfers', value_path: 'assets.nft_transfers', format: 'integer' }),
          ],
          followUpActions: [
            ...(nextCursor ? [{ label: 'Load older wallet activity', intent: 'continue' as const, target: '_pagination.next_cursor' }] : []),
            { label: 'Show raw activity rows', intent: 'show_raw', target: 'activity.items' },
          ],
        }),
        llm: buildWalletLlmOverrides('evm'),
        metadata: {
          network: dataset,
          dataset,
          from_block: fromBlock,
          to_block: windowToBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}

async function buildNonEvmWalletSummary(params: {
  dataset: string
  chainType: ReturnType<typeof detectChainType>
  address?: string
  timeframe: string
  from_timestamp?: string | number
  to_timestamp?: string | number
  mode: 'fast' | 'deep'
  limit_per_type: number
  queryStartTime: number
}) {
  const { dataset, chainType, address, timeframe, from_timestamp, to_timestamp, mode, limit_per_type, queryStartTime } = params
  if (!address) {
    throw new ActionableError('address is required for wallet summary.', [
      'Provide address for a fresh wallet summary.',
    ])
  }

  const head = await getBlockHead(dataset)
  const resolvedWindow =
    from_timestamp !== undefined || to_timestamp !== undefined || !/^\d+$/.test(timeframe)
      ? await resolveTimeframeOrBlocks({
          dataset,
          ...(from_timestamp !== undefined || to_timestamp !== undefined
            ? {
                from_timestamp: from_timestamp as TimestampInput | undefined,
                to_timestamp: to_timestamp as TimestampInput | undefined,
              }
            : { timeframe }),
        })
      : {
          from_block: Math.max(0, head.number - parseInt(timeframe, 10)),
          to_block: head.number,
          range_kind: 'block_range' as const,
        }

  const requestedFromBlock = resolvedWindow.from_block
  const toBlock = resolvedWindow.to_block
  let fromBlock = requestedFromBlock
  const notices = ['This non-EVM wallet summary currently returns a fast cross-chain overview rather than the richer EVM multi-section scan.']

  if (mode === 'fast') {
    const fastBlockCap =
      chainType === 'solana'
        ? 250
        : chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds'
          ? 2_000
          : undefined

    if (fastBlockCap !== undefined && toBlock - fromBlock + 1 > fastBlockCap) {
      fromBlock = Math.max(fromBlock, toBlock - fastBlockCap + 1)
      notices.push(`Fast mode analyzed the most recent ${fastBlockCap.toLocaleString()} blocks in the requested wallet window.`)
    }
  }

  if (chainType === 'solana') {
    const txQuery = {
      type: 'solana',
      fromBlock,
      toBlock,
      fields: {
        block: { number: true, timestamp: true },
        transaction: {
          transactionIndex: true,
          signatures: true,
          fee: true,
          feePayer: true,
          err: true,
        },
      },
      transactions: [{ feePayer: [address] }],
    }

    const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, txQuery, {
      itemKeys: ['transactions'],
      limit: limit_per_type,
      chunkSize: Math.max(25, Math.min(100, limit_per_type * 4)),
    })

    const items = results.flatMap((block: any) => {
      const blockNumber = block.number ?? block.header?.number
      const timestamp = block.timestamp ?? block.header?.timestamp
      return (block.transactions || []).map((tx: any) => ({
        ...tx,
        block_number: blockNumber,
        slot_number: blockNumber,
        timestamp,
        timestamp_human: timestamp ? formatTimestamp(timestamp) : undefined,
        primary_id: tx.signatures?.[0],
        tx_hash: tx.signatures?.[0],
        chain_kind: 'solana',
        record_type: 'transaction',
      }))
    })
    const totalFees = items.reduce((sum, item) => sum + Number(item.fee || 0), 0)

    return formatResult({
      overview: {
        network: dataset,
        vm: 'solana',
        address,
        from_block: requestedFromBlock,
        to_block: toBlock,
        analyzed_from_block: fromBlock,
        recent_activity_count: items.length,
        mode,
      },
      activity: {
        count: items.length,
        items,
      },
      assets: {
        token_balance_changes: [],
      },
      solana: {
        fee_summary: {
          total_fees_lamports: totalFees,
          avg_fee_lamports: items.length > 0 ? totalFees / items.length : 0,
        },
      },
      tables: [
        buildWalletActivityTable('Wallet activity', items.length),
      ],
    }, `Wallet summary for ${address} on ${dataset}: ${items.length} recent Solana transactions.`, {
      toolName: 'portal_get_wallet_summary',
      notices,
      pagination: buildSectionPagination(items.length, false),
      freshness: buildQueryFreshness({
        finality: 'latest',
        headBlockNumber: head.number,
        windowToBlock: toBlock,
        resolvedWindow,
      }),
      execution: buildExecutionMetadata({
        mode,
        from_block: fromBlock,
        to_block: toBlock,
        range_kind: resolvedWindow.range_kind,
        normalized_output: true,
      }),
      ui: buildWalletUi({
        title: `Wallet summary: ${address}`,
        subtitle: `${describeWalletWindow(timeframe)} on ${dataset}`,
        activityCountPath: 'activity.count',
        primaryValuePath: 'solana.fee_summary.total_fees_lamports',
        primaryLabel: 'Total fees',
        primaryFormat: 'decimal',
        secondaryCards: [
          buildMetricCard({ id: 'avg-fee', label: 'Average fee', value_path: 'solana.fee_summary.avg_fee_lamports', format: 'decimal' }),
        ],
        followUpActions: [
          { label: 'Show raw activity rows', intent: 'show_raw', target: 'activity.items' },
        ],
      }),
      llm: buildWalletLlmOverrides('solana'),
      coverage: buildSectionCoverage({
        windowFromBlock: fromBlock,
        windowToBlock: toBlock,
        hasMore: false,
        sections: {
          activity: buildSectionPagination(items.length, false),
        },
      }),
      metadata: {
        network: dataset,
        dataset,
        from_block: fromBlock,
        to_block: toBlock,
        query_start_time: queryStartTime,
      },
    })
  }

  if (chainType === 'bitcoin') {
    const [outputBlocks, inputBlocks] = await Promise.all([
      portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, {
        type: 'bitcoin',
        fromBlock,
        toBlock,
        fields: {
          block: { number: true, timestamp: true },
          output: { transactionIndex: true, outputIndex: true, value: true, scriptPubKeyAddress: true },
          transaction: { hash: true },
        },
        outputs: [{ scriptPubKeyAddress: [address], transaction: true }],
      }, {
        itemKeys: ['outputs'],
        limit: limit_per_type,
        chunkSize: 20,
      }),
      portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, {
        type: 'bitcoin',
        fromBlock,
        toBlock,
        fields: {
          block: { number: true, timestamp: true },
          input: { transactionIndex: true, inputIndex: true, prevoutValue: true, prevoutScriptPubKeyAddress: true },
          transaction: { hash: true },
        },
        inputs: [{ prevoutScriptPubKeyAddress: [address], transaction: true }],
      }, {
        itemKeys: ['inputs'],
        limit: limit_per_type,
        chunkSize: 20,
      }),
    ])

    const outputs = outputBlocks.flatMap((block: any) => (block.outputs || []).map((output: any) => ({
      ...output,
      block_number: block.number ?? block.header?.number,
      timestamp: block.timestamp ?? block.header?.timestamp,
      timestamp_human: (block.timestamp ?? block.header?.timestamp) ? formatTimestamp(block.timestamp ?? block.header?.timestamp) : undefined,
      chain_kind: 'bitcoin',
      record_type: 'output',
      primary_id: output.transaction?.hash && output.outputIndex !== undefined ? `${output.transaction.hash}:${output.outputIndex}` : output.transaction?.hash,
      tx_hash: output.transaction?.hash,
      recipient: output.scriptPubKeyAddress,
    })))
    const inputs = inputBlocks.flatMap((block: any) => (block.inputs || []).map((input: any) => ({
      ...input,
      block_number: block.number ?? block.header?.number,
      timestamp: block.timestamp ?? block.header?.timestamp,
      timestamp_human: (block.timestamp ?? block.header?.timestamp) ? formatTimestamp(block.timestamp ?? block.header?.timestamp) : undefined,
      chain_kind: 'bitcoin',
      record_type: 'input',
      primary_id: input.transaction?.hash && input.inputIndex !== undefined ? `${input.transaction.hash}:${input.inputIndex}` : input.transaction?.hash,
      tx_hash: input.transaction?.hash,
      sender: input.prevoutScriptPubKeyAddress,
    })))
    const totalIn = outputs.reduce((sum, item) => sum + Number(item.value || 0), 0)
    const totalOut = inputs.reduce((sum, item) => sum + Number(item.prevoutValue || 0), 0)

    return formatResult({
      overview: {
        network: dataset,
        vm: 'bitcoin',
        address,
        from_block: requestedFromBlock,
        to_block: toBlock,
        analyzed_from_block: fromBlock,
        mode,
      },
      activity: {
        count: outputs.length + inputs.length,
        items: [...outputs, ...inputs].sort((a, b) => (Number(a.timestamp || 0) - Number(b.timestamp || 0))),
      },
      assets: {
        total_btc_received_sats: totalIn,
        total_btc_spent_sats: totalOut,
      },
      bitcoin: {
        outputs_count: outputs.length,
        inputs_count: inputs.length,
        recent_outputs: outputs,
        recent_inputs: inputs,
      },
      tables: [
        buildWalletActivityTable('Wallet activity', outputs.length + inputs.length),
      ],
    }, `Wallet summary for ${address} on ${dataset}: ${outputs.length} recent outputs and ${inputs.length} recent inputs.`, {
      toolName: 'portal_get_wallet_summary',
      notices,
      freshness: buildQueryFreshness({
        finality: 'latest',
        headBlockNumber: head.number,
        windowToBlock: toBlock,
        resolvedWindow,
      }),
      execution: buildExecutionMetadata({
        mode,
        from_block: fromBlock,
        to_block: toBlock,
        range_kind: resolvedWindow.range_kind,
        normalized_output: true,
      }),
      ui: buildWalletUi({
        title: `Wallet summary: ${address}`,
        subtitle: `${describeWalletWindow(timeframe)} on ${dataset}`,
        activityCountPath: 'activity.count',
        primaryValuePath: 'assets.total_btc_received_sats',
        primaryLabel: 'BTC received (sats)',
        primaryFormat: 'decimal',
        secondaryCards: [
          buildMetricCard({ id: 'btc-spent', label: 'BTC spent (sats)', value_path: 'assets.total_btc_spent_sats', format: 'decimal' }),
          buildMetricCard({ id: 'outputs', label: 'Outputs', value_path: 'bitcoin.outputs_count', format: 'integer' }),
          buildMetricCard({ id: 'inputs', label: 'Inputs', value_path: 'bitcoin.inputs_count', format: 'integer' }),
        ],
        followUpActions: [
          { label: 'Show raw activity rows', intent: 'show_raw', target: 'activity.items' },
        ],
      }),
      llm: buildWalletLlmOverrides('bitcoin'),
      coverage: buildSectionCoverage({
        windowFromBlock: fromBlock,
        windowToBlock: toBlock,
        hasMore: false,
        sections: {
          activity: buildSectionPagination(outputs.length + inputs.length, false),
        },
      }),
      metadata: {
        network: dataset,
        dataset,
        from_block: fromBlock,
        to_block: toBlock,
        query_start_time: queryStartTime,
      },
    })
  }

  const fillBlocks = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, {
    type: 'hyperliquidFills',
    fromBlock,
    toBlock,
    fields: {
      block: { number: true, timestamp: true },
      fill: { fillIndex: true, user: true, coin: true, px: true, sz: true, fee: true, dir: true, side: true, hash: true, time: true },
    },
    fills: [{ user: [address.toLowerCase()] }],
  }, {
    itemKeys: ['fills'],
    limit: limit_per_type,
    chunkSize: Math.max(50, Math.min(250, limit_per_type * 10)),
    maxBytes: 25 * 1024 * 1024,
  })

  const fills = fillBlocks.flatMap((block: any) => (block.fills || []).map((fill: any) => {
    const timestamp = block.timestamp ?? block.header?.timestamp
    return {
      ...fill,
      block_number: block.number ?? block.header?.number,
      timestamp,
      timestamp_human: timestamp ? formatTimestamp(timestamp) : undefined,
      chain_kind: 'hyperliquid',
      record_type: 'fill',
      primary_id: fill.hash && fill.fillIndex !== undefined ? `${fill.hash}:${fill.fillIndex}` : fill.hash,
      tx_hash: fill.hash,
      sender: fill.user,
    }
  }))
  const byCoin = new Map<string, number>()
  let totalFees = 0
  fills.forEach((fill: any) => {
    const coin = String(fill.coin || 'UNKNOWN')
    byCoin.set(coin, (byCoin.get(coin) || 0) + Number(fill.px || 0) * Number(fill.sz || 0))
    totalFees += Math.abs(Number(fill.fee || 0))
  })

  return formatResult({
    overview: {
      network: dataset,
      vm: 'hyperliquid',
      address,
      from_block: requestedFromBlock,
      to_block: toBlock,
      analyzed_from_block: fromBlock,
      mode,
    },
    activity: {
      count: fills.length,
      items: fills,
    },
    assets: {
      volume_by_coin: Array.from(byCoin.entries()).map(([coin, volume]) => ({ coin, volume_usd: volume })),
    },
    hyperliquid: {
      fee_summary: {
        total_fees: totalFees,
      },
      side_breakdown: fills.reduce((acc: Record<string, number>, fill: any) => {
        const side = String(fill.side || 'unknown')
        acc[side] = (acc[side] || 0) + 1
        return acc
      }, {}),
    },
    tables: [
      buildWalletActivityTable('Wallet activity', fills.length),
      buildTableDescriptor({
        id: 'volume_by_coin',
        dataKey: 'assets.volume_by_coin',
        rowCount: byCoin.size,
        title: 'Volume by coin',
        subtitle: 'Coin-level notional volume for this wallet in the selected window',
        keyField: 'coin',
        defaultSort: { key: 'volume_usd', direction: 'desc' },
        dense: true,
        columns: [
          { key: 'coin', label: 'Coin', kind: 'dimension' },
          { key: 'volume_usd', label: 'Volume', kind: 'metric', format: 'currency_usd', unit: 'USD', align: 'right' },
        ],
      }),
    ],
  }, `Wallet summary for ${address} on ${dataset}: ${fills.length} recent fills.`, {
    toolName: 'portal_get_wallet_summary',
    notices,
    freshness: buildQueryFreshness({
      finality: 'latest',
      headBlockNumber: head.number,
      windowToBlock: toBlock,
      resolvedWindow,
    }),
    execution: buildExecutionMetadata({
      mode,
      from_block: fromBlock,
      to_block: toBlock,
      range_kind: resolvedWindow.range_kind,
      normalized_output: true,
    }),
    ui: buildWalletUi({
      title: `Wallet summary: ${address}`,
      subtitle: `${describeWalletWindow(timeframe)} on ${dataset}`,
      activityCountPath: 'activity.count',
      primaryValuePath: 'hyperliquid.fee_summary.total_fees',
      primaryLabel: 'Total fees',
      primaryFormat: 'decimal',
      secondaryCards: [
        buildMetricCard({ id: 'coins', label: 'Coins traded', value_path: 'assets.volume_by_coin.length', format: 'integer' }),
      ],
      panels: [
        buildTimelinePanel({
          id: 'wallet-timeline',
          kind: 'timeline_panel',
          title: 'Fill timeline',
          subtitle: 'Chronological fill activity with trader and coin context.',
          data_key: 'activity.items',
          timestamp_key: 'timestamp_human',
          title_key: 'primary_id',
          subtitle_keys: ['record_type', 'sender', 'coin'],
          badge_key: 'record_type',
          emphasis: 'primary',
        }),
        buildTablePanel({
          id: 'wallet-table',
          kind: 'table_panel',
          title: 'Fill activity table',
          subtitle: 'Exact normalized fill rows.',
          table_id: 'activity',
        }),
        buildStatListPanel({
          id: 'coin-volume',
          kind: 'stat_list_panel',
          title: 'Volume by coin',
          subtitle: 'Top coin exposure in the selected wallet window.',
          data_key: 'assets.volume_by_coin',
          label_key: 'coin',
          value_key: 'volume_usd',
          value_format: 'currency_usd',
          unit: 'USD',
        }),
      ],
      followUpActions: [
        { label: 'Show raw activity rows', intent: 'show_raw', target: 'activity.items' },
      ],
    }),
    llm: buildWalletLlmOverrides('hyperliquid'),
    coverage: buildSectionCoverage({
      windowFromBlock: fromBlock,
      windowToBlock: toBlock,
      hasMore: false,
      sections: {
        activity: buildSectionPagination(fills.length, false),
      },
    }),
    metadata: {
      network: dataset,
      dataset,
      from_block: fromBlock,
      to_block: toBlock,
      query_start_time: queryStartTime,
    },
  })
}
