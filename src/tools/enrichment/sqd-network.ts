import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatResult } from "../../helpers/format.js";
import { getDatasets } from "../../cache/datasets.js";

// ============================================================================
// Tool: Get SQD Network Info
// ============================================================================

/**
 * Get information about SQD Network and available datasets
 */
export function registerGetSqdNetworkInfoTool(server: McpServer) {
  server.tool(
    "portal_get_sqd_info",
    `Get information about SQD Network, Portal API, and available blockchain datasets.

WHEN TO USE:
- "Tell me about SQD" → Get SQD Network overview
- "What is SQD Portal?" → Explain Portal API
- "Show me all available metrics for SQD" → List datasets and capabilities
- "What chains does SQD support?" → List available blockchains

RETURNS: SQD Network info, Portal API capabilities, dataset count, supported chains

NOTE: SQD Network is the infrastructure provider. The Portal API provides access to 225+ blockchain datasets.`,
    {
      include_datasets: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include list of available datasets (default: true)"),
      include_chains: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include chain statistics (default: true)"),
    },
    async ({ include_datasets, include_chains }) => {
      const queryStartTime = Date.now();

      const datasets = await getDatasets();

      // Extract unique chains
      const chains = new Map<string, number>();
      datasets.forEach((d) => {
        const chain = d.dataset.split("-")[0]; // e.g., "ethereum-mainnet" -> "ethereum"
        chains.set(chain, (chains.get(chain) || 0) + 1);
      });

      const info = {
        sqd_network: {
          name: "SQD Network",
          description: "Decentralized data lake for blockchain data indexing and querying",
          website: "https://sqd.dev",
          portal_api: "https://portal.sqd.dev",
          documentation: "https://docs.sqd.dev",
          github: "https://github.com/subsquid",
        },
        portal_api: {
          description: "High-performance API for querying blockchain data across 225+ datasets",
          base_url: "https://portal.sqd.dev",
          features: [
            "Real-time blockchain data access",
            "Historical data queries (logs, transactions, traces, state diffs)",
            "Multi-chain support (EVM and Solana)",
            "High-performance streaming API",
            "Block-level granularity",
            "Filtering by addresses, topics, sighashes",
            "No API key required",
          ],
          supported_query_types: {
            evm: ["logs", "transactions", "traces", "state_diffs", "blocks"],
            solana: ["instructions", "balances", "token_balances", "logs", "rewards"],
          },
        },
        statistics: {
          total_datasets: datasets.length,
          unique_chains: chains.size,
          evm_chains: datasets.filter((d) => d.dataset.includes("mainnet") || d.dataset.includes("testnet")).length,
          data_freshness: "Real-time (blocks indexed within seconds)",
        },
      };

      if (include_chains) {
        const chainStats = Array.from(chains.entries())
          .map(([chain, count]) => ({ chain, datasets: count }))
          .sort((a, b) => b.datasets - a.datasets);

        (info as any).chain_breakdown = {
          total_unique_chains: chains.size,
          top_chains: chainStats.slice(0, 20),
          note: "Includes mainnet, testnet, and layer-2 networks",
        };
      }

      if (include_datasets) {
        (info as any).sample_datasets = datasets
          .filter((d) => d.dataset.includes("mainnet"))
          .slice(0, 20)
          .map((d) => ({
            dataset: d.dataset,
            aliases: d.aliases,
          }));

        (info as any).note = "Use portal_list_datasets to see all 225+ datasets, or portal_search_datasets to find specific chains";
      }

      return formatResult(
        info,
        `SQD Network Portal API: ${datasets.length} datasets across ${chains.size} unique blockchains`,
        {
          metadata: {
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}

// ============================================================================
// Tool: Get Portal API Capabilities
// ============================================================================

export function registerGetPortalCapabilitiesTool(server: McpServer) {
  server.tool(
    "portal_get_capabilities",
    `Get detailed Portal API capabilities and query types.

WHEN TO USE:
- "What can I query with Portal API?" → List capabilities
- "What data types are available?" → Show query types
- "How do I use Portal API?" → Get usage guide

RETURNS: Available query types, filters, performance tips, examples`,
    {},
    async () => {
      const queryStartTime = Date.now();

      const capabilities = {
        overview: {
          description: "Portal API provides high-performance access to blockchain data",
          performance: "Optimized for large-scale data queries with streaming support",
          pricing: "Free to use, no API key required",
        },
        evm_queries: {
          logs: {
            description: "Query contract events (ERC20 transfers, Uniswap swaps, etc.)",
            filters: ["addresses", "topic0", "topic1", "topic2", "topic3"],
            use_cases: ["Token transfers", "DEX trades", "NFT mints", "Protocol events"],
            recommended_range: "< 10,000 blocks for best performance",
          },
          transactions: {
            description: "Query transaction data (from, to, value, gas, etc.)",
            filters: ["from_addresses", "to_addresses", "sighash"],
            use_cases: ["Wallet activity", "Contract interactions", "ETH transfers"],
            recommended_range: "< 5,000 blocks for best performance",
          },
          traces: {
            description: "Query internal transactions and contract calls",
            filters: ["type (call/create/suicide/reward)", "addresses", "sighash"],
            use_cases: ["Contract deployments", "Internal calls", "Complex transactions"],
            recommended_range: "< 1,000 blocks (traces are expensive)",
          },
          state_diffs: {
            description: "Query storage changes",
            filters: ["addresses", "keys", "kind"],
            use_cases: ["Storage monitoring", "State analysis"],
            recommended_range: "< 5,000 blocks",
          },
          blocks: {
            description: "Query block metadata",
            filters: ["Block number ranges"],
            use_cases: ["Block headers", "Gas prices", "Timestamps"],
            recommended_range: "Unlimited (metadata only)",
          },
        },
        solana_queries: {
          instructions: {
            description: "Query Solana program instructions",
            filters: ["program_id", "accounts"],
            use_cases: ["Program interactions", "Token operations"],
          },
          balances: {
            description: "Query account balances",
            use_cases: ["SOL balances", "Account tracking"],
          },
          token_balances: {
            description: "Query SPL token balances",
            use_cases: ["Token holdings", "Portfolio tracking"],
          },
        },
        enrichment_data: {
          token_metadata: {
            source: "CoinGecko",
            provides: ["Token names", "Symbols", "Decimals", "Logos"],
            chains: ["ethereum", "base", "arbitrum", "optimism", "polygon", "avalanche", "bsc"],
          },
        },
        performance_tips: [
          "Use filters (addresses, topics) to reduce result size",
          "Keep block ranges reasonable (< 10k for logs, < 5k for transactions)",
          "Use finalized blocks for production queries to avoid reorgs",
          "Leverage caching - subsequent queries are faster",
          "For large datasets, use pagination or split into multiple queries",
        ],
        rate_limits: {
          status: "No strict rate limits",
          recommendation: "Be respectful - don't spam the API",
          note: "API may return 429 if abused, with Retry-After header",
        },
      };

      return formatResult(
        capabilities,
        "Portal API supports EVM (logs, transactions, traces, state diffs) and Solana (instructions, balances) queries across 225+ datasets",
        {
          metadata: {
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}
