import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { findTokenByAddress, findTokensBySymbol, getCoinGeckoTokenList } from '../../helpers/external-apis.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Get Token Info
// ============================================================================

/**
 * Get rich token metadata from CoinGecko token lists
 */
export function registerGetTokenInfoTool(server: McpServer) {
  server.tool(
    'portal_get_token_info',
    `Get token metadata (name, symbol, decimals, logo) from CoinGecko. Look up by address or symbol.`,
    {
      chain: z
        .enum(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'bsc'])
        .describe('Blockchain network'),
      address: z.string().optional().describe('Token contract address (if looking up specific token)'),
      symbol: z.string().optional().describe("Token symbol (e.g., 'USDC', 'WETH')"),
      limit: z.number().optional().default(100).describe('Max tokens to return when fetching all (default 100)'),
    },
    async ({ chain, address, symbol, limit }) => {
      const queryStartTime = Date.now()

      if (address) {
        // Look up specific token by address
        const token = await findTokenByAddress(chain, address)
        if (!token) {
          throw new Error(`Token not found: ${address} on ${chain}`)
        }

        return formatResult(token, `Found token: ${token.name} (${token.symbol})`, {
          metadata: {
            query_start_time: queryStartTime,
          },
        })
      } else if (symbol) {
        // Look up tokens by symbol
        const tokens = await findTokensBySymbol(chain, symbol)
        if (tokens.length === 0) {
          throw new Error(`No tokens found with symbol ${symbol} on ${chain}`)
        }

        return formatResult(tokens, `Found ${tokens.length} token(s) with symbol ${symbol}`, {
          metadata: {
            query_start_time: queryStartTime,
          },
        })
      } else {
        // Get all tokens (limited)
        const allTokens = await getCoinGeckoTokenList(chain)
        const limitedTokens = allTokens.slice(0, limit)

        return formatResult(
          limitedTokens,
          `Retrieved ${limitedTokens.length} tokens from ${chain} (total: ${allTokens.length})`,
          {
            metadata: {
              query_start_time: queryStartTime,
            },
          },
        )
      }
    },
  )
}
