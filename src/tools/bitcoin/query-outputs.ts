import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import {
  buildBitcoinOutputFields,
  buildBitcoinTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

export function registerQueryBitcoinOutputsTool(server: McpServer) {
  server.tool(
    'portal_query_bitcoin_outputs',
    `Query Bitcoin transaction outputs — tracks receiving to addresses (UTXO creation).

WHEN TO USE:
- "Find all payments to this Bitcoin address"
- "Track incoming funds to a wallet"
- "Find outputs by script type (taproot, segwit, etc.)"

Bitcoin uses the UTXO model: outputs represent newly created UTXOs.
Filter by address to track payments TO an address.

EXAMPLES:
- Payments to address: { address: ["bc1q..."], timeframe: "24h" }
- Taproot outputs: { script_type: ["witness_v1_taproot"], timeframe: "1h" }
- All outputs in range: { from_block: 800000, to_block: 800010 }`,
    {
      dataset: z.string().default('bitcoin-mainnet').describe('Dataset name (default: bitcoin-mainnet)'),
      from_block: z.number().optional().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      timeframe: z.string().optional().describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      address: z.array(z.string()).optional().describe('Filter by recipient address. Tracks payments TO this address.'),
      script_type: z.array(z.string()).optional().describe('Filter by output script type (e.g., "witness_v1_taproot", "witness_v0_keyhash")'),
      include_transaction: z.boolean().optional().default(false).describe('Include parent transaction data'),
      limit: z.number().optional().default(50).describe('Max outputs to return (default: 50)'),
    },
    async ({ dataset, from_block, to_block, timeframe, finalized_only, address, script_type, include_transaction, limit }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'bitcoin') {
        throw new Error('portal_query_bitcoin_outputs is only for Bitcoin chains.')
      }

      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset, timeframe, from_block, to_block,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset, resolvedFromBlock, resolvedToBlock ?? Number.MAX_SAFE_INTEGER, finalized_only,
      )

      const outputFilter: Record<string, unknown> = {}
      if (address) outputFilter.scriptPubKeyAddress = address
      if (script_type) outputFilter.scriptPubKeyType = script_type
      if (include_transaction) outputFilter.transaction = true

      const fields: Record<string, unknown> = {
        block: { number: true, hash: true, timestamp: true },
        output: buildBitcoinOutputFields(),
      }
      if (include_transaction) {
        fields.transaction = buildBitcoinTransactionFields()
      }

      const query = {
        type: 'bitcoin',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields,
        outputs: [outputFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allOutputs = results.flatMap(
        (block: unknown) => (block as { outputs?: unknown[] }).outputs || [],
      )
      const limitedOutputs = allOutputs.slice(0, limit)

      return formatResult(limitedOutputs, `Retrieved ${limitedOutputs.length} Bitcoin outputs`, {
        maxItems: limit,
        warnOnTruncation: false,
        metadata: { dataset, from_block: resolvedFromBlock, to_block: endBlock, query_start_time: queryStartTime },
      })
    },
  )
}
