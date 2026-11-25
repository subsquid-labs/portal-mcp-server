import { PORTAL_URL } from '../constants/index.js'
import { createCache } from '../helpers/cache-manager.js'
import { RequestCancelledError, createBlockRangeError, createDatasetError } from '../helpers/errors.js'
import { portalFetch } from '../helpers/fetch.js'
import {
  type SharedPortalWork,
  getPortalRequestSignal,
  runAsSharedPortalWork,
  waitForSharedPortalWork,
} from '../helpers/request-context.js'
import type { BlockHead, ChainType, Dataset, DatasetMetadata } from '../types/index.js'

// ============================================================================
// Dataset Cache & Request Deduplication
// ============================================================================

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const DATASETS_STALE_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour stale-on-error fallback
const DATASETS_REFRESH_COOLDOWN_MS = 15 * 1000 // Pause before retrying a failed catalog refresh
const HEAD_CACHE_TTL = 30 * 1000 // 30 seconds (blocks change every 2-12s)

const headCache = createCache<BlockHead>(HEAD_CACHE_TTL, 100)
const startBlockCache = createCache<number>(CACHE_TTL, 100)
const metadataCache = createCache<{ start_block: number; head: BlockHead; finalized_head?: BlockHead }>(
  HEAD_CACHE_TTL,
  100,
)
let datasetsCache: { data: Dataset[]; timestamp: number } | null = null
let datasetsRefreshBlockedUntil = 0
const knownDatasetKinds = new Map<string, ChainType>()

const pendingRequests = new Map<string, SharedPortalWork<any>>()

export function clearDatasetCaches(): void {
  headCache.clear()
  startBlockCache.clear()
  metadataCache.clear()
  datasetsCache = null
  datasetsRefreshBlockedUntil = 0
  knownDatasetKinds.clear()
  pendingRequests.clear()
}

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const signal = getPortalRequestSignal()
  if (signal?.aborted) {
    return Promise.reject(new RequestCancelledError())
  }

  const existing = pendingRequests.get(key)
  if (existing && !existing.controller.signal.aborted) {
    return waitForSharedPortalWork(existing as SharedPortalWork<T>, signal)
  }

  const work = runAsSharedPortalWork(fn)
  pendingRequests.set(key, work)
  work.promise.then(
    () => {
      if (pendingRequests.get(key) === work) pendingRequests.delete(key)
    },
    () => {
      if (pendingRequests.get(key) === work) pendingRequests.delete(key)
    },
  )
  return waitForSharedPortalWork(work, signal)
}

function rememberDatasetKinds(datasets: Dataset[]) {
  for (const dataset of datasets) {
    const kind = dataset.metadata?.kind
    if (!kind) continue

    knownDatasetKinds.set(dataset.dataset.toLowerCase(), kind)
    dataset.aliases.forEach((alias) => knownDatasetKinds.set(alias.toLowerCase(), kind))
  }
}

export function peekKnownChainType(dataset: string): ChainType | undefined {
  return knownDatasetKinds.get(dataset.toLowerCase())
}

/**
 * Fetch all datasets with expanded metadata and schema.
 * Uses ?expand[]=metadata&expand[]=schema to get chain kind, chain_id, display_name, and available tables.
 */
export async function getDatasets(): Promise<Dataset[]> {
  const now = Date.now()
  if (datasetsCache && now - datasetsCache.timestamp < CACHE_TTL) {
    return datasetsCache.data
  }
  if (datasetsCache && now < datasetsRefreshBlockedUntil && now - datasetsCache.timestamp < DATASETS_STALE_MAX_AGE_MS) {
    return datasetsCache.data
  }

  try {
    return await dedupe('datasets', async () => {
      const data = await portalFetch<Dataset[]>(`${PORTAL_URL}/datasets?expand%5B%5D=metadata&expand%5B%5D=schema`)
      rememberDatasetKinds(data)
      datasetsCache = { data, timestamp: Date.now() }
      datasetsRefreshBlockedUntil = 0
      return data
    })
  } catch (error) {
    if (error instanceof RequestCancelledError) throw error
    if (datasetsCache && Date.now() - datasetsCache.timestamp < DATASETS_STALE_MAX_AGE_MS) {
      datasetsRefreshBlockedUntil = Date.now() + DATASETS_REFRESH_COOLDOWN_MS
      return datasetsCache.data
    }
    throw error
  }
}

/**
 * Get the chain type for a resolved dataset name from its metadata.
 * Falls back to heuristic if metadata.kind is not available.
 */
export async function getChainType(dataset: string): Promise<ChainType> {
  const datasets = await getDatasets()
  const ds = datasets.find((d) => d.dataset === dataset || d.aliases.includes(dataset))
  if (ds?.metadata?.kind) {
    return ds.metadata.kind
  }

  const cachedKind = peekKnownChainType(dataset)
  if (cachedKind) {
    return cachedKind
  }

  // Fallback heuristic for datasets without metadata
  const lower = dataset.toLowerCase()
  if (lower.includes('solana') || lower.includes('eclipse')) {
    return 'solana'
  }
  if (lower.includes('tron')) {
    return 'tron'
  }
  if (lower.includes('bitcoin')) {
    return 'bitcoin'
  }
  if (lower === 'hyperliquid-fills') {
    return 'hyperliquidFills'
  }
  if (lower === 'hyperliquid-replica-cmds') {
    return 'hyperliquidReplicaCmds'
  }
  if (
    lower.includes('substrate') ||
    [
      'acala',
      'aleph-zero',
      'asset-hub-kusama',
      'asset-hub-polkadot',
      'astar-substrate',
      'avail',
      'basilisk',
      'bifrost-kusama',
      'bifrost-polkadot',
      'bridge-hub-kusama',
      'bridge-hub-polkadot',
      'hydradx',
      'interlay',
      'karura',
      'kusama',
      'moonbeam-substrate',
      'moonriver-substrate',
      'people-chain',
      'polkadot',
      'rococo',
      'shibuya-substrate',
      'shiden-substrate',
      'vara',
      'westend',
    ].includes(lower)
  ) {
    return 'substrate'
  }
  return 'evm'
}

/**
 * Check if a dataset is an L2 chain.
 */
export function isL2Chain(dataset: string): boolean {
  const lower = dataset.toLowerCase()
  const l2Patterns = [
    'arbitrum',
    'optimism',
    'base',
    'zksync',
    'linea',
    'scroll',
    'blast',
    'mantle',
    'mode',
    'zora',
    'polygon-zkevm',
    'starknet',
    'taiko',
    'manta',
    'metis',
  ]
  return l2Patterns.some((pattern) => lower.includes(pattern))
}

/**
 * Get the available tables for a dataset from schema metadata.
 */
export async function getDatasetTables(dataset: string): Promise<string[]> {
  const datasets = await getDatasets()
  const ds = datasets.find((d) => d.dataset === dataset)
  if (ds?.schema?.tables) {
    return Object.keys(ds.schema.tables)
  }
  return []
}

// Common chain name aliases for fuzzy resolution
// Source: https://github.com/subsquid-labs/agent-skills/blob/main/portal/portal-dataset-discovery/references/full-chain-mapping.md
const CHAIN_ALIASES: Record<string, string[]> = {
  'ethereum-mainnet': ['ethereum', 'eth'],
  'arbitrum-one': ['arbitrum', 'arb'],
  'optimism-mainnet': ['optimism', 'op'],
  'base-mainnet': ['base'],
  'polygon-mainnet': ['polygon', 'matic'],
  'binance-mainnet': ['bsc', 'bnb', 'binance'],
  'avalanche-mainnet': ['avalanche', 'avax'],
  'gnosis-mainnet': ['gnosis', 'xdai'],
  'zksync-mainnet': ['zksync', 'zksync-era'],
  'blast-l2-mainnet': ['blast'],
  'scroll-mainnet': ['scroll'],
  'linea-mainnet': ['linea'],
  'mantle-mainnet': ['mantle'],
  'mode-mainnet': ['mode'],
  'taiko-mainnet': ['taiko'],
  'moonbeam-mainnet': ['moonbeam', 'glmr'],
  'moonriver-mainnet': ['moonriver', 'movr'],
  'fantom-mainnet': ['fantom', 'ftm'],
  'celo-mainnet': ['celo'],
  'worldchain-mainnet': ['worldchain', 'world'],
  'zora-mainnet': ['zora'],
  'hyperliquid-mainnet': ['hyperevm', 'hyperl', 'hyper'],
  'hyperliquid-fills': ['hl-fills', 'hlfills'],
  'hyperliquid-replica-cmds': ['hl-replica', 'hlreplica', 'hl-cmds'],
  'solana-mainnet': ['solana', 'sol'],
  'bitcoin-mainnet': ['bitcoin', 'btc'],
  polkadot: ['dot'],
  kusama: ['ksm'],
  'asset-hub-polkadot': ['asset-hub', 'assethub-polkadot', 'ah-polkadot'],
  'people-chain': ['people'],
  hydradx: ['hydra'],
  acala: ['aca'],
  'moonbeam-substrate': ['moonbeam-substrate', 'moonbeam substrate'],
  'moonriver-substrate': ['moonriver-substrate', 'moonriver substrate'],
  'astar-substrate': ['astar-substrate'],
  'shiden-substrate': ['shiden'],
  'shibuya-substrate': ['shibuya'],
  vara: ['gear', 'vara-network'],
  avail: ['data-avail'],
}

/** The nicknames this server accepts for a dataset, on top of the Portal's own aliases. */
export function getChainAliases(dataset: string): readonly string[] {
  return CHAIN_ALIASES[dataset] ?? []
}

/**
 * Resolve a dataset name or alias to the canonical dataset name.
 *
 * Every step here must be a whole-name decision. The alias table holds tokens
 * as short as `op`, `eth`, `btc` and `sol`, and matching them as substrings in
 * either direction sent real, distinct chains to the wrong one: `opbnb`
 * contains `op` and answered with Optimism, `ethereum-holesky` contains `eth`
 * and answered with Ethereum mainnet, `btc-testnet` answered with Bitcoin
 * mainnet, and the empty string matched every alias because `a.includes('')`
 * is always true. Nothing in the response said a substitution had happened, so
 * the evidence receipt certified another chain's blocks under the name the
 * caller asked for. A wrong answer is bad; a wrong answer with an audit trail
 * vouching for it is worse.
 *
 * Order matters as much as the matching. `{name}-mainnet` is tried before the
 * alias table so a real dataset always beats a nickname: `opbnb` is
 * `opbnb-mainnet`, not whatever `op` stands for.
 */
export function pickDataset(dataset: string, datasets: { dataset: string; aliases: string[] }[]): string | undefined {
  const lowerDataset = dataset.trim().toLowerCase()
  if (!lowerDataset) return undefined

  // Exact dataset name, or an alias the Portal itself declares.
  const exactMatch = datasets.find(
    (d) => d.dataset === dataset || d.aliases.includes(dataset) || d.dataset.toLowerCase() === lowerDataset,
  )
  if (exactMatch) return exactMatch.dataset

  // A real dataset beats a nickname.
  const mainnetMatch = datasets.find((d) => d.dataset.toLowerCase() === `${lowerDataset}-mainnet`)
  if (mainnetMatch) return mainnetMatch.dataset

  // Nicknames, matched whole. `eth` is Ethereum; `ethereum-holesky` is not.
  for (const [canonicalName, aliases] of Object.entries(CHAIN_ALIASES)) {
    if (aliases.includes(lowerDataset)) return canonicalName
  }

  /* A prefix is only a prefix at a name boundary, so `base` can still find
     `base-mainnet` while `btc-testnet` no longer finds `bitcoin-mainnet` and
     `solana-devnet` no longer finds `solana-mainnet`. */
  const partialMatches = datasets.filter((d) => {
    const candidate = d.dataset.toLowerCase()
    return candidate.startsWith(`${lowerDataset}-`) || candidate.endsWith(`-${lowerDataset}`)
  })
  if (!partialMatches.length) return undefined
  return (partialMatches.find((d) => d.dataset.endsWith('-mainnet')) ?? partialMatches[0]).dataset
}

export async function resolveDataset(dataset: string): Promise<string> {
  const datasets = await getDatasets()
  const picked = pickDataset(dataset, datasets)
  if (picked === undefined) throw createDatasetError(dataset, datasets.length)
  return picked
}

export async function validateDataset(dataset: string): Promise<void> {
  await resolveDataset(dataset)
}

export async function getBlockHead(
  dataset: string,
  finalized = false,
  options: { fresh?: boolean } = {},
): Promise<BlockHead> {
  const cacheKey = `${dataset}:${finalized ? 'finalized' : 'head'}`
  if (!options.fresh) {
    const cached = headCache.get(cacheKey)
    if (cached) {
      return cached
    }
  }

  return dedupe(options.fresh ? `fresh:${cacheKey}` : cacheKey, async () => {
    const endpoint = finalized ? 'finalized-head' : 'head'
    const head = await portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/${endpoint}`)
    headCache.set(cacheKey, head)
    return head
  })
}

async function getDatasetStartBlock(dataset: string): Promise<number> {
  const cached = startBlockCache.get(dataset)
  if (cached !== undefined) {
    return cached
  }

  return dedupe(`start_block:${dataset}`, async () => {
    const metadata = await portalFetch<DatasetMetadata>(`${PORTAL_URL}/datasets/${dataset}/metadata`)
    startBlockCache.set(dataset, metadata.start_block)
    return metadata.start_block
  })
}

export async function getDatasetMetadata(
  dataset: string,
  options: { includeFinalized?: boolean; fresh?: boolean } = {},
): Promise<{
  start_block: number
  head: BlockHead
  finalized_head?: BlockHead
}> {
  const includeFinalized = options.includeFinalized ?? false
  const fresh = options.fresh ?? false
  const cached = metadataCache.get(dataset)
  if (!fresh && cached && (!includeFinalized || cached.finalized_head !== undefined)) {
    return cached
  }

  const dedupeKey = `${fresh ? 'fresh:' : ''}metadata:${dataset}${includeFinalized ? ':finalized' : ''}`
  return dedupe(dedupeKey, async () => {
    const [startBlock, head, finalizedHead] = await Promise.all([
      getDatasetStartBlock(dataset),
      getBlockHead(dataset, false, { fresh }),
      includeFinalized
        ? getBlockHead(dataset, true, { fresh }).catch(() => undefined)
        : Promise.resolve(cached?.finalized_head),
    ])

    /* Merge against any finalized_head written by a concurrent lookup so a
       non-finalized refresh never wipes out a fresher finalized head. */
    const mergedFinalizedHead = finalizedHead ?? metadataCache.get(dataset)?.finalized_head
    const result = {
      start_block: startBlock,
      head,
      ...(mergedFinalizedHead !== undefined ? { finalized_head: mergedFinalizedHead } : {}),
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
  const meta = await getDatasetMetadata(dataset, { includeFinalized: finalizedOnly })

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

  return {
    validatedToBlock,
    head: finalizedOnly && meta.finalized_head ? meta.finalized_head : meta.head,
  }
}
