import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { formatTokenValue, getKnownTokenDecimals } from '../../helpers/conversions.js'
import { getCoinGeckoTokenList } from '../../helpers/external-apis.js'
import { portalFetch, portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeAddresses, normalizeEvmAddress } from '../../helpers/validation.js'
import type { BlockHead } from '../../types/index.js'

// ============================================================================
// Tool: Get ERC20 Transfers
// ============================================================================

export function registerGetErc20TransfersTool(server: McpServer) {
  server.tool(
    'portal_get_erc20_transfers',
    `Get ERC20 token transfers (USDC, DAI, USDT, etc.). Automatically filters Transfer events for you.

WHEN TO USE:
- "Track USDC transfers on Base"
- "Show all token transfers from this wallet"
- "Monitor incoming tokens to address X"
- "Get token flow between two addresses"

EASIER THAN portal_query_logs: No need to know event signatures or topics.

EXAMPLES:
- USDC transfers: { token_addresses: ["0xUSDC..."], from_block: X, to_block: Y }
- Wallet outflows: { from_addresses: ["0xWallet..."] }
- Incoming tokens: { to_addresses: ["0xWallet..."] }

FAST: <1s for 10k blocks.

SEE ALSO: portal_query_logs (more flexible), portal_get_wallet_summary (includes transactions too)`,
    {
      dataset: z.string().describe('Dataset name or alias'),
      from_block: z.number().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number. RECOMMENDED: <10k blocks for fast responses.'),
      token_addresses: z.array(z.string()).optional().describe('Token contract addresses'),
      from_addresses: z.array(z.string()).optional().describe('Sender addresses'),
      to_addresses: z.array(z.string()).optional().describe('Recipient addresses'),
      limit: z.number().optional().default(1000).describe('Max transfers'),
      include_token_info: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include token metadata (symbol, decimals) inline. Avoids separate portal_get_token_info calls.'),
    },
    async ({
      dataset,
      from_block,
      to_block,
      token_addresses,
      from_addresses,
      to_addresses,
      limit,
      include_token_info,
    }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_erc20_transfers is only for EVM chains')
      }

      const normalizedTokens = normalizeAddresses(token_addresses, chainType)
      const normalizedFrom = from_addresses
        ? from_addresses.map((a) => '0x' + normalizeEvmAddress(a).slice(2).padStart(64, '0'))
        : undefined
      const normalizedTo = to_addresses
        ? to_addresses.map((a) => '0x' + normalizeEvmAddress(a).slice(2).padStart(64, '0'))
        : undefined

      const head = await portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/head`)
      const endBlock = to_block ?? head.number

      const logFilter: Record<string, unknown> = {
        topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
      }
      if (normalizedTokens) logFilter.address = normalizedTokens
      if (normalizedFrom) logFilter.topic1 = normalizedFrom
      if (normalizedTo) logFilter.topic2 = normalizedTo

      const query = {
        type: 'evm',
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          log: buildEvmLogFields(),
        },
        logs: [logFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allTransfers = results.flatMap((block: unknown) => {
        const b = block as {
          header?: { number: number }
          logs?: Array<{
            transactionHash: string
            logIndex: number
            address: string
            topics?: string[]
            data: string
          }>
        }
        return (b.logs || []).map((log) => {
          const tokenAddress = log.address
          const decimals = getKnownTokenDecimals(tokenAddress) || 18
          const valueFormatted = formatTokenValue(log.data, decimals)

          return {
            block_number: b.header?.number,
            transaction_hash: log.transactionHash,
            log_index: log.logIndex,
            token_address: tokenAddress,
            from: '0x' + (log.topics?.[1]?.slice(-40) || ''),
            to: '0x' + (log.topics?.[2]?.slice(-40) || ''),
            value: log.data,
            value_decimal: valueFormatted.decimal,
            value_formatted: valueFormatted.formatted,
          }
        })
      })

      const limitedTransfers = allTransfers.slice(0, limit)

      // Optionally enrich with token metadata
      let enrichedTransfers = limitedTransfers
      if (include_token_info) {
        try {
          // Map dataset to chain for CoinGecko
          const chainMap: Record<string, string> = {
            'base-mainnet': 'base',
            'ethereum-mainnet': 'ethereum',
            'arbitrum-one': 'arbitrum',
            'optimism-mainnet': 'optimism',
            'polygon-mainnet': 'polygon',
            'avalanche-mainnet': 'avalanche',
            'bsc-mainnet': 'bsc',
          }
          const chain = chainMap[dataset] || dataset.split('-')[0]

          const tokenList = await getCoinGeckoTokenList(chain)
          const tokenMap = new Map(tokenList.map((t) => [t.address.toLowerCase(), t]))

          enrichedTransfers = limitedTransfers.map((transfer: any) => {
            const tokenInfo = tokenMap.get(transfer.token_address.toLowerCase())
            if (tokenInfo) {
              return {
                ...transfer,
                token_symbol: tokenInfo.symbol,
                token_name: tokenInfo.name,
                token_decimals: tokenInfo.decimals,
              }
            }
            return transfer
          })
        } catch (error) {
          // If token info fetch fails, continue without it
          console.error('Failed to fetch token info:', error)
        }
      }

      return formatResult(
        enrichedTransfers,
        `Retrieved ${limitedTransfers.length} ERC20 transfers${allTransfers.length > limit ? ` (total found: ${allTransfers.length})` : ''}`,
        {
          maxItems: limit,
          warnOnTruncation: false,
          metadata: {
            dataset,
            from_block,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
