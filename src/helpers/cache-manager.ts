// ============================================================================
// Cache Manager with Automatic Memory Management
// ============================================================================
//
// Problem: Maps/Sets in Node.js never release memory even after entries expire
// Solution: Periodic cleanup + size limits to prevent memory leaks
//

export interface CacheEntry<T> {
  data: T
  timestamp: number
  size?: number // Optional size tracking
}

export interface CacheOptions {
  ttl: number // Time to live in milliseconds
  maxEntries?: number // Max entries before cleanup (default: 1000)
  maxSize?: number // Max total size in bytes (optional)
  cleanupInterval?: number // How often to cleanup (default: 60s)
}

/**
 * Self-cleaning cache that prevents memory leaks
 */
export class ManagedCache<T> {
  private cache = new Map<string, CacheEntry<T>>()
  private options: Required<Omit<CacheOptions, 'maxSize'>> & { maxSize?: number }
  private cleanupTimer: NodeJS.Timeout | null = null
  private totalSize = 0

  constructor(options: CacheOptions) {
    this.options = {
      ttl: options.ttl,
      maxEntries: options.maxEntries || 1000,
      maxSize: options.maxSize,
      cleanupInterval: options.cleanupInterval || 60000, // 60s default
    }

    // Start periodic cleanup (only in Node.js, not in Workers global scope)
    // Workers will rely on lazy cleanup during get/set operations
    if (typeof process !== 'undefined' && process.versions?.node) {
      this.startCleanup()
    }
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key)

    if (!entry) return undefined

    // Check if expired
    if (Date.now() - entry.timestamp > this.options.ttl) {
      this.delete(key)
      return undefined
    }

    return entry.data
  }

  set(key: string, data: T, size?: number): void {
    // Delete old entry if exists
    if (this.cache.has(key)) {
      this.delete(key)
    }

    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      size,
    }

    this.cache.set(key, entry)

    if (size) {
      this.totalSize += size
    }

    // Lazy cleanup on set (for Workers compatibility)
    // Check if we need emergency cleanup
    if (this.cache.size > this.options.maxEntries * 1.5) {
      console.warn(
        `Cache size exceeded 150% of max (${this.cache.size} > ${this.options.maxEntries}). Running emergency cleanup.`,
      )
      this.cleanup()
    }

    if (this.options.maxSize && this.totalSize > this.options.maxSize) {
      console.warn(`Cache memory exceeded limit (${this.totalSize} bytes). Running emergency cleanup.`)
      this.cleanup()
    }
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key)
    if (entry && entry.size) {
      this.totalSize -= entry.size
    }
    return this.cache.delete(key)
  }

  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false

    // Check if expired
    if (Date.now() - entry.timestamp > this.options.ttl) {
      this.delete(key)
      return false
    }

    return true
  }

  clear(): void {
    this.cache.clear()
    this.totalSize = 0
  }

  /**
   * Remove expired and excess entries
   */
  cleanup(): void {
    const now = Date.now()
    const beforeSize = this.cache.size

    // Remove expired entries
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.options.ttl) {
        this.delete(key)
      }
    }

    // If still over limit, remove oldest entries (LRU-style)
    if (this.cache.size > this.options.maxEntries) {
      const entries = Array.from(this.cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp) // Oldest first

      const toRemove = this.cache.size - this.options.maxEntries
      for (let i = 0; i < toRemove; i++) {
        this.delete(entries[i][0])
      }
    }

    const afterSize = this.cache.size
    if (beforeSize !== afterSize) {
      console.log(`Cache cleanup: ${beforeSize} → ${afterSize} entries (freed ${beforeSize - afterSize})`)
    }
  }

  /**
   * Start periodic cleanup
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup()
    }, this.options.cleanupInterval)

    // Allow Node.js to exit even if timer is running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * Stop periodic cleanup (for graceful shutdown)
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /**
   * Get cache statistics
   */
  stats(): {
    entries: number
    totalSize: number
    maxEntries: number
    maxSize?: number
    utilization: number
  } {
    return {
      entries: this.cache.size,
      totalSize: this.totalSize,
      maxEntries: this.options.maxEntries,
      maxSize: this.options.maxSize,
      utilization: this.cache.size / this.options.maxEntries,
    }
  }
}

/**
 * Create a managed cache with sensible defaults
 */
export function createCache<T>(ttl: number, maxEntries = 1000): ManagedCache<T> {
  return new ManagedCache<T>({ ttl, maxEntries })
}

/**
 * Estimate size of data in bytes (rough approximation)
 */
export function estimateSize(data: unknown): number {
  try {
    return JSON.stringify(data).length * 2 // UTF-16 encoding = 2 bytes per char
  } catch {
    return 0
  }
}
