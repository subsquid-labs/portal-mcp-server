import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'

import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { portalFetch, portalFetchStream } from '../../helpers/fetch.js'
import { getKnownTokenDecimals } from '../../helpers/conversions.js'
import { buildEvmLogFields, buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatTokenAmount, formatTransactionFields, hexToBigInt } from '../../helpers/formatting.js'
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
export function registerGetWalletSummaryTool(server: McpServer) {
  server.tool(
    'portal_get_wallet_summary',
    `Get wallet activity summary: recent transactions, ERC20 token transfers, and optionally NFT transfers for an address over a time period.`,
    {
      dataset: z.string().describe('Dataset name or alias'),
      address: z.string().describe('Wallet address to analyze'),
      timeframe: z
        .enum(['1h', '24h', '7d', '1000', '5000'])
        .optional()
        .default('1000')
        .describe("Look-back period: '1h'=~1 hour, '24h'=~1 day, '7d'=~1 week, or block count"),
      include_tokens: z.boolean().optional().default(true).describe('Include ERC20 token transfers'),
      include_nfts: z.boolean().optional().default(false).describe('Include NFT transfers (ERC721/1155)'),
      limit_per_type: z.number().optional().default(10).describe('Max items per category (txs, tokens, nfts)'),
    },
    async ({ dataset, address, timeframe, include_tokens, include_nfts, limit_per_type }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_wallet_summary is only for EVM chains')
      }

      const normalizedAddress = normalizeEvmAddress(address)

      // Resolve block range — numeric values are exact block counts,
      // time-based values use Portal's /timestamps/ API
      let fromBlock: number
      let toBlock: number
      const isBlockCount = /^\d+$/.test(timeframe)

      if (isBlockCount) {
        const { getBlockHead } = await import('../../cache/datasets.js')
        const head = await getBlockHead(dataset)
        const blockRange = parseInt(timeframe)
        toBlock = head.number
        fromBlock = Math.max(0, toBlock - blockRange)
      } else {
        const resolved = await resolveTimeframeOrBlocks({ dataset, timeframe })
        fromBlock = resolved.from_block
        toBlock = resolved.to_block
      }
      const includeL2 = isL2Chain(dataset)

      // Query 1: Transactions
      // Use minimal transaction fields for summary (avoid context bloat)
      const txFields: Record<string, boolean> = {
        transactionIndex: true,
        hash: true,
        from: true,
        to: true,
        value: true,
        // input: true,  // REMOVED: Can be huge, not needed in summary
        nonce: true,
        gas: true,
        gasPrice: true,
        gasUsed: true,
        // cumulativeGasUsed: true,  // REMOVED: Not useful in wallet summary
        effectiveGasPrice: true,
        type: true,
        status: true,
        sighash: true,
        contractAddress: true,
        // v: true,  // REMOVED: Signature components waste 96 bytes
        // r: true,
        // s: true,
      }

      if (includeL2) {
        txFields.l1Fee = true
        txFields.l1GasUsed = true
      }

      const txQuery = {
        type: 'evm',
        fromBlock,
        toBlock,
        fields: {
          block: { number: true, timestamp: true },
          transaction: txFields,
        },
        transactions: [{ from: [normalizedAddress] }, { to: [normalizedAddress] }],
      }

      const txResults = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, txQuery, {
        stopAfterItems: {
          keys: ['transactions'],
          limit: limit_per_type,
        },
      })

      const transactions = txResults
        .flatMap((block: unknown) => (block as { transactions?: unknown[] }).transactions || [])
        .slice(0, limit_per_type)
        .map((tx) => formatTransactionFields(tx as Record<string, unknown>))

      // Query 2: Token Transfers (if requested)
      let tokenTransfers: unknown[] = []
      if (include_tokens) {
        const paddedAddress = '0x' + normalizedAddress.slice(2).padStart(64, '0')
        const tokenQuery = {
          type: 'evm',
          fromBlock,
          toBlock,
          fields: {
            block: { number: true, timestamp: true },
            log: buildEvmLogFields(),
          },
          logs: [
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
              topic1: [paddedAddress], // from
            },
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
              topic2: [paddedAddress], // to
            },
          ],
        }

        const tokenResults = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, tokenQuery, {
          stopAfterItems: {
            keys: ['logs'],
            limit: limit_per_type,
          },
        })

        tokenTransfers = tokenResults
          .flatMap((block: unknown) => {
            const b = block as {
              header?: { number: number; timestamp: number }
              logs?: Array<{
                transactionHash: string
                logIndex: number
                address: string
                topics?: string[]
                data: string
              }>
            }
            return (b.logs || []).map((log) => {
              const tokenAddress = log.address.toLowerCase()
              const rawValue = log.data

              // Use known token decimals (e.g., 6 for USDC) or default to 18
              const decimals = getKnownTokenDecimals(tokenAddress) ?? 18
              const formattedValue = formatTokenAmount(rawValue, decimals, undefined)

              return {
                block_number: b.header?.number,
                timestamp: b.header?.timestamp,
                timestamp_human: b.header?.timestamp ? formatTimestamp(b.header.timestamp) : undefined,
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
              }
            })
          })
          .slice(0, limit_per_type)
      }

      // Query 3: NFT Transfers (if requested)
      let nftTransfers: unknown[] = []
      if (include_nfts) {
        const paddedAddress = '0x' + normalizedAddress.slice(2).padStart(64, '0')
        const nftQuery = {
          type: 'evm',
          fromBlock,
          toBlock,
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
              topic1: [paddedAddress], // from (ERC721)
            },
            {
              topic0: [
                EVENT_SIGNATURES.TRANSFER_ERC721,
                EVENT_SIGNATURES.TRANSFER_SINGLE,
                EVENT_SIGNATURES.TRANSFER_BATCH,
              ],
              topic2: [paddedAddress], // to (ERC721) or from (ERC1155)
            },
            {
              topic0: [EVENT_SIGNATURES.TRANSFER_SINGLE, EVENT_SIGNATURES.TRANSFER_BATCH],
              topic3: [paddedAddress], // to (ERC1155)
            },
          ],
        }

        const nftResults = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, nftQuery, {
          stopAfterItems: {
            keys: ['logs'],
            limit: limit_per_type,
          },
        })

        nftTransfers = nftResults
          .flatMap((block: unknown) => {
            const b = block as {
              header?: { number: number; timestamp: number }
              logs?: Array<{
                transactionHash: string
                logIndex: number
                address: string
                topics?: string[]
                data: string
              }>
            }
            return (b.logs || []).map((log) => ({
              block_number: b.header?.number,
              timestamp: b.header?.timestamp,
              transaction_hash: log.transactionHash,
              log_index: log.logIndex,
              contract_address: log.address,
              token_id: log.topics?.[3],
              data: log.data,
            }))
          })
          .slice(0, limit_per_type)
      }

      // Check if we hit the limit (partial data)
      const hitTxLimit = transactions.length === limit_per_type
      const hitTokenLimit = include_tokens && tokenTransfers.length === limit_per_type
      const hitNftLimit = include_nfts && nftTransfers.length === limit_per_type

      const summary: any = {
        address: normalizedAddress,
        timeframe: {
          from_block: fromBlock,
          to_block: toBlock,
          description: timeframe,
        },
        transactions: {
          count: transactions.length,
          sent: (transactions as Array<{ from: string }>).filter((tx) => tx.from.toLowerCase() === normalizedAddress)
            .length,
          received: (transactions as Array<{ from: string }>).filter(
            (tx) => tx.from.toLowerCase() !== normalizedAddress,
          ).length,
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

      // Add an informational note if we hit preview limits.
      if (hitTxLimit || hitTokenLimit || hitNftLimit) {
        const limitedItems = []
        if (hitTxLimit) limitedItems.push('transactions')
        if (hitTokenLimit) limitedItems.push('token transfers')
        if (hitNftLimit) limitedItems.push('NFT transfers')
        summary.notice = `Showing the first ${limit_per_type} ${limitedItems.join(', ')}. Increase limit_per_type to fetch more activity.`
      }

      const message =
        hitTxLimit || hitTokenLimit || hitNftLimit
          ? `Wallet summary for ${normalizedAddress}: ${transactions.length} txs, ${tokenTransfers.length} token transfers, ${nftTransfers.length} NFT transfers. Showing a preview capped by limit_per_type=${limit_per_type}.`
          : `Wallet summary for ${normalizedAddress}: ${transactions.length} txs, ${tokenTransfers.length} token transfers, ${nftTransfers.length} NFT transfers`

      return formatResult(summary, message, {
        metadata: {
          dataset,
          from_block: fromBlock,
          to_block: toBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
