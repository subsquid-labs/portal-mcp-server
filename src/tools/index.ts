import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Discovery
import { registerListDatasetsTool } from './datasets/list.js'
import { registerGetDatasetInfoTool } from './datasets/info.js'

// Global / debug
import { registerGetBlockNumberTool } from './evm/block-number.js'
import { registerBlockAtTimestampTool } from './evm/block-at-timestamp.js'
import { registerQueryBlocksTool } from './evm/query-blocks.js'

// EVM
import { registerQueryLogsTool } from './evm/query-logs.js'
import { registerQueryTransactionsTool } from './evm/query-transactions.js'
import { registerGetErc20TransfersTool } from './evm/erc20-transfers.js'
import { registerEvmOhlcTool } from './evm/ohlc.js'

import {
  registerGetContractActivityTool,
  registerGetRecentTransactionsTool,
  registerGetTimeSeriesDataTool,
  registerGetTopContractsTool,
  registerGetWalletSummaryTool,
} from './convenience/index.js'

// Solana
import { registerQuerySolanaInstructionsTool } from './solana/query-instructions.js'
import { registerQuerySolanaTransactionsTool } from './solana/query-transactions.js'
import { registerSolanaAnalyticsTool } from './solana/analytics.js'

// Bitcoin
import {
  registerQueryBitcoinTransactionsTool,
  registerBitcoinAnalyticsTool,
} from './bitcoin/index.js'

// Hyperliquid
import {
  registerQueryHyperliquidFillsTool,
  registerQueryHyperliquidReplicaCmdsTool,
  registerHyperliquidAnalyticsTool,
  registerHyperliquidOhlcTool,
} from './hyperliquid/index.js'

export function registerAllTools(server: McpServer) {
  // Public discovery (3)
  registerListDatasetsTool(server)
  registerGetDatasetInfoTool(server)
  registerGetBlockNumberTool(server)

  // Public convenience (3)
  registerGetRecentTransactionsTool(server)
  registerGetWalletSummaryTool(server)
  registerGetTimeSeriesDataTool(server)

  // Public EVM (6)
  registerQueryLogsTool(server)
  registerQueryTransactionsTool(server)
  registerGetErc20TransfersTool(server)
  registerGetContractActivityTool(server)
  registerGetTopContractsTool(server)
  registerEvmOhlcTool(server)

  // Public Solana (3)
  registerQuerySolanaInstructionsTool(server)
  registerQuerySolanaTransactionsTool(server)
  registerSolanaAnalyticsTool(server)

  // Public Bitcoin (2)
  registerQueryBitcoinTransactionsTool(server)
  registerBitcoinAnalyticsTool(server)

  // Public Hyperliquid (3)
  registerQueryHyperliquidFillsTool(server)
  registerHyperliquidAnalyticsTool(server)
  registerHyperliquidOhlcTool(server)

  // Advanced/debug (3)
  registerQueryBlocksTool(server)
  registerBlockAtTimestampTool(server)
  registerQueryHyperliquidReplicaCmdsTool(server)
}
