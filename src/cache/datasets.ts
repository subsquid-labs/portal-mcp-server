import { MAX_RECOMMENDED_BLOCK_RANGE, PORTAL_URL } from '../constants/index.js'
import { createCache } from '../helpers/cache-manager.js'
import { createBlockRangeError, createDatasetError } from '../helpers/errors.js'
import { portalFetch } from '../helpers/fetch.js'
import type { BlockHead, Dataset, DatasetMetadata } from '../types/index.js'

// ============================================================================
// Dataset Cache & Request Deduplication
// ============================================================================

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const HEAD_CACHE_TTL = 30 * 1000 // 30 seconds (blocks change every 2-12s)

// Managed caches with automatic cleanup to prevent memory leaks
const headCache = createCache<BlockHead>(HEAD_CACHE_TTL, 100) // Max 100 head entries
const metadataCache = createCache<{ start_block: number; head: BlockHead; finalized_head?: BlockHead }>(
  HEAD_CACHE_TTL,
  100,
)
let datasetsCache: { data: Dataset[]; timestamp: number } | null = null

// Request deduplication: prevent concurrent requests for same resource
const pendingRequests = new Map<string, Promise<any>>()

// Cleanup pending requests periodically to prevent leaks (Node.js only)
if (typeof process !== 'undefined' && process.versions?.node) {
  setInterval(() => {
    if (pendingRequests.size > 50) {
      console.warn(`Pending requests map has ${pendingRequests.size} entries. Possible leak?`)
    }
  }, 60000) // Check every minute
}

/**
 * Deduplicate concurrent requests to the same resource.
 * Multiple callers get the same Promise, avoiding duplicate API calls.
 */
function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!pendingRequests.has(key)) {
    const promise = fn().finally(() => pendingRequests.delete(key))
    pendingRequests.set(key, promise)
  }
  return pendingRequests.get(key) as Promise<T>
}

export async function getDatasets(): Promise<Dataset[]> {
  if (datasetsCache && Date.now() - datasetsCache.timestamp < CACHE_TTL) {
    return datasetsCache.data
  }

  return dedupe('datasets', async () => {
    const data = await portalFetch<Dataset[]>(`${PORTAL_URL}/datasets`)
    datasetsCache = { data, timestamp: Date.now() }
    return data
  })
}

// Common chain name aliases
const CHAIN_ALIASES: Record<string, string[]> = {
  'hyperliquid-mainnet': ['hyperevm', 'hyperl', 'hyper'],
  'arbitrum-one': ['arbitrum', 'arb'],
  'optimism-mainnet': ['optimism', 'op'],
  'polygon-mainnet': ['polygon', 'matic'],
  'avalanche-mainnet': ['avalanche', 'avax'],
  'binance-mainnet': ['bsc', 'bnb', 'binance'],
  'base-mainnet': ['base'],
  'ethereum-mainnet': ['ethereum', 'eth'],
}

/**
 * Resolve a dataset name or alias to the canonical dataset name.
 * Supports fuzzy matching for common shortcuts like "polygon" -> "polygon-mainnet"
 */
export async function resolveDataset(dataset: string): Promise<string> {
  const datasets = await getDatasets()

  // Exact match
  const exactMatch = datasets.find((d) => d.dataset === dataset || d.aliases.includes(dataset))
  if (exactMatch) {
    return exactMatch.dataset
  }

  // Fuzzy match: prefer mainnet if user provides just the chain name
  const lowerDataset = dataset.toLowerCase()

  // Check common aliases first
  for (const [canonicalName, aliases] of Object.entries(CHAIN_ALIASES)) {
    if (aliases.some((a) => a === lowerDataset || lowerDataset.includes(a) || a.includes(lowerDataset))) {
      return canonicalName
    }
  }

  // Try "{name}-mainnet" first
  const mainnetMatch = datasets.find((d) => d.dataset === `${lowerDataset}-mainnet`)
  if (mainnetMatch) {
    return mainnetMatch.dataset
  }

  // Try partial match on dataset name
  const partialMatches = datasets.filter(
    (d) =>
      d.dataset.toLowerCase().startsWith(lowerDataset) ||
      d.dataset.toLowerCase().includes(`-${lowerDataset}-`) ||
      (lowerDataset.includes('-') && d.dataset.toLowerCase().includes(lowerDataset)),
  )

  // If multiple matches, prefer mainnet
  if (partialMatches.length > 0) {
    const preferredMatch = partialMatches.find((d) => d.dataset.includes('-mainnet')) || partialMatches[0]
    return preferredMatch.dataset
  }

  // No match found
  throw createDatasetError(dataset, datasets.length)
}

export async function validateDataset(dataset: string): Promise<void> {
  // Just call resolveDataset and ignore the result - will throw if invalid
  await resolveDataset(dataset)
}

/**
 * Get block head with caching (30s TTL).
 * Blocks are produced every 2-12s depending on chain, so 30s cache is safe.
 */
export async function getBlockHead(dataset: string, finalized = false): Promise<BlockHead> {
  const cacheKey = `${dataset}:${finalized ? 'finalized' : 'head'}`
  const cached = headCache.get(cacheKey)

  if (cached) {
    return cached
  }

  return dedupe(cacheKey, async () => {
    const endpoint = finalized ? 'finalized-head' : 'head'
    const head = await portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/${endpoint}`)
    headCache.set(cacheKey, head)
    return head
  })
}

export async function getDatasetMetadata(dataset: string): Promise<{
  start_block: number
  head: BlockHead
  finalized_head?: BlockHead
}> {
  // Check cache first (30s TTL for metadata too)
  const cached = metadataCache.get(dataset)
  if (cached) {
    return cached
  }

  return dedupe(`metadata:${dataset}`, async () => {
    const [metadata, head, finalizedHead] = await Promise.all([
      portalFetch<DatasetMetadata>(`${PORTAL_URL}/datasets/${dataset}/metadata`),
      getBlockHead(dataset, false),
      getBlockHead(dataset, true).catch(() => undefined),
    ])

    const result = {
      start_block: metadata.start_block,
      head,
      finalized_head: finalizedHead,
    }

    metadataCache.set(dataset, result)
    return result
  })
}

export async function validateBlockRange(
  dataset: string,
  fromBlock: number,
  toBlock: number,
  finalizedOnly: boolean = false,
): Promise<{ validatedToBlock: number; head: BlockHead }> {
  const meta = await getDatasetMetadata(dataset)

  if (fromBlock < meta.start_block) {
    throw createBlockRangeError(
      fromBlock,
      toBlock,
      `fromBlock (${fromBlock.toLocaleString()}) is before dataset start block (${meta.start_block.toLocaleString()})`,
    )
  }

  const maxBlock = finalizedOnly && meta.finalized_head ? meta.finalized_head.number : meta.head.number

  if (fromBlock > maxBlock) {
    throw createBlockRangeError(
      fromBlock,
      toBlock,
      `fromBlock (${fromBlock.toLocaleString()}) is beyond ${finalizedOnly ? 'finalized' : 'latest'} block (${maxBlock.toLocaleString()})`,
    )
  }

  if (toBlock < fromBlock) {
    throw createBlockRangeError(fromBlock, toBlock, 'toBlock must be >= fromBlock')
  }

  const validatedToBlock = Math.min(toBlock, maxBlock)

  // Warn about large block ranges (informational only, not an error)
  // Based on real Portal API benchmarks: 10k blocks = ~500ms, 5k blocks = ~100ms
  const blockRange = validatedToBlock - fromBlock
  if (blockRange > MAX_RECOMMENDED_BLOCK_RANGE.LOGS) {
    console.warn(
      `WARNING: LARGE RANGE: ${blockRange.toLocaleString()} blocks (${fromBlock} → ${validatedToBlock}).\n` +
        `   For fast responses (<1-3s), use smaller ranges:\n` +
        `   - Logs: <${MAX_RECOMMENDED_BLOCK_RANGE.LOGS.toLocaleString()} blocks (~500ms)\n` +
        `   - Transactions: <${MAX_RECOMMENDED_BLOCK_RANGE.TRANSACTIONS.toLocaleString()} blocks (~100ms)\n` +
        `   - Traces: <${MAX_RECOMMENDED_BLOCK_RANGE.TRACES.toLocaleString()} blocks (expensive)\n` +
        `   Large ranges may take >15s or timeout.`,
    )
  }

  return {
    validatedToBlock,
    head: finalizedOnly && meta.finalized_head ? meta.finalized_head : meta.head,
  }
}
