import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL } from "../../constants/index.js";
import {
  resolveDataset,
  getDatasetMetadata,
  validateBlockRange,
} from "../../cache/datasets.js";
import { detectChainType, isL2Chain } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import {
  buildEvmLogFields,
  buildEvmTransactionFields,
  buildEvmStateDiffFields,
} from "../../helpers/fields.js";
import { normalizeAddresses } from "../../helpers/validation.js";

// ============================================================================
// Tool: Batch Query (Multi-Dataset)
// ============================================================================

export function registerBatchQueryTool(server: McpServer) {
  server.tool(
    "portal_batch_query",
    "Execute the same query across multiple datasets in parallel (e.g., track an address across Ethereum, Base, Arbitrum)",
    {
      datasets: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe("List of datasets to query (max 10)"),
      query_type: z
        .enum(["logs", "transactions", "balances"])
        .describe("Type of query to execute"),
      from_block: z
        .number()
        .optional()
        .describe("Starting block (uses last 1000 blocks if not specified)"),
      to_block: z.number().optional().describe("Ending block"),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Addresses to filter (contract for logs, from/to for txs)"),
      topic0: z
        .array(z.string())
        .optional()
        .describe("Event signatures for log queries"),
      limit_per_dataset: z
        .number()
        .optional()
        .default(100)
        .describe("Max results per dataset"),
      finalized_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only query finalized blocks"),
    },
    async ({
      datasets,
      query_type,
      from_block,
      to_block,
      addresses,
      topic0,
      limit_per_dataset,
      finalized_only,
    }) => {
      // Resolve all dataset aliases to canonical names
      const resolvedDatasets = await Promise.all(datasets.map((d) => resolveDataset(d)));

      // Filter to only EVM datasets for these query types
      const evmDatasets = resolvedDatasets.filter((d) => detectChainType(d) === "evm");
      if (evmDatasets.length === 0) {
        throw new Error(
          "No EVM datasets provided. Batch query currently only supports EVM chains.",
        );
      }

      // Execute queries in parallel
      const results = await Promise.all(
        evmDatasets.map(async (dataset) => {
          try {
            const meta = await getDatasetMetadata(dataset);
            const maxBlock =
              finalized_only && meta.finalized_head
                ? meta.finalized_head.number
                : meta.head.number;

            const effectiveFromBlock = from_block ?? Math.max(0, maxBlock - 1000);
            const effectiveToBlock = to_block ?? maxBlock;

            const { validatedToBlock } = await validateBlockRange(
              dataset,
              effectiveFromBlock,
              effectiveToBlock,
              finalized_only,
            );

            const includeL2 = isL2Chain(dataset);
            let query: Record<string, unknown>;

            if (query_type === "logs") {
              const logFilter: Record<string, unknown> = {};
              if (addresses) {
                logFilter.address = normalizeAddresses(addresses, "evm");
              }
              if (topic0) {
                logFilter.topic0 = topic0;
              }
              query = {
                type: "evm",
                fromBlock: effectiveFromBlock,
                toBlock: validatedToBlock,
                fields: {
                  block: { number: true, timestamp: true, hash: true },
                  log: buildEvmLogFields(),
                },
                logs: [logFilter],
              };
            } else if (query_type === "transactions") {
              const txFilter: Record<string, unknown> = {};
              if (addresses) {
                const normalized = normalizeAddresses(addresses, "evm");
                txFilter.from = normalized;
                txFilter.to = normalized;
              }
              query = {
                type: "evm",
                fromBlock: effectiveFromBlock,
                toBlock: validatedToBlock,
                fields: {
                  block: { number: true, timestamp: true, hash: true },
                  transaction: buildEvmTransactionFields(includeL2),
                },
                transactions: [txFilter],
              };
            } else {
              // balances - use state diffs
              const diffFilter: Record<string, unknown> = {
                key: ["balance"],
              };
              if (addresses) {
                diffFilter.address = normalizeAddresses(addresses, "evm");
              }
              query = {
                type: "evm",
                fromBlock: effectiveFromBlock,
                toBlock: validatedToBlock,
                fields: {
                  block: { number: true, timestamp: true, hash: true },
                  stateDiff: buildEvmStateDiffFields(),
                },
                stateDiffs: [diffFilter],
              };
            }

            const response = await portalFetchStream(
              `${PORTAL_URL}/datasets/${dataset}/stream`,
              query,
            );

            let items: unknown[] = [];
            if (query_type === "logs") {
              items = response.flatMap(
                (block: unknown) => (block as { logs?: unknown[] }).logs || [],
              );
            } else if (query_type === "transactions") {
              items = response.flatMap(
                (block: unknown) =>
                  (block as { transactions?: unknown[] }).transactions || [],
              );
            } else {
              items = response.flatMap(
                (block: unknown) =>
                  (block as { stateDiffs?: unknown[] }).stateDiffs || [],
              );
            }

            return {
              dataset,
              chain_type: "evm",
              is_l2: includeL2,
              from_block: effectiveFromBlock,
              to_block: validatedToBlock,
              count: items.length,
              items: items.slice(0, limit_per_dataset),
              error: null,
            };
          } catch (error) {
            return {
              dataset,
              chain_type: "evm",
              is_l2: isL2Chain(dataset),
              from_block: from_block ?? 0,
              to_block: to_block ?? 0,
              count: 0,
              items: [],
              error: (error as Error).message,
            };
          }
        }),
      );

      const totalItems = results.reduce((sum, r) => sum + r.count, 0);
      const successCount = results.filter((r) => !r.error).length;

      return formatResult(
        {
          results,
          summary: {
            total_items: totalItems,
            datasets_queried: results.length,
            successful: successCount,
          },
        },
        `Batch query completed: ${totalItems} items across ${successCount}/${results.length} datasets`,
      );
    },
  );
}
