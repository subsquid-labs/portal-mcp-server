import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Aggregation tools
import { registerAggregateTransfersTool, registerCountEventsTool } from './aggregation/index.js'
// Bitcoin tools
import {
  registerQueryBitcoinTransactionsTool,
  registerQueryBitcoinInputsTool,
  registerQueryBitcoinOutputsTool,
} from './bitcoin/index.js'
// Convenience tools
import {
  registerGetContractActivityTool,
  registerGetGasAnalyticsTool,
  registerGetRecentTransactionsTool,
  registerGetTimeSeriesDataTool,
  registerGetTopContractsTool,
  registerGetTransactionDensityTool,
  registerGetWalletSummaryTool,
} from './convenience/index.js'
import { registerGetDatasetInfoTool } from './datasets/info.js'
// Dataset tools
import { registerListDatasetsTool } from './datasets/list.js'
// Enrichment tools
import { registerGetTokenInfoTool } from './enrichment/index.js'
// Hyperliquid tools
import { registerQueryHyperliquidFillsTool, registerQueryHyperliquidReplicaCmdsTool } from './hyperliquid/index.js'
import { registerBlockAtTimestampTool } from './evm/block-at-timestamp.js'
// EVM tools
import { registerGetBlockNumberTool } from './evm/block-number.js'
import { registerGetErc20TransfersTool } from './evm/erc20-transfers.js'
import { registerGetNftTransfersTool } from './evm/nft-transfers.js'
import { registerQueryBlocksTool } from './evm/query-blocks.js'
import { registerQueryLogsTool } from './evm/query-logs.js'
import { registerQueryStateDiffsTool } from './evm/query-state-diffs.js'
import { registerQueryTracesTool } from './evm/query-traces.js'
import { registerQueryTransactionsTool } from './evm/query-transactions.js'
import { registerQuerySolanaBalancesTool } from './solana/query-balances.js'
// Solana tools
import { registerQuerySolanaInstructionsTool } from './solana/query-instructions.js'
import { registerQuerySolanaLogsTool } from './solana/query-logs.js'
import { registerQuerySolanaRewardsTool } from './solana/query-rewards.js'
import { registerQuerySolanaTokenBalancesTool } from './solana/query-token-balances.js'
import { registerQuerySolanaTransactionsTool } from './solana/query-transactions.js'
import { registerDecodeLogsTool } from './utilities/decode-logs.js'
// Utility tools
import { registerStreamTool } from './utilities/stream.js'

// ============================================================================
// Tool Registry
// ============================================================================

export function registerAllTools(server: McpServer) {
  // Dataset tools (2)
  registerListDatasetsTool(server)
  registerGetDatasetInfoTool(server)

  // EVM tools (9)
  registerGetBlockNumberTool(server)
  registerBlockAtTimestampTool(server)
  registerQueryBlocksTool(server)
  registerQueryLogsTool(server)
  registerQueryTransactionsTool(server)
  registerQueryTracesTool(server)
  registerQueryStateDiffsTool(server)
  registerGetErc20TransfersTool(server)
  registerGetNftTransfersTool(server)

  // Solana tools (6)
  registerQuerySolanaInstructionsTool(server)
  registerQuerySolanaTransactionsTool(server)
  registerQuerySolanaBalancesTool(server)
  registerQuerySolanaTokenBalancesTool(server)
  registerQuerySolanaLogsTool(server)
  registerQuerySolanaRewardsTool(server)

  // Bitcoin tools (3)
  registerQueryBitcoinTransactionsTool(server)
  registerQueryBitcoinInputsTool(server)
  registerQueryBitcoinOutputsTool(server)

  // Hyperliquid tools (2)
  registerQueryHyperliquidFillsTool(server)
  registerQueryHyperliquidReplicaCmdsTool(server)

  // Utility tools (2)
  registerStreamTool(server)
  registerDecodeLogsTool(server)

  // Convenience tools (7)
  registerGetRecentTransactionsTool(server)
  registerGetWalletSummaryTool(server)
  registerGetContractActivityTool(server)
  registerGetTransactionDensityTool(server)
  registerGetGasAnalyticsTool(server)
  registerGetTopContractsTool(server)
  registerGetTimeSeriesDataTool(server)

  // Enrichment tools (1)
  registerGetTokenInfoTool(server)

  // Aggregation tools (2)
  registerCountEventsTool(server)
  registerAggregateTransfersTool(server)
}
