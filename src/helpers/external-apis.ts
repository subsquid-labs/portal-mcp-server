// ============================================================================
// External API Integrations
// ============================================================================
//
// Integrations with external data sources to enrich blockchain data:
// - DeFi Llama: Protocol TVL, yields, fees, volumes
// - CoinGecko: Token metadata, prices, logos
// - DEX Screener: DEX pool address and token-pair metadata
//

import { tokenListCacheEventsTotal, tokenListRequestsTotal } from '../metrics.js'
import { createCache } from './cache-manager.js'
import { ActionableError, RequestCancelledError } from './errors.js'
import {
  type SharedPortalWork,
  createRequestAbortContext,
  isAbortLike,
  runAsSharedPortalWork,
  waitForSharedPortalWork,
} from './request-context.js'

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const EXTERNAL_API_TIMEOUT_MS = 5_000
const TOKEN_LIST_FETCH_ATTEMPTS = 2

// Managed cache with automatic cleanup to prevent memory leaks
// Max 500 entries for external API data (token lists can be large)
const cache = createCache<unknown>(CACHE_TTL, 500)
const tokenListCache = createCache<TokenListCacheRecord>(CACHE_TTL, 50)
const staleTokenLists = new Map<string, TokenListCacheRecord>()
const pendingTokenLists = new Map<string, SharedPortalWork<TokenListCacheRecord>>()

/**
 * Simple cache wrapper for external API calls
 */
function withCache<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const cached = cache.get(key)
  if (cached) {
    return Promise.resolve(cached as T)
  }

  return fn().then((data) => {
    cache.set(key, data)
    return data
  })
}

export async function fetchExternalJson<T>(
  url: string,
  label: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<T> {
  const { timeout = EXTERNAL_API_TIMEOUT_MS, ...fetchOptions } = options
  const abortContext = createRequestAbortContext(timeout)

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        Accept: 'application/json',
        ...fetchOptions.headers,
      },
      signal: abortContext.signal,
    })

    if (!response.ok) {
      throw new Error(`${label} error: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as T
  } catch (error) {
    if (isAbortLike(error) || abortContext.signal.aborted) {
      if (abortContext.wasCancelled()) throw new RequestCancelledError()
      if (abortContext.didTimeout()) {
        throw new ActionableError(`${label} timed out after ${timeout}ms`, [
          'Retry the request; enrichment services can be temporarily slow.',
          'The Portal query itself may still be available without external enrichment.',
        ])
      }
    }
    throw error
  } finally {
    abortContext.cleanup()
  }
}

// ============================================================================
// CoinGecko Token Lists
// ============================================================================

export interface CoinGeckoToken {
  chainId: number | null
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

interface CoinGeckoTokenList {
  name: string
  tokens: CoinGeckoToken[]
}

type TokenListCacheRecord = {
  tokens: CoinGeckoToken[]
  fetchedAt: number
}

export interface CoinGeckoTokenListResult {
  source: 'coingecko_token_list'
  chain: string
  tokens: CoinGeckoToken[]
  cache_status: 'fresh' | 'stale'
  fetched_at: number
  age_ms: number
}

const COINGECKO_TOKEN_LISTS: Record<string, string> = {
  ethereum: 'https://tokens.coingecko.com/ethereum/all.json',
  base: 'https://tokens.coingecko.com/base/all.json',
  arbitrum: 'https://tokens.coingecko.com/arbitrum-one/all.json',
  optimism: 'https://tokens.coingecko.com/optimistic-ethereum/all.json',
  polygon: 'https://tokens.coingecko.com/polygon-pos/all.json',
  avalanche: 'https://tokens.coingecko.com/avalanche/all.json',
  bsc: 'https://tokens.coingecko.com/binance-smart-chain/all.json',
  solana: 'https://tokens.coingecko.com/solana/all.json',
  tron: 'https://tokens.coingecko.com/tron/all.json',
}

function buildTokenListResult(chain: string, record: TokenListCacheRecord, cacheStatus: 'fresh' | 'stale') {
  return {
    source: 'coingecko_token_list' as const,
    chain,
    tokens: record.tokens,
    cache_status: cacheStatus,
    fetched_at: record.fetchedAt,
    age_ms: Math.max(0, Date.now() - record.fetchedAt),
  }
}

function isRetryableTokenListError(error: unknown): boolean {
  if (error instanceof RequestCancelledError) return false
  if (error instanceof ActionableError) return error.retryable
  if (!(error instanceof Error)) return false
  return /fetch failed|network|socket|\b429\b|\b5\d\d\b/i.test(error.message)
}

async function fetchCoinGeckoTokenList(chain: string, url: string): Promise<CoinGeckoTokenList> {
  let lastError: unknown

  for (let attempt = 1; attempt <= TOKEN_LIST_FETCH_ATTEMPTS; attempt += 1) {
    tokenListRequestsTotal.inc({ source: 'coingecko_token_list', chain, status: 'attempt' })
    try {
      const data = await fetchExternalJson<CoinGeckoTokenList>(url, 'CoinGecko API')
      tokenListRequestsTotal.inc({ source: 'coingecko_token_list', chain, status: 'success' })
      return data
    } catch (error) {
      tokenListRequestsTotal.inc({ source: 'coingecko_token_list', chain, status: 'error' })
      if (error instanceof RequestCancelledError) throw error
      lastError = error
      if (attempt >= TOKEN_LIST_FETCH_ATTEMPTS || !isRetryableTokenListError(error)) throw error
      tokenListCacheEventsTotal.inc({ source: 'coingecko_token_list', chain, event: 'retry' })
    }
  }

  throw lastError
}

/**
 * Get token list for a chain from CoinGecko
 */
export async function getCoinGeckoTokenListWithStatus(chain: string): Promise<CoinGeckoTokenListResult> {
  const normalizedChain = chain.toLowerCase()
  const source = 'coingecko_token_list'
  const url = COINGECKO_TOKEN_LISTS[normalizedChain]
  if (!url) {
    tokenListRequestsTotal.inc({ source, chain: normalizedChain, status: 'unsupported' })
    throw new Error(
      `No CoinGecko token list available for chain: ${chain}. Available: ${Object.keys(COINGECKO_TOKEN_LISTS).join(', ')}`,
    )
  }

  const cacheKey = `coingecko:${normalizedChain}`
  const cached = tokenListCache.get(cacheKey)
  if (cached) {
    tokenListCacheEventsTotal.inc({ source, chain: normalizedChain, event: 'hit' })
    return buildTokenListResult(normalizedChain, cached, 'fresh')
  }

  tokenListCacheEventsTotal.inc({ source, chain: normalizedChain, event: 'miss' })

  const existingPending = pendingTokenLists.get(cacheKey)
  const work =
    existingPending ??
    runAsSharedPortalWork(async () => {
      const data = await fetchCoinGeckoTokenList(normalizedChain, url)
      const loaded = { tokens: data.tokens, fetchedAt: Date.now() }
      tokenListCache.set(cacheKey, loaded)
      staleTokenLists.set(cacheKey, loaded)
      tokenListCacheEventsTotal.inc({ source, chain: normalizedChain, event: 'store' })
      return loaded
    })
  if (!existingPending) {
    pendingTokenLists.set(cacheKey, work)
    work.promise.then(
      () => {
        if (pendingTokenLists.get(cacheKey) === work) pendingTokenLists.delete(cacheKey)
      },
      () => {
        if (pendingTokenLists.get(cacheKey) === work) pendingTokenLists.delete(cacheKey)
      },
    )
  }

  try {
    const record = await waitForSharedPortalWork(work)
    return buildTokenListResult(normalizedChain, record, 'fresh')
  } catch (error) {
    if (error instanceof RequestCancelledError) throw error
    const stale = staleTokenLists.get(cacheKey)
    if (stale) {
      tokenListCacheEventsTotal.inc({ source, chain: normalizedChain, event: 'stale_hit' })
      return buildTokenListResult(normalizedChain, stale, 'stale')
    }
    tokenListCacheEventsTotal.inc({ source, chain: normalizedChain, event: 'stale_miss' })
    throw error
  }
}

export async function getCoinGeckoTokenList(chain: string): Promise<CoinGeckoToken[]> {
  const result = await getCoinGeckoTokenListWithStatus(chain)
  return result.tokens
}

/**
 * Find token by address from CoinGecko token list
 */
export async function findTokenByAddress(chain: string, address: string): Promise<CoinGeckoToken | null> {
  const tokens = await getCoinGeckoTokenList(chain)
  const normalizedAddress = address.toLowerCase()
  return tokens.find((t) => t.address.toLowerCase() === normalizedAddress) || null
}

/**
 * Find tokens by symbol from CoinGecko token list
 */
export async function findTokensBySymbol(chain: string, symbol: string): Promise<CoinGeckoToken[]> {
  const tokens = await getCoinGeckoTokenList(chain)
  const normalizedSymbol = symbol.toUpperCase()
  return tokens.filter((t) => t.symbol.toUpperCase() === normalizedSymbol)
}

// ============================================================================
// DEX Screener Pool Metadata
// ============================================================================

const DEXSCREENER_API = 'https://api.dexscreener.com'

export type DexScreenerToken = {
  address: string
  name: string
  symbol: string
}

export type DexScreenerPair = {
  chainId: string
  dexId: string
  pairAddress: string
  labels: string[]
  baseToken: DexScreenerToken
  quoteToken: DexScreenerToken
  liquidityUsd?: number
}

type DexScreenerPairResponse = {
  pairs?: unknown[] | null
}

function normalizeDexScreenerPair(value: unknown): DexScreenerPair | undefined {
  if (!value || typeof value !== 'object') return undefined
  const pair = value as Record<string, unknown>
  const baseToken = pair.baseToken as Record<string, unknown> | undefined
  const quoteToken = pair.quoteToken as Record<string, unknown> | undefined
  const liquidity = pair.liquidity as Record<string, unknown> | undefined

  if (
    typeof pair.chainId !== 'string' ||
    typeof pair.dexId !== 'string' ||
    typeof pair.pairAddress !== 'string' ||
    typeof baseToken?.address !== 'string' ||
    typeof baseToken?.name !== 'string' ||
    typeof baseToken?.symbol !== 'string' ||
    typeof quoteToken?.address !== 'string' ||
    typeof quoteToken?.name !== 'string' ||
    typeof quoteToken?.symbol !== 'string'
  ) {
    return undefined
  }

  return {
    chainId: pair.chainId,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    labels: Array.isArray(pair.labels) ? pair.labels.filter((label): label is string => typeof label === 'string') : [],
    baseToken: {
      address: baseToken.address,
      name: baseToken.name,
      symbol: baseToken.symbol,
    },
    quoteToken: {
      address: quoteToken.address,
      name: quoteToken.name,
      symbol: quoteToken.symbol,
    },
    ...(typeof liquidity?.usd === 'number' && Number.isFinite(liquidity.usd) ? { liquidityUsd: liquidity.usd } : {}),
  }
}

export async function getDexScreenerPair(chain: string, pairAddress: string): Promise<DexScreenerPair | undefined> {
  const normalizedChain = chain.trim().toLowerCase()
  const normalizedPairAddress = pairAddress.trim().toLowerCase()
  return withCache(`dexscreener:pair:${normalizedChain}:${normalizedPairAddress}`, CACHE_TTL, async () => {
    const response = await fetchExternalJson<DexScreenerPairResponse>(
      `${DEXSCREENER_API}/latest/dex/pairs/${encodeURIComponent(normalizedChain)}/${encodeURIComponent(normalizedPairAddress)}`,
      'DEX Screener API',
    )
    return (response.pairs ?? []).map(normalizeDexScreenerPair).find((pair): pair is DexScreenerPair => Boolean(pair))
  })
}

export async function getDexScreenerTokenPairs(chain: string, tokenAddress: string): Promise<DexScreenerPair[]> {
  const normalizedChain = chain.trim().toLowerCase()
  const normalizedTokenAddress = tokenAddress.trim().toLowerCase()
  return withCache(`dexscreener:token-pairs:${normalizedChain}:${normalizedTokenAddress}`, CACHE_TTL, async () => {
    const response = await fetchExternalJson<unknown[]>(
      `${DEXSCREENER_API}/token-pairs/v1/${encodeURIComponent(normalizedChain)}/${encodeURIComponent(normalizedTokenAddress)}`,
      'DEX Screener API',
    )
    return (Array.isArray(response) ? response : [])
      .map(normalizeDexScreenerPair)
      .filter((pair): pair is DexScreenerPair => Boolean(pair))
  })
}

// ============================================================================
// DeFi Llama API
// ============================================================================

const DEFILLAMA_API = 'https://api.llama.fi'

export interface DefiLlamaProtocol {
  id: string
  name: string
  address: string | null
  symbol: string
  url: string
  description: string
  chain: string
  logo: string
  audits: string
  audit_note: string | null
  gecko_id: string | null
  cmcId: string | null
  category: string
  chains: string[]
  module: string
  twitter: string | null
  forkedFrom: string[]
  oracles: string[]
  listedAt: number
  slug: string
  tvl: number
  chainTvls: Record<string, number>
  change_1h: number | null
  change_1d: number | null
  change_7d: number | null
  fdv: number | null
  mcap: number | null
}

export interface DefiLlamaTvlResponse {
  id: string
  name: string
  address: string | null
  symbol: string
  chain: string
  tvl: number
  chainTvls: Record<string, number>
}

/**
 * Get all DeFi protocols from DeFi Llama
 */
export async function getDefiLlamaProtocols(): Promise<DefiLlamaProtocol[]> {
  return withCache('defillama:protocols', CACHE_TTL, async () => {
    return fetchExternalJson<DefiLlamaProtocol[]>(`${DEFILLAMA_API}/protocols`, 'DeFi Llama API')
  })
}

/**
 * Get specific protocol details from DeFi Llama
 */
export async function getDefiLlamaProtocol(slug: string): Promise<any> {
  return withCache(`defillama:protocol:${slug}`, CACHE_TTL, async () => {
    return fetchExternalJson(`${DEFILLAMA_API}/protocol/${slug}`, 'DeFi Llama API')
  })
}

/**
 * Find DeFi protocols by chain
 */
export async function findProtocolsByChain(chain: string): Promise<DefiLlamaProtocol[]> {
  const protocols = await getDefiLlamaProtocols()
  const normalizedChain = chain.toLowerCase()

  return protocols.filter((p) =>
    p.chains.some((c) => c.toLowerCase().includes(normalizedChain) || normalizedChain.includes(c.toLowerCase())),
  )
}

/**
 * Find DeFi protocol by name or slug
 */
export async function findProtocolByName(name: string): Promise<DefiLlamaProtocol | null> {
  const protocols = await getDefiLlamaProtocols()
  const normalizedName = name.toLowerCase()

  return (
    protocols.find(
      (p) =>
        p.name.toLowerCase() === normalizedName ||
        p.slug.toLowerCase() === normalizedName ||
        p.name.toLowerCase().includes(normalizedName),
    ) || null
  )
}

/**
 * Get TVL for a specific chain from DeFi Llama
 */
export async function getChainTvl(chain: string): Promise<{ tvl: number; protocols: number }> {
  return withCache(`defillama:chain:${chain}`, CACHE_TTL, async () => {
    const chains = await fetchExternalJson<any[]>(`${DEFILLAMA_API}/v2/chains`, 'DeFi Llama API')
    const normalizedChain = chain.toLowerCase()

    const chainData = chains.find(
      (c) => c.name?.toLowerCase() === normalizedChain || c.gecko_id?.toLowerCase() === normalizedChain,
    )

    if (!chainData) {
      throw new Error(`Chain not found in DeFi Llama: ${chain}`)
    }

    return {
      tvl: chainData.tvl || 0,
      protocols: chainData.protocols || 0,
    }
  })
}

/**
 * Get stablecoin info from DeFi Llama
 */
export async function getStablecoins(): Promise<any[]> {
  return withCache('defillama:stablecoins', CACHE_TTL, async () => {
    const data = await fetchExternalJson<any>(`${DEFILLAMA_API}/stablecoins?includePrices=true`, 'DeFi Llama API')
    return data.peggedAssets || []
  })
}

/**
 * Get yields/APY data from DeFi Llama
 */
export async function getYieldPools(): Promise<any[]> {
  return withCache('defillama:yields', CACHE_TTL, async () => {
    const data = await fetchExternalJson<any>('https://yields.llama.fi/pools', 'DeFi Llama Yields API')
    return data.data || []
  })
}

/**
 * Get fees and revenue data from DeFi Llama
 */
export async function getProtocolFees(protocol: string): Promise<any> {
  return withCache(`defillama:fees:${protocol}`, CACHE_TTL, async () => {
    return fetchExternalJson(`${DEFILLAMA_API}/summary/fees/${protocol}`, 'DeFi Llama API')
  })
}
