import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Aggregation tools (high-level analytics)
import { registerAggregateTransfersTool, registerCountEventsTool } from './aggregation/index.js'
// Convenience tools
import {
  registerCompareChainsTool,
  registerGetContractActivityTool,
  registerGetContractDeploymentsTool,
  registerGetGasAnalyticsTool,
  registerGetRecentTransactionsTool,
  registerGetTimeSeriesDataTool,
  registerGetTopAddressesTool,
  registerGetTopContractsTool,
  registerGetTransactionDensityTool,
  registerGetWalletSummaryTool,
} from './convenience/index.js'
import { registerGetDatasetInfoTool } from './datasets/info.js'
// Dataset tools
import { registerListDatasetsTool } from './datasets/list.js'
import { registerSearchDatasetsTool } from './datasets/search.js'
// Enrichment tools (external data sources)
import {
  registerGetPortalCapabilitiesTool,
  registerGetSqdNetworkInfoTool,
  registerGetTokenInfoTool,
} from './enrichment/index.js'
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
// Meta tools
import { registerSuggestToolTool } from './meta/index.js'
import { registerQuerySolanaBalancesTool } from './solana/query-balances.js'
// Solana tools
import { registerQuerySolanaInstructionsTool } from './solana/query-instructions.js'
import { registerQuerySolanaLogsTool } from './solana/query-logs.js'
import { registerQuerySolanaRewardsTool } from './solana/query-rewards.js'
import { registerQuerySolanaTokenBalancesTool } from './solana/query-token-balances.js'
import { registerBatchQueryTool } from './utilities/batch-query.js'
import { registerDecodeLogsTool } from './utilities/decode-logs.js'
import { registerQueryPaginatedTool } from './utilities/query-paginated.js'
import { registerResolveAddressesTool } from './utilities/resolve-addresses.js'
// Utility tools
import { registerStreamTool } from './utilities/stream.js'

// ============================================================================
// Tool Registry
// ============================================================================

export function registerAllTools(server: McpServer) {
  // Dataset tools (3)
  registerListDatasetsTool(server)
  registerSearchDatasetsTool(server)
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

  // Solana tools (5)
  registerQuerySolanaInstructionsTool(server)
  registerQuerySolanaBalancesTool(server)
  registerQuerySolanaTokenBalancesTool(server)
  registerQuerySolanaLogsTool(server)
  registerQuerySolanaRewardsTool(server)

  // Utility tools (5)
  registerStreamTool(server)
  registerQueryPaginatedTool(server)
  registerBatchQueryTool(server)
  registerDecodeLogsTool(server)
  registerResolveAddressesTool(server)

  // Convenience tools (10) - High-level wrappers for common tasks
  registerGetRecentTransactionsTool(server)
  registerGetWalletSummaryTool(server)
  registerGetContractActivityTool(server)
  registerGetTransactionDensityTool(server)
  registerGetGasAnalyticsTool(server)
  registerCompareChainsTool(server)
  registerGetTopContractsTool(server)
  registerGetTopAddressesTool(server)
  registerGetTimeSeriesDataTool(server)
  registerGetContractDeploymentsTool(server)

  // Meta tools (1) - Tool discovery and guidance
  registerSuggestToolTool(server)

  // Enrichment tools (3) - External data sources for rich metadata
  registerGetTokenInfoTool(server)
  registerGetSqdNetworkInfoTool(server)
  registerGetPortalCapabilitiesTool(server)

  // Aggregation tools (2) - Pre-aggregated endpoints for tiny payloads
  registerCountEventsTool(server)
  registerAggregateTransfersTool(server)
}
