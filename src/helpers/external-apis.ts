// ============================================================================
// External API Integrations
// ============================================================================
//
// Integrations with external data sources to enrich blockchain data:
// - DeFi Llama: Protocol TVL, yields, fees, volumes
// - CoinGecko: Token metadata, prices, logos
//

import { createCache } from './cache-manager.js'

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Managed cache with automatic cleanup to prevent memory leaks
// Max 500 entries for external API data (token lists can be large)
const cache = createCache<unknown>(CACHE_TTL, 500)

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

// ============================================================================
// CoinGecko Token Lists
// ============================================================================

export interface CoinGeckoToken {
  chainId: number
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

const COINGECKO_TOKEN_LISTS: Record<string, string> = {
  ethereum: 'https://tokens.coingecko.com/ethereum/all.json',
  base: 'https://tokens.coingecko.com/base/all.json',
  arbitrum: 'https://tokens.coingecko.com/arbitrum-one/all.json',
  optimism: 'https://tokens.coingecko.com/optimistic-ethereum/all.json',
  polygon: 'https://tokens.coingecko.com/polygon-pos/all.json',
  avalanche: 'https://tokens.coingecko.com/avalanche/all.json',
  bsc: 'https://tokens.coingecko.com/binance-smart-chain/all.json',
}

/**
 * Get token list for a chain from CoinGecko
 */
export async function getCoinGeckoTokenList(chain: string): Promise<CoinGeckoToken[]> {
  const url = COINGECKO_TOKEN_LISTS[chain.toLowerCase()]
  if (!url) {
    throw new Error(
      `No CoinGecko token list available for chain: ${chain}. Available: ${Object.keys(COINGECKO_TOKEN_LISTS).join(', ')}`,
    )
  }

  return withCache(`coingecko:${chain}`, CACHE_TTL, async () => {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as CoinGeckoTokenList
    return data.tokens
  })
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
    const response = await fetch(`${DEFILLAMA_API}/protocols`, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`DeFi Llama API error: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as DefiLlamaProtocol[]
  })
}

/**
 * Get specific protocol details from DeFi Llama
 */
export async function getDefiLlamaProtocol(slug: string): Promise<any> {
  return withCache(`defillama:protocol:${slug}`, CACHE_TTL, async () => {
    const response = await fetch(`${DEFILLAMA_API}/protocol/${slug}`, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`DeFi Llama API error: ${response.status} ${response.statusText}`)
    }

    return await response.json()
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
    const response = await fetch(`${DEFILLAMA_API}/v2/chains`, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`DeFi Llama API error: ${response.status} ${response.statusText}`)
    }

    const chains = (await response.json()) as any[]
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
    const response = await fetch(`${DEFILLAMA_API}/stablecoins?includePrices=true`, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`DeFi Llama API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.peggedAssets || []
  })
}

/**
 * Get yields/APY data from DeFi Llama
 */
export async function getYieldPools(): Promise<any[]> {
  return withCache('defillama:yields', CACHE_TTL, async () => {
    const response = await fetch('https://yields.llama.fi/pools', {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`DeFi Llama Yields API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.data || []
  })
}

/**
 * Get fees and revenue data from DeFi Llama
 */
export async function getProtocolFees(protocol: string): Promise<any> {
  return withCache(`defillama:fees:${protocol}`, CACHE_TTL, async () => {
    const response = await fetch(`${DEFILLAMA_API}/summary/fees/${protocol}`, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(`DeFi Llama API error: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  })
}
