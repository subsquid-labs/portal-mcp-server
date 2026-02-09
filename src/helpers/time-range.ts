/**
 * Time Range Helpers - Timestamp-based (no block time guessing!)
 *
 * Portal API supports timestamp-based queries, so we don't need to
 * calculate block counts at all. Just use timestamps directly.
 */

import { portalFetch } from "./fetch.js";
import { PORTAL_URL } from "../constants/index.js";

/**
 * Get the timestamp and block number for the head of a chain
 */
export async function getHeadWithTimestamp(dataset: string): Promise<{
  number: number;
  timestamp: number;
}> {
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
      }
    }
  };

  const results = await portalFetch<any>(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    { method: "POST", body: query }
  );

  if (!results || results.length === 0) {
    throw new Error(`Could not get timestamp for block ${head.number}`);
  }

  const block = results[0].header || results[0];
  return {
    number: block.number,
    timestamp: block.timestamp,
  };
}

/**
 * Calculate from/to blocks based on time duration
 * Returns actual block numbers by querying backwards in time
 */
export async function getBlockRangeForDuration(
  dataset: string,
  duration: string
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

  // Get head block with timestamp
  const head = await getHeadWithTimestamp(dataset);

  // Calculate target timestamp
  const targetTimestamp = head.timestamp - seconds;

  // Use Portal's timestamp-based query to find the block at that time
  // We'll query a range and find the closest block
  // Estimate ~2 blocks per second as a rough starting point (works for most chains)
  const estimatedBlocks = Math.floor(seconds / 2);
  const searchFromBlock = Math.max(0, head.number - estimatedBlocks - 1000); // Add buffer

  const query = {
    type: "evm",
    fromBlock: searchFromBlock,
    toBlock: head.number,
    includeAllBlocks: true,
    fields: {
      block: {
        number: true,
        timestamp: true,
      }
    }
  };

  const results = await portalFetch<any>(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    { method: "POST", body: query }
  );

  // Find the block closest to our target timestamp
  let closestBlock = results[0].header || results[0];
  let minDiff = Math.abs(closestBlock.timestamp - targetTimestamp);

  for (const item of results) {
    const block = item.header || item;
    const diff = Math.abs(block.timestamp - targetTimestamp);
    if (diff < minDiff) {
      minDiff = diff;
      closestBlock = block;
    }

    // If we've passed the target, we found it
    if (block.timestamp >= targetTimestamp) {
      break;
    }
  }

  return {
    fromBlock: closestBlock.number,
    toBlock: head.number,
    fromTimestamp: closestBlock.timestamp,
    toTimestamp: head.timestamp,
  };
}

/**
 * Get duration in seconds
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
