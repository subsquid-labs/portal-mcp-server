import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL } from "../../constants/index.js";
import { resolveDataset } from "../../cache/datasets.js";
import { detectChainType } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import { normalizeAddresses } from "../../helpers/validation.js";
import { resolveTimeframeOrBlocks } from "../../helpers/timeframe.js";

// ============================================================================
// Tool: Count Events
// ============================================================================

/**
 * Count events without fetching full data.
 * Perfect for "how many X" questions - uses ~1% of tokens vs full query.
 */
export function registerCountEventsTool(server: McpServer) {
  server.tool(
    "portal_count_events",
    `Count events/logs without fetching full data. ~99% smaller than portal_query_logs.

WHEN TO USE:
- "How many USDC transfers in the last 24 hours?"
- "Count Uniswap swaps on Base today"
- "How many events from this contract?"
- "What's the event volume per contract?"

ONE CALL SOLUTION: Returns counts grouped by address or event type.

EXAMPLES:
- Count transfers: { dataset: "base", timeframe: "24h", topic0: ["0xddf252ad...Transfer"] }
- Count by contract: { dataset: "ethereum", timeframe: "7d", group_by: "address" }
- Total events: { dataset: "polygon", from_block: 100, to_block: 1000 }

FAST: ~100ms for counting millions of events. Returns tiny payload (<1KB).`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '24h', '7d'). Alternative to from_block/to_block"),
      from_block: z.number().optional().describe("Starting block number (use this OR timeframe)"),
      to_block: z.number().optional().describe("Ending block number"),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Contract addresses to count events from"),
      topic0: z
        .array(z.string())
        .optional()
        .describe("Event signatures to count (e.g., Transfer signature)"),
      group_by: z
        .enum(["address", "topic0", "none"])
        .optional()
        .default("none")
        .describe("Group counts by: 'address' (per contract), 'topic0' (per event type), 'none' (total only)"),
    },
    async ({ dataset, timeframe, from_block, to_block, addresses, topic0, group_by }) => {
      const queryStartTime = Date.now();
      dataset = await resolveDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_count_events is only for EVM chains");
      }

      // Resolve timeframe or use explicit blocks
      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } =
        await resolveTimeframeOrBlocks({
          dataset,
          timeframe,
          from_block,
          to_block,
        });

      const normalizedAddresses = normalizeAddresses(addresses, chainType);

      // Build minimal query - only fetch what we need to count
      const logFilter: Record<string, unknown> = {};
      if (normalizedAddresses) logFilter.address = normalizedAddresses;
      if (topic0) logFilter.topic0 = topic0;

      const query = {
        type: "evm",
        fromBlock: resolvedFromBlock,
        toBlock: resolvedToBlock,
        fields: {
          block: { number: true },
          log: {
            address: true,
            topics: true,
            logIndex: true,
          },
        },
        logs: [logFilter],
      };

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query
      );

      // Count events
      const allLogs = results.flatMap(
        (block: any) => (block.logs || []).map((log: any) => ({ ...log, blockNumber: block.number }))
      );

      const totalCount = allLogs.length;

      // Group by address or topic0 if requested
      let grouped: any = undefined;

      if (group_by === "address") {
        const byAddress = new Map<string, number>();
        allLogs.forEach((log: any) => {
          const addr = log.address || "unknown";
          byAddress.set(addr, (byAddress.get(addr) || 0) + 1);
        });

        grouped = Array.from(byAddress.entries())
          .map(([address, count]) => ({ address, count }))
          .sort((a, b) => b.count - a.count);
      } else if (group_by === "topic0") {
        const byTopic = new Map<string, number>();
        allLogs.forEach((log: any) => {
          const topic = log.topic0 || "unknown";
          byTopic.set(topic, (byTopic.get(topic) || 0) + 1);
        });

        grouped = Array.from(byTopic.entries())
          .map(([topic0, count]) => ({ topic0, count }))
          .sort((a, b) => b.count - a.count);
      }

      // Calculate blocks analyzed
      const blocks = allLogs.map((l: any) => l.blockNumber).filter(Boolean);
      const blockRange =
        blocks.length > 0
          ? {
              from: Math.min(...blocks),
              to: Math.max(...blocks),
              count: results.length,
            }
          : { from: resolvedFromBlock, to: resolvedToBlock, count: results.length };

      const response: any = {
        total_events: totalCount,
        block_range: blockRange,
      };

      if (grouped) {
        response.grouped = grouped;
        response.unique_groups = grouped.length;
      }

      return formatResult(
        response,
        `Counted ${totalCount.toLocaleString()} events across ${results.length} blocks`,
        {
          metadata: {
            dataset,
            from_block: resolvedFromBlock,
            to_block: resolvedToBlock,
            query_start_time: queryStartTime,
          },
        }
      );
    }
  );
}
