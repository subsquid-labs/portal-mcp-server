import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Query Hyperliquid Fills
// ============================================================================

export function registerQueryHyperliquidFillsTool(server: McpServer) {
  server.tool(
    'portal_query_hyperliquid_fills',
    'Query Hyperliquid trade fills — executions, PnL, fees, routing. Filter by trader, coin, direction, or builder.',
    {
      dataset: z
        .string()
        .optional()
        .default('hyperliquid-fills')
        .describe("Dataset name (default: 'hyperliquid-fills')"),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block number'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      user: z.array(z.string()).optional().describe('Trader wallet addresses (0x-prefixed, lowercase)'),
      coin: z.array(z.string()).optional().describe('Asset symbols (e.g., "ETH", "BTC", "SOL")'),
      dir: z.array(z.string()).optional().describe('Trade direction: "Open Long", "Close Long", "Open Short", "Close Short"'),
      builder: z.array(z.string()).optional().describe('Builder addresses (0x-prefixed, lowercase)'),
      fee_token: z.array(z.string()).optional().describe('Fee token symbols'),
      cloid: z.array(z.string()).optional().describe('Client order IDs (0x-prefixed hex)'),
      limit: z.number().optional().default(50).describe('Max fills to return'),
      include_pnl: z.boolean().optional().default(true).describe('Include closedPnl and startPosition fields'),
      include_builder_info: z.boolean().optional().default(false).describe('Include builder and builderFee fields'),
    },
    async ({
      dataset,
      timeframe,
      from_block,
      to_block,
      finalized_only,
      user,
      coin,
      dir,
      builder,
      fee_token,
      cloid,
      limit,
      include_pnl,
      include_builder_info,
    }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)

      // Resolve timeframe or use explicit blocks
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

      // Build fill filter
      const fillFilter: Record<string, unknown> = {}
      if (user) fillFilter.user = user.map((u) => u.toLowerCase())
      if (coin) fillFilter.coin = coin
      if (dir) fillFilter.dir = dir
      if (builder) fillFilter.builder = builder.map((b) => b.toLowerCase())
      if (fee_token) fillFilter.feeToken = fee_token
      if (cloid) fillFilter.cloid = cloid

      // Build field selection
      const fillFields: Record<string, boolean> = {
        fillIndex: true,
        user: true,
        coin: true,
        px: true,
        sz: true,
        side: true,
        dir: true,
        fee: true,
        oid: true,
        time: true,
        tid: true,
        crossed: true,
        hash: true,
        cloid: true,
        feeToken: true,
      }

      if (include_pnl) {
        fillFields.closedPnl = true
        fillFields.startPosition = true
      }

      if (include_builder_info) {
        fillFields.builderFee = true
        fillFields.builder = true
        fillFields.twapId = true
      }

      const query = {
        type: 'hyperliquidFills',
        fromBlock: resolvedFromBlock,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          fill: fillFields,
        },
        fills: [fillFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const allFills = results
        .flatMap((block: unknown) => {
          const b = block as {
            header?: { number: number; timestamp: number }
            fills?: Array<Record<string, unknown>>
          }
          return (b.fills || []).map((fill) => ({
            block_number: b.header?.number,
            block_timestamp: b.header?.timestamp,
            ...fill,
          }))
        })
        .slice(0, limit)

      return formatResult(
        allFills,
        `Retrieved ${allFills.length} Hyperliquid fills`,
        {
          maxItems: limit,
          warnOnTruncation: false,
          metadata: {
            dataset,
            from_block: resolvedFromBlock,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
