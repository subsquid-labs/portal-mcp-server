/**
 * Timestamp to Block Number Conversion
 *
 * Portal API provides a direct endpoint to convert timestamps to block numbers.
 * This eliminates the need for block time calculations entirely.
 *
 * Endpoint: GET /datasets/{dataset}/timestamps/{timestamp}/block
 */

import { portalFetch, portalFetchStream } from "./fetch.js";
import { PORTAL_URL } from "../constants/index.js";

/**
 * Convert a Unix timestamp to a block number
 * Tries Portal's /timestamps/ endpoint first (fast), falls back to binary search
 */
export async function timestampToBlock(
  dataset: string,
  timestamp: number,
  maxBlock: number
): Promise<number> {
  // Try the fast /timestamps/ endpoint first (works on Base, Polygon, Optimism)
  try {
    const result = await portalFetch<{ block_number: number }>(
      `${PORTAL_URL}/datasets/${dataset}/timestamps/${Math.floor(timestamp)}/block`
    );
    return result.block_number;
  } catch (error) {
    // Falls back to binary search for chains that don't support /timestamps/
    // (Ethereum, Arbitrum, or if timestamp is too recent)
  }

  // Binary search fallback
  let low = 0;
  let high = maxBlock;
  let result = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const query = {
      type: "evm",
      fromBlock: mid,
      toBlock: mid,
      fields: { block: { timestamp: true, number: true } },
      includeAllBlocks: true,
    };

    const response = await portalFetchStream(
      `${PORTAL_URL}/datasets/${dataset}/stream`,
      query,
    );

    if (response.length > 0) {
      const block = response[0] as { header: { timestamp: number; number: number } };
      if (block.header.timestamp <= timestamp) {
        result = block.header.number;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    } else {
      high = mid - 1;
    }
  }

  return result;
}

/**
 * Get current block number and its timestamp by querying Portal
 */
async function getHeadBlockWithTimestamp(
  dataset: string
): Promise<{ number: number; timestamp: number }> {
  // Get head block number
  const head = await portalFetch<{ number: number }>(
    `${PORTAL_URL}/datasets/${dataset}/head`
  );

  // Query that specific block to get its timestamp
  const query = {
    type: "evm",
    fromBlock: head.number,
    toBlock: head.number,
    includeAllBlocks: true,
    fields: {
      block: {
        number: true,
        timestamp: true,
      },
    },
  };

  const response = await portalFetchStream(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    query
  );

  if (!response || response.length === 0) {
    throw new Error(`Could not get timestamp for head block ${head.number}`);
  }

  const block = (response[0] as any).header || response[0];
  return {
    number: block.number,
    timestamp: block.timestamp,
  };
}

/**
 * Get block range for a time duration (e.g., "24h", "7d")
 * Returns { fromBlock, toBlock } using Portal's timestamp-to-block endpoint
 */
export async function getBlockRangeForDuration(
  dataset: string,
  duration: string,
  endTimestamp?: number
): Promise<{ fromBlock: number; toBlock: number; fromTimestamp: number; toTimestamp: number }> {
  const durations: Record<string, number> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "6h": 21600,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
  };

  const seconds = durations[duration];
  if (!seconds) {
    throw new Error(`Unknown duration: ${duration}. Use: 1m, 5m, 15m, 1h, 6h, 24h, 7d, 30d`);
  }

  // Get the latest block and its actual timestamp (no guessing!)
  const head = await getHeadBlockWithTimestamp(dataset);
  const toBlock = head.number;
  const toTimestamp = endTimestamp || head.timestamp;

  // Calculate target timestamp
  const fromTimestamp = toTimestamp - seconds;

  // Convert start timestamp to block number using binary search
  const fromBlock = await timestampToBlock(dataset, fromTimestamp, toBlock);

  return {
    fromBlock,
    toBlock,
    fromTimestamp,
    toTimestamp,
  };
}

/**
 * Get duration in seconds (utility function)
 */
export function getDurationSeconds(duration: string): number {
  const durations: Record<string, number> = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "6h": 21600,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
  };

  const seconds = durations[duration];
  if (!seconds) {
    throw new Error(`Unknown duration: ${duration}`);
  }

  return seconds;
}
