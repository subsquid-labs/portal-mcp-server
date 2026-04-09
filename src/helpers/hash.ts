/**
 * Fast 53-bit non-cryptographic hash suitable for compact in-memory dedupe.
 * Collisions are still theoretically possible, but vanishingly unlikely
 * at the cardinalities we handle in Portal MCP summaries.
 */
export function hashString53(value: string, seed: number = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed

  for (let index = 0; index < value.length; index++) {
    const ch = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
