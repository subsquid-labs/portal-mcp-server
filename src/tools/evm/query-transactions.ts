import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL } from "../../constants/index.js";
import { resolveDataset, validateBlockRange } from "../../cache/datasets.js";
import { detectChainType, isL2Chain } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import {
  buildEvmTransactionFields,
  buildEvmLogFields,
  buildEvmTraceFields,
  buildEvmStateDiffFields,
} from "../../helpers/fields.js";
import {
  normalizeAddresses,
  validateQuerySize,
  formatBlockRangeWarning,
  getQueryExamples,
} from "../../helpers/validation.js";
import { getTransactionFields } from "../../helpers/field-presets.js";
import { applyResponseFormat, type ResponseFormat } from "../../helpers/response-modes.js";

// ============================================================================
// Tool: Query Transactions (EVM)
// ============================================================================

export function registerQueryTransactionsTool(server: McpServer) {
  server.tool(
    "portal_query_transactions",
    `Query transactions from EVM chains. Use this for tracking wallet activity, contract interactions, or function calls.

WHEN TO USE:
- "Show all transactions from this wallet"
- "Find all calls to this contract"
- "Track transactions by function signature (sighash)"
- "Get transaction history between two addresses"

PERFORMANCE: <500ms for 5k blocks when filtered. Always filter by address or sighash.

EXAMPLES:
- Wallet activity: { from_addresses: ["0xWallet..."], from_block: X, to_block: Y }
- Contract calls: { to_addresses: ["0xContract..."] }
- Specific function: { to_addresses: ["0xContract..."], sighash: ["0x12345678"] }

SEE ALSO: portal_get_recent_transactions (simpler, auto-calculates blocks)`,
    {
      dataset: z.string().describe("Dataset name or alias"),
      from_block: z.number().describe("Starting block number"),
      to_block: z
        .number()
        .optional()
        .describe(
          "Ending block number. RECOMMENDED: <5k blocks for fast (<500ms) responses. Larger ranges may be slow.",
        ),
      finalized_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only query finalized blocks"),
      from_addresses: z.array(z.string()).optional().describe("Sender addresses (wallets or contracts that initiated the transaction)"),
      to_addresses: z
        .array(z.string())
        .optional()
        .describe("Recipient addresses (typically contracts being called, or wallets receiving ETH)"),
      sighash: z
        .array(z.string())
        .optional()
        .describe("Function sighash filter (4-byte hex)"),
      first_nonce: z.number().optional().describe("Minimum nonce"),
      last_nonce: z.number().optional().describe("Maximum nonce"),
      limit: z.number().max(1000).optional().default(20).describe("Max transactions (default: 20, max: 1000). Note: Lower default for MCP to reduce context usage."),
      field_preset: z
        .enum(["minimal", "standard", "full"])
        .optional()
        .default("standard")
        .describe(
          "Field preset: 'minimal' (from/to/value+block, ~70% smaller), 'standard' (hash+gas+timestamp), 'full' (includes input data hex, largest). Use 'minimal' to reduce context usage."
        ),
      response_format: z
        .enum(["full", "compact", "summary"])
        .optional()
        .default("full")
        .describe(
          "Response format: 'summary' (~90% smaller, aggregated stats), 'compact' (~60% smaller, strips input/nonce), 'full' (complete data). Use 'summary' for counting/profiling."
        ),
      include_logs: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include logs emitted by transactions"),
      include_traces: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include traces for transactions"),
      include_state_diffs: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include state diffs caused by transactions"),
      include_l2_fields: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include L2-specific fields"),
      include_receipt: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include receipt fields (logsBloom)"),
    },
    async ({
      dataset,
      from_block,
      to_block,
      finalized_only,
      from_addresses,
      to_addresses,
      sighash,
      first_nonce,
      last_nonce,
      limit,
      field_preset,
      response_format,
      include_logs,
      include_traces,
      include_state_diffs,
      include_l2_fields,
      include_receipt,
    }) => {
      const queryStartTime = Date.now();
      dataset = await resolveDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_query_transactions is only for EVM chains");
      }

      const normalizedFrom = normalizeAddresses(from_addresses, chainType);
      const normalizedTo = normalizeAddresses(to_addresses, chainType);
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      );
      const includeL2 = include_l2_fields || isL2Chain(dataset);

      // Validate query size to prevent crashes
      const blockRange = endBlock - from_block;
      const hasFilters = !!(normalizedFrom || normalizedTo || sighash);

      const validation = validateQuerySize({
        blockRange,
        hasFilters,
        queryType: "transactions",
        limit: limit ?? 100,
      });

      if (!validation.valid) {
        // Add examples to help user fix the query
        const examples = !hasFilters ? getQueryExamples("transactions") : "";
        throw new Error(validation.error + examples);
      }

      // Warn about potentially slow queries
      let warningMessage = "";
      if (validation.warning) {
        warningMessage = formatBlockRangeWarning(
          from_block,
          endBlock,
          "transactions",
          hasFilters,
        );
        console.error(warningMessage);
      }

      const txFilter: Record<string, unknown> = {};
      if (normalizedFrom) txFilter.from = normalizedFrom;
      if (normalizedTo) txFilter.to = normalizedTo;
      if (sighash) txFilter.sighash = sighash;
      if (first_nonce !== undefined) txFilter.firstNonce = first_nonce;
      if (last_nonce !== undefined) txFilter.lastNonce = last_nonce;
      if (include_logs) txFilter.logs = true;
      if (include_traces) txFilter.traces = true;
      if (include_state_diffs) txFilter.stateDiffs = true;

      // Use field preset to control response size
      const presetFields = getTransactionFields(field_preset || "standard");
      const fields: Record<string, unknown> = { ...presetFields };

      // Merge L2/receipt fields if requested (but keep preset as base)
      if (include_l2_fields || include_receipt) {
        const additionalFields = buildEvmTransactionFields(includeL2, include_receipt);
        fields.transaction = {
          ...(fields.transaction as Record<string, boolean>),
          ...additionalFields
        };
      }

      if (include_logs) {
        fields.log = buildEvmLogFields();
      }
      if (include_traces) {
        fields.trace = buildEvmTraceFields();
      }
      if (include_state_diffs) {
        fields.stateDiff = buildEvmStateDiffFields();
      }

      const query = {
        type: "evm",
        fromBlock: from_block,
        toBlock: endBlock,
        fields,
        transactions: [txFilter],
      };

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
      );

      const allTxs = results.flatMap(
        (block: unknown) =>
          (block as { transactions?: unknown[] }).transactions || [],
      );

      // Apply limit after collecting all results
      const limitedTxs = allTxs.slice(0, limit);

      // Apply response format (summary/compact/full)
      const formattedData = applyResponseFormat(
        limitedTxs,
        response_format || "full",
        "transactions"
      );

      const message =
        response_format === "summary"
          ? `Transaction summary for ${limitedTxs.length} transactions`
          : `Retrieved ${limitedTxs.length} transactions${allTxs.length > limit ? ` (total found: ${allTxs.length})` : ""}`;

      return formatResult(
        formattedData,
        message,
        {
          maxItems: limit,
          warnOnTruncation: false,
          metadata: {
            dataset,
            from_block,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}
