import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStreamRange } from '../../helpers/fetch.js'
import { buildBitcoinBlockFields, buildBitcoinTransactionFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { applyResponseFormat, type ResponseFormat } from '../../helpers/response-modes.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

export function registerQueryBitcoinTransactionsTool(server: McpServer) {
  server.tool(
    'portal_query_bitcoin_transactions',
    `Query Bitcoin transactions. Returns transaction-level data (txid, size, weight, version, locktime).

WHEN TO USE:
- "Show recent Bitcoin transactions"
- "Get transaction details from Bitcoin"

NOTE: Bitcoin uses UTXO model. For address-specific queries, use portal_query_bitcoin_inputs
(spending from address) or portal_query_bitcoin_outputs (receiving to address).

EXAMPLES:
- Recent txs: { dataset: "bitcoin-mainnet", timeframe: "1h", limit: 10 }
- Block range: { dataset: "bitcoin-mainnet", from_block: 800000, to_block: 800010 }`,
    {
      dataset: z.string().default('bitcoin-mainnet').describe('Dataset name (default: bitcoin-mainnet)'),
      from_block: z.number().optional().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().default('full').describe("Response format: 'summary' (stats only, ~90% smaller), 'compact' (hash+size+weight only, ~50% smaller), 'full' (all fields)"),
      limit: z.number().optional().default(50).describe('Max transactions to return (default: 50)'),
    },
    async ({ dataset, from_block, to_block, timeframe, finalized_only, response_format, limit }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'bitcoin') {
        throw createUnsupportedChainError({
          toolName: 'portal_query_bitcoin_transactions',
          dataset,
          actualChainType: chainType,
          supportedChains: ['bitcoin'],
          suggestions: [
            'Use portal_query_transactions for EVM datasets.',
            'Use portal_query_solana_transactions for Solana datasets.',
          ],
        })
      }

      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      const query = {
        type: 'bitcoin',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields: {
          block: buildBitcoinBlockFields(),
          transaction: buildBitcoinTransactionFields(),
        },
        transactions: [{}],
      }

      // Cap blocks to prevent OOM — Bitcoin blocks are very dense (~4k txs each)
      const blockRange = endBlock - resolvedFromBlock
      const maxBlocks = Math.min(blockRange, Math.max(20, Math.ceil(limit / 100)))
      const results = await portalFetchStreamRange(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        maxBlocks,
        maxBytes: 100 * 1024 * 1024,
        stopAfterItems: {
          keys: ['transactions'],
          limit,
        },
      })

      const allTxs = results.flatMap(
        (block: unknown) => (block as { transactions?: unknown[] }).transactions || [],
      )
      const limitedTxs = allTxs.slice(0, limit)
      const formattedData = applyResponseFormat(limitedTxs, response_format as ResponseFormat, 'bitcoin_transactions')

      const message = response_format === 'summary'
        ? `Summary of ${limitedTxs.length} Bitcoin transactions`
        : `Retrieved ${limitedTxs.length} Bitcoin transactions`

      return formatResult(formattedData, message, {
        maxItems: limit,
        warnOnTruncation: false,
        metadata: {
          dataset,
          from_block: resolvedFromBlock,
          to_block: endBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
