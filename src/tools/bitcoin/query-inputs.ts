import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import {
  buildBitcoinInputFields,
  buildBitcoinTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { applyResponseFormat, type ResponseFormat } from '../../helpers/response-modes.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

export function registerQueryBitcoinInputsTool(server: McpServer) {
  server.tool(
    'portal_query_bitcoin_inputs',
    `Query Bitcoin transaction inputs — tracks spending from addresses (UTXO consumption).

WHEN TO USE:
- "Find all spending from this Bitcoin address"
- "Track UTXO consumption for an address"
- "Find coinbase (mining reward) inputs"

Bitcoin uses the UTXO model: inputs reference previous outputs being spent.
Filter by prevout_address to track spending FROM an address.

EXAMPLES:
- Spending from address: { prevout_address: ["bc1q..."], timeframe: "24h" }
- Coinbase inputs: { type: ["coinbase"], timeframe: "1h" }
- All inputs in range: { from_block: 800000, to_block: 800010 }`,
    {
      dataset: z.string().default('bitcoin-mainnet').describe('Dataset name (default: bitcoin-mainnet)'),
      from_block: z.number().optional().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      timeframe: z.string().optional().describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      type: z.array(z.string()).optional().describe('Input type filter: "coinbase" or "tx"'),
      prevout_address: z.array(z.string()).optional().describe('Filter by address of the spent output. Tracks spending FROM this address.'),
      prevout_script_type: z.array(z.string()).optional().describe('Filter by script type (e.g., "witness_v1_taproot", "witness_v0_keyhash")'),
      include_transaction: z.boolean().optional().default(false).describe('Include parent transaction data'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().default('full').describe("Response format: 'summary' (stats only, ~90% smaller), 'compact' (txid+address+value only, ~50% smaller), 'full' (all fields)"),
      limit: z.number().optional().default(50).describe('Max inputs to return (default: 50)'),
    },
    async ({ dataset, from_block, to_block, timeframe, finalized_only, type, prevout_address, prevout_script_type, include_transaction, response_format, limit }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'bitcoin') {
        throw new Error('portal_query_bitcoin_inputs is only for Bitcoin chains.')
      }

      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset, timeframe, from_block, to_block,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset, resolvedFromBlock, resolvedToBlock ?? Number.MAX_SAFE_INTEGER, finalized_only,
      )

      const inputFilter: Record<string, unknown> = {}
      if (type) inputFilter.type = type
      if (prevout_address) inputFilter.prevoutScriptPubKeyAddress = prevout_address
      if (prevout_script_type) inputFilter.prevoutScriptPubKeyType = prevout_script_type
      if (include_transaction) inputFilter.transaction = true

      const fields: Record<string, unknown> = {
        block: { number: true, hash: true, timestamp: true },
        input: buildBitcoinInputFields(),
      }
      if (include_transaction) {
        fields.transaction = buildBitcoinTransactionFields()
      }

      const query = {
        type: 'bitcoin',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields,
        inputs: [inputFilter],
      }

      // Cap blocks to prevent OOM on large unfiltered ranges
      const hasFilters = !!(type || prevout_address || prevout_script_type)
      const blockRange = endBlock - resolvedFromBlock
      const maxBlocks = hasFilters ? 0 : Math.min(blockRange, Math.max(50, limit * 5))
      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query, undefined, maxBlocks, 100 * 1024 * 1024)

      const allInputs = results.flatMap(
        (block: unknown) => (block as { inputs?: unknown[] }).inputs || [],
      )
      const limitedInputs = allInputs.slice(0, limit)
      const formattedData = applyResponseFormat(limitedInputs, response_format as ResponseFormat, 'bitcoin_inputs')

      const message = response_format === 'summary'
        ? `Summary of ${limitedInputs.length} Bitcoin inputs`
        : `Retrieved ${limitedInputs.length} Bitcoin inputs`

      return formatResult(formattedData, message, {
        maxItems: limit,
        warnOnTruncation: false,
        metadata: { dataset, from_block: resolvedFromBlock, to_block: endBlock, query_start_time: queryStartTime },
      })
    },
  )
}
