import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Dataset discovery
import { registerListDatasetsTool } from './datasets/list.js'
import { registerGetDatasetInfoTool } from './datasets/info.js'

// EVM — core queries
import { registerGetBlockNumberTool } from './evm/block-number.js'
import { registerBlockAtTimestampTool } from './evm/block-at-timestamp.js'
import { registerQueryBlocksTool } from './evm/query-blocks.js'
import { registerQueryLogsTool } from './evm/query-logs.js'
import { registerQueryTransactionsTool } from './evm/query-transactions.js'
import { registerGetErc20TransfersTool } from './evm/erc20-transfers.js'

// EVM — convenience & analytics
import {
  registerGetContractActivityTool,
  registerGetRecentTransactionsTool,
  registerGetTimeSeriesDataTool,
  registerGetTopContractsTool,
  registerGetTransactionDensityTool,
  registerGetWalletSummaryTool,
} from './convenience/index.js'
import { registerDecodeLogsTool } from './utilities/decode-logs.js'

// Solana
import { registerQuerySolanaInstructionsTool } from './solana/query-instructions.js'
import { registerQuerySolanaTransactionsTool } from './solana/query-transactions.js'
import { registerSolanaAnalyticsTool } from './solana/analytics.js'
import { registerSolanaTimeSeriesool } from './solana/time-series.js'

// Bitcoin
import {
  registerQueryBitcoinTransactionsTool,
  registerQueryBitcoinInputsTool,
  registerQueryBitcoinOutputsTool,
  registerBitcoinAnalyticsTool,
  registerBitcoinTimeSeresTool,
} from './bitcoin/index.js'

// Hyperliquid
import {
  registerQueryHyperliquidFillsTool,
  registerQueryHyperliquidReplicaCmdsTool,
  registerAggregateHyperliquidFillsTool,
  registerHyperliquidTimeSeriesFilsTool,
  registerHyperliquidAnalyticsTool,
} from './hyperliquid/index.js'

// ============================================================================
// Tool Registry — 29 tools, organized by VM
// ============================================================================

export function registerAllTools(server: McpServer) {
  // ── Dataset discovery (2) ────────────────────────────────────────────
  registerListDatasetsTool(server)
  registerGetDatasetInfoTool(server)

  // ── EVM (13) ─────────────────────────────────────────────────────────
  // Core queries (traces & state diffs available via include_traces/include_state_diffs on query_transactions)
  registerGetBlockNumberTool(server)
  registerBlockAtTimestampTool(server)
  registerQueryBlocksTool(server)
  registerQueryLogsTool(server)
  registerQueryTransactionsTool(server)
  registerGetErc20TransfersTool(server)
  // Convenience & analytics
  registerDecodeLogsTool(server)
  registerGetRecentTransactionsTool(server)
  registerGetWalletSummaryTool(server)
  registerGetContractActivityTool(server)
  registerGetTopContractsTool(server)
  registerGetTransactionDensityTool(server)
  registerGetTimeSeriesDataTool(server)

  // ── Solana (4) ───────────────────────────────────────────────────────
  // Balances, token balances, logs, rewards available via include flags on query_solana_transactions/instructions
  registerQuerySolanaInstructionsTool(server)
  registerQuerySolanaTransactionsTool(server)
  registerSolanaAnalyticsTool(server)
  registerSolanaTimeSeriesool(server)

  // ── Bitcoin (5) ──────────────────────────────────────────────────────
  registerQueryBitcoinTransactionsTool(server)
  registerQueryBitcoinInputsTool(server)
  registerQueryBitcoinOutputsTool(server)
  registerBitcoinAnalyticsTool(server)
  registerBitcoinTimeSeresTool(server)

  // ── Hyperliquid (5) ──────────────────────────────────────────────────
  registerQueryHyperliquidFillsTool(server)
  registerQueryHyperliquidReplicaCmdsTool(server)
  registerAggregateHyperliquidFillsTool(server)
  registerHyperliquidTimeSeriesFilsTool(server)
  registerHyperliquidAnalyticsTool(server)
}
