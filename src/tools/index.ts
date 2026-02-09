import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Dataset tools
import { registerListDatasetsTool } from "./datasets/list.js";
import { registerSearchDatasetsTool } from "./datasets/search.js";
import { registerGetDatasetInfoTool } from "./datasets/info.js";

// EVM tools
import { registerGetBlockNumberTool } from "./evm/block-number.js";
import { registerBlockAtTimestampTool } from "./evm/block-at-timestamp.js";
import { registerQueryBlocksTool } from "./evm/query-blocks.js";
import { registerQueryLogsTool } from "./evm/query-logs.js";
import { registerQueryTransactionsTool } from "./evm/query-transactions.js";
import { registerQueryTracesTool } from "./evm/query-traces.js";
import { registerQueryStateDiffsTool } from "./evm/query-state-diffs.js";
import { registerGetErc20TransfersTool } from "./evm/erc20-transfers.js";
import { registerGetNftTransfersTool } from "./evm/nft-transfers.js";

// Solana tools
import { registerQuerySolanaInstructionsTool } from "./solana/query-instructions.js";
import { registerQuerySolanaBalancesTool } from "./solana/query-balances.js";
import { registerQuerySolanaTokenBalancesTool } from "./solana/query-token-balances.js";
import { registerQuerySolanaLogsTool } from "./solana/query-logs.js";
import { registerQuerySolanaRewardsTool } from "./solana/query-rewards.js";

// Utility tools
import { registerStreamTool } from "./utilities/stream.js";
import { registerQueryPaginatedTool } from "./utilities/query-paginated.js";
import { registerBatchQueryTool } from "./utilities/batch-query.js";
import { registerDecodeLogsTool } from "./utilities/decode-logs.js";
import { registerResolveAddressesTool } from "./utilities/resolve-addresses.js";

// Convenience tools
import {
  registerGetRecentTransactionsTool,
  registerGetWalletSummaryTool,
  registerGetContractActivityTool,
  registerGetTransactionDensityTool,
  registerGetGasAnalyticsTool,
  registerCompareChainsTool,
  registerGetTopContractsTool,
  registerGetTopAddressesTool,
  registerGetTimeSeriesDataTool,
  registerGetContractDeploymentsTool,
} from "./convenience/index.js";

// Meta tools
import { registerSuggestToolTool } from "./meta/index.js";

// Enrichment tools (external data sources)
import {
  registerGetTokenInfoTool,
  registerGetSqdNetworkInfoTool,
  registerGetPortalCapabilitiesTool,
} from "./enrichment/index.js";

// Aggregation tools (high-level analytics)
import {
  registerCountEventsTool,
  registerAggregateTransfersTool,
} from "./aggregation/index.js";

// ============================================================================
// Tool Registry
// ============================================================================

export function registerAllTools(server: McpServer) {
  // Dataset tools (3)
  registerListDatasetsTool(server);
  registerSearchDatasetsTool(server);
  registerGetDatasetInfoTool(server);

  // EVM tools (9)
  registerGetBlockNumberTool(server);
  registerBlockAtTimestampTool(server);
  registerQueryBlocksTool(server);
  registerQueryLogsTool(server);
  registerQueryTransactionsTool(server);
  registerQueryTracesTool(server);
  registerQueryStateDiffsTool(server);
  registerGetErc20TransfersTool(server);
  registerGetNftTransfersTool(server);

  // Solana tools (5)
  registerQuerySolanaInstructionsTool(server);
  registerQuerySolanaBalancesTool(server);
  registerQuerySolanaTokenBalancesTool(server);
  registerQuerySolanaLogsTool(server);
  registerQuerySolanaRewardsTool(server);

  // Utility tools (5)
  registerStreamTool(server);
  registerQueryPaginatedTool(server);
  registerBatchQueryTool(server);
  registerDecodeLogsTool(server);
  registerResolveAddressesTool(server);

  // Convenience tools (10) - High-level wrappers for common tasks
  registerGetRecentTransactionsTool(server);
  registerGetWalletSummaryTool(server);
  registerGetContractActivityTool(server);
  registerGetTransactionDensityTool(server);
  registerGetGasAnalyticsTool(server);
  registerCompareChainsTool(server);
  registerGetTopContractsTool(server);
  registerGetTopAddressesTool(server);
  registerGetTimeSeriesDataTool(server);
  registerGetContractDeploymentsTool(server);

  // Meta tools (1) - Tool discovery and guidance
  registerSuggestToolTool(server);

  // Enrichment tools (3) - External data sources for rich metadata
  registerGetTokenInfoTool(server);
  registerGetSqdNetworkInfoTool(server);
  registerGetPortalCapabilitiesTool(server);

  // Aggregation tools (2) - Pre-aggregated endpoints for tiny payloads
  registerCountEventsTool(server);
  registerAggregateTransfersTool(server);
}
