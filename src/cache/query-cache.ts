import { ManagedCache, estimateSize } from '../helpers/cache-manager.js'

export interface QueryCacheOptions {
  ttl: number
  maxEntries?: number
  maxSize?: number
  cleanupInterval?: number
}

export type QueryCacheResultSource = 'cache' | 'pending' | 'fresh'

export type QueryCacheResult<T> = {
  value: T
  source: QueryCacheResultSource
  cachedAt: number
}

type CachedValue<T> = {
  value: T
  cachedAt: number
}

export class QueryCache<T> {
  private readonly cache: ManagedCache<CachedValue<T>>
  private readonly pending = new Map<string, Promise<CachedValue<T>>>()

  constructor(options: QueryCacheOptions) {
    this.cache = new ManagedCache<CachedValue<T>>(options)
  }

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<QueryCacheResult<T>> {
    const cached = this.cache.get(key)
    if (cached) {
      return {
        value: cached.value,
        source: 'cache',
        cachedAt: cached.cachedAt,
      }
    }

    const existingPending = this.pending.get(key)
    if (existingPending) {
      const shared = await existingPending
      return {
        value: shared.value,
        source: 'pending',
        cachedAt: shared.cachedAt,
      }
    }

    const pendingLoad = (async () => {
      const value = await loader()
      const cachedValue: CachedValue<T> = {
        value,
        cachedAt: Date.now(),
      }
      this.cache.set(key, cachedValue, estimateSize(cachedValue))
      return cachedValue
    })()

    this.pending.set(key, pendingLoad)

    try {
      const fresh = await pendingLoad
      return {
        value: fresh.value,
        source: 'fresh',
        cachedAt: fresh.cachedAt,
      }
    } finally {
      this.pending.delete(key)
    }
  }
}

export function createQueryCache<T>(options: QueryCacheOptions): QueryCache<T> {
  return new QueryCache<T>(options)
}

export function stableCacheKey(prefix: string, value: unknown): string {
  return `${prefix}:${JSON.stringify(normalizeForCacheKey(value))}`
}

function normalizeForCacheKey(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForCacheKey(entry))
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entryValue]) => [entryKey, normalizeForCacheKey(entryValue)]),
    )
  }

  return value
}
