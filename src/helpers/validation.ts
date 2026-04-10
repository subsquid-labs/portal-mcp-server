import type { ChainType } from '../types/index.js'

// ============================================================================
// Address Validation
// ============================================================================

export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
}

export function normalizeEvmAddress(address: string): string {
  if (!address.startsWith('0x')) {
    address = '0x' + address
  }
  return address.toLowerCase()
}

export function normalizeAddresses(addresses: string[] | undefined, chainType: ChainType): string[] | undefined {
  if (!addresses || addresses.length === 0) return undefined

  return addresses.map((addr) => {
    if (chainType === 'evm') {
      if (!isValidEvmAddress(addr)) {
        throw new Error(`Invalid EVM address: ${addr}`)
      }
      return normalizeEvmAddress(addr)
    } else if (chainType === 'solana') {
      if (!isValidSolanaAddress(addr)) {
        throw new Error(`Invalid Solana address: ${addr}`)
      }
      return addr
    }
    return addr
  })
}

// ============================================================================
// Query Size Validation
// ============================================================================

export interface QueryValidationOptions {
  blockRange: number
  hasFilters: boolean
  queryType: 'logs' | 'transactions' | 'traces' | 'state_diffs'
  limit: number
}

export interface QueryValidationResult {
  valid: boolean
  warning?: string
  error?: string
  recommendation?: string
}

export function getValidationNotices(validation: QueryValidationResult): string[] {
  const notices: string[] = []
  if (validation.warning) notices.push(validation.warning)
  if (validation.recommendation) notices.push(validation.recommendation)
  return notices
}

/**
 * Recommended block ranges for different query types to maintain good UX (<1-3s response)
 */
const RECOMMENDED_RANGES = {
  logs: {
    filtered: 10000, // <1s
    unfiltered: 100, // Avoid crashes - reduced from 500
  },
  transactions: {
    filtered: 5000, // <1s
    unfiltered: 100, // Avoid crashes - reduced from 500
  },
  traces: {
    filtered: 1000, // Traces are expensive
    unfiltered: 50, // Very expensive - reduced from 100
  },
  state_diffs: {
    filtered: 5000,
    unfiltered: 100, // Reduced from 1000
  },
}

/**
 * Absolute maximum ranges before we reject the query to prevent crashes
 * These are HARD LIMITS - queries exceeding these will be rejected
 */
const MAXIMUM_RANGES = {
  logs: {
    filtered: 50000, // Reduced from 100k to prevent memory issues
    unfiltered: 500, // Reduced from 1000 - hard limit to prevent Node.js crash
  },
  transactions: {
    filtered: 20000, // Reduced from 50k to prevent memory issues
    unfiltered: 500, // Reduced from 1000 - hard limit to prevent Node.js crash
  },
  traces: {
    filtered: 5000, // Reduced from 10k - traces are very expensive
    unfiltered: 100, // Reduced from 500
  },
  state_diffs: {
    filtered: 20000, // Reduced from 50k
    unfiltered: 1000, // Reduced from 5000
  },
}

/**
 * Validate query parameters to prevent crashes and slow queries
 */
export function validateQuerySize(options: QueryValidationOptions): QueryValidationResult {
  const { blockRange, hasFilters, queryType, limit } = options

  const recommended = hasFilters ? RECOMMENDED_RANGES[queryType].filtered : RECOMMENDED_RANGES[queryType].unfiltered

  const maximum = hasFilters ? MAXIMUM_RANGES[queryType].filtered : MAXIMUM_RANGES[queryType].unfiltered

  // Low limit bypass: allow large block ranges when the user only wants a few results.
  // The streaming layer (maxBlocks/maxBytes in portalFetchStream) is the safety net
  // that prevents V8 crashes — validation doesn't need to duplicate that protection.
  const hasLowLimit = limit <= 100

  // Check if query exceeds absolute maximum
  if (blockRange > maximum && !hasLowLimit) {
    let errorMessage: string
    let recommendation: string

    if (!hasFilters) {
      // Unfiltered query - provide filter examples
      errorMessage = `Query too large (${blockRange.toLocaleString()} blocks unfiltered).

WARNING: Unfiltered queries over ${RECOMMENDED_RANGES[queryType].unfiltered.toLocaleString()} blocks can crash due to Node.js memory limits.

SOLUTION: Add filters to query specific data:`

      if (queryType === 'transactions') {
        errorMessage += `
   - from_addresses: ["0x123..."] - Track specific wallet
   - to_addresses: ["0x456..."] - Monitor contract interactions
   - sighash: ["0x12345678"] - Filter by function calls`
      } else if (queryType === 'logs') {
        errorMessage += `
   - addresses: ["0x123..."] - Events from specific contract
   - topic0: ["0x123..."] - Specific event signatures
   - topic1/2/3: ["0x456..."] - Filter by indexed parameters`
      }

      errorMessage += `

ALTERNATIVE: Reduce range to <${maximum.toLocaleString()} blocks`

      recommendation = `Example: Add 'from_addresses: ["0xYourWallet"]' to track a specific address, or reduce to last ${RECOMMENDED_RANGES[queryType].unfiltered.toLocaleString()} blocks.`
    } else {
      // Filtered query - just too large
      errorMessage = `Query too large (${blockRange.toLocaleString()} blocks).

Even with filters, this exceeds the maximum safe range of ${maximum.toLocaleString()} blocks.

📉 Reduce block range to <${maximum.toLocaleString()} blocks`

      recommendation = `Split into multiple queries of ${recommended.toLocaleString()} blocks each, or use a smaller time window.`
    }

    return {
      valid: false,
      error: errorMessage,
      recommendation,
    }
  }

  // If low limit bypassed the maximum check, add informational note
  if (hasLowLimit && blockRange > maximum && blockRange > recommended) {
    return {
      valid: true,
      warning: `Scanning ${blockRange.toLocaleString()} blocks. This is allowed because limit=${limit} caps the result size.`,
      recommendation: 'If you want a faster scan, add filters or use a shorter time window.',
    }
  }

  // Check if query exceeds recommended size
  if (blockRange > recommended) {
    const expectedTime = blockRange > recommended * 5 ? '>10s' : blockRange > recommended * 2 ? '3-10s' : '1-3s'

    return {
      valid: true,
      warning: `Scanning ${blockRange.toLocaleString()} blocks. This may take ${expectedTime} on busy chains.`,
      recommendation: hasFilters
        ? `For faster results, keep ${queryType} queries under about ${recommended.toLocaleString()} blocks.`
        : `For faster results, add filters (addresses, topics) or keep the range under about ${recommended.toLocaleString()} blocks.`,
    }
  }

  // Check limit parameter
  if (limit > 10000) {
    return {
      valid: true,
      warning: `Large limit (${limit}). Response may be very large. Consider using limit <5000 or pagination.`,
    }
  }

  return { valid: true }
}

// ============================================================================
// Solana Query Size Validation
// ============================================================================

export interface SolanaQueryValidationOptions {
  slotRange: number
  hasFilters: boolean
  queryType: 'transactions' | 'instructions' | 'token_balances' | 'balances' | 'logs' | 'rewards'
  limit: number
}

/**
 * Solana slots are extremely data-dense compared to EVM blocks.
 * A single Solana slot can contain thousands of instructions.
 * These limits prevent OOM crashes from oversized NDJSON responses.
 */
const SOLANA_MAXIMUM_RANGES = {
  transactions: { filtered: 1000, unfiltered: 25 },
  instructions: { filtered: 1000, unfiltered: 10 },
  token_balances: { filtered: 1000, unfiltered: 10 },
  balances: { filtered: 1000, unfiltered: 10 },
  logs: { filtered: 1000, unfiltered: 10 },
  rewards: { filtered: 5000, unfiltered: 100 },
}

export function validateSolanaQuerySize(options: SolanaQueryValidationOptions): QueryValidationResult {
  const { slotRange, hasFilters, queryType, limit } = options
  const maximum = hasFilters ? SOLANA_MAXIMUM_RANGES[queryType].filtered : SOLANA_MAXIMUM_RANGES[queryType].unfiltered

  if (slotRange > maximum) {
    return {
      valid: false,
      error: `Query too large (${slotRange.toLocaleString()} slots${hasFilters ? '' : ' unfiltered'}). ` +
        `Solana slots are data-dense — max safe range is ${maximum.toLocaleString()} slots. ` +
        `Reduce range or add filters (program_id, account, etc.).`,
    }
  }

  if (limit <= 100 && slotRange > Math.max(5, Math.floor(maximum / 2))) {
    return {
      valid: true,
      warning: `Large Solana range (${slotRange.toLocaleString()} slots). Results are capped by limit=${limit}, but the query may still be heavy.`,
    }
  }

  return { valid: true }
}

// ============================================================================
// Substrate Query Size Validation
// ============================================================================

export interface SubstrateQueryValidationOptions {
  blockRange: number
  hasFilters: boolean
  queryType: 'events' | 'calls'
  limit: number
}

const SUBSTRATE_RECOMMENDED_RANGES = {
  events: { filtered: 5000, unfiltered: 500 },
  calls: { filtered: 5000, unfiltered: 500 },
}

const SUBSTRATE_MAXIMUM_RANGES = {
  events: { filtered: 20000, unfiltered: 2000 },
  calls: { filtered: 20000, unfiltered: 2000 },
}

export function validateSubstrateQuerySize(options: SubstrateQueryValidationOptions): QueryValidationResult {
  const { blockRange, hasFilters, queryType, limit } = options
  const recommended = hasFilters ? SUBSTRATE_RECOMMENDED_RANGES[queryType].filtered : SUBSTRATE_RECOMMENDED_RANGES[queryType].unfiltered
  const maximum = hasFilters ? SUBSTRATE_MAXIMUM_RANGES[queryType].filtered : SUBSTRATE_MAXIMUM_RANGES[queryType].unfiltered
  const hasLowLimit = limit <= 100

  if (blockRange > maximum && !hasLowLimit) {
    return {
      valid: false,
      error: `Query too large (${blockRange.toLocaleString()} blocks${hasFilters ? '' : ' unfiltered'}). ` +
        `Substrate ${queryType} queries should stay under ${maximum.toLocaleString()} blocks for safe MCP-sized responses.`,
      recommendation: hasFilters
        ? `Split the request into smaller windows of about ${recommended.toLocaleString()} blocks each.`
        : `Add name filters or reduce the range to about ${recommended.toLocaleString()} blocks.`,
    }
  }

  if (hasLowLimit && blockRange > maximum && blockRange > recommended) {
    return {
      valid: true,
      warning: `Scanning ${blockRange.toLocaleString()} blocks. This is allowed because limit=${limit} caps the number of returned rows.`,
      recommendation: 'If you want a faster scan, add event/call name filters or use a shorter time window.',
    }
  }

  if (blockRange > recommended) {
    return {
      valid: true,
      warning: `Scanning ${blockRange.toLocaleString()} blocks. This may be slower on event-heavy Substrate windows.`,
      recommendation: hasFilters
        ? `For a snappier response, keep filtered Substrate ${queryType} queries under about ${recommended.toLocaleString()} blocks.`
        : `For a snappier response, add filters or keep the range under about ${recommended.toLocaleString()} blocks.`,
    }
  }

  return { valid: true }
}

/**
 * Format block range validation warning for user display
 */
export function formatBlockRangeWarning(
  fromBlock: number,
  toBlock: number,
  queryType: 'logs' | 'transactions' | 'traces' | 'state_diffs',
  hasFilters: boolean,
): string {
  const range = toBlock - fromBlock

  return `Scanning ${range.toLocaleString()} ${queryType} blocks (${fromBlock} → ${toBlock}). ${hasFilters ? 'Filters help keep this query manageable.' : 'Add filters or reduce the range if you want faster results.'}`
}

/**
 * Generate helpful query examples based on common use cases
 */
export function getQueryExamples(queryType: 'logs' | 'transactions'): string {
  if (queryType === 'transactions') {
    return `
📚 Example Queries:

1. Track wallet activity (last 24h):
   from_addresses: ["0xYourWallet"]
   from_block: currentBlock - 7200  // ~24h on most chains
   limit: 100

2. Monitor contract interactions:
   to_addresses: ["0xContractAddress"]
   from_block: currentBlock - 5000
   limit: 100

3. Find function calls:
   sighash: ["0x095ea7b3"]  // approve() function
   from_block: currentBlock - 1000
   limit: 50`
  } else {
    return `
📚 Example Queries:

1. Track token transfers:
   addresses: ["0xUSDCAddress"]
   topic0: ["0xddf252ad..."]  // Transfer event
   from_block: currentBlock - 10000
   limit: 100

2. Monitor contract events:
   addresses: ["0xContractAddress"]
   from_block: currentBlock - 5000
   limit: 100

3. Filter by indexed parameter:
   addresses: ["0xContractAddress"]
   topic1: ["0x000...YourAddress"]  // Events involving your address
   from_block: currentBlock - 1000
   limit: 50`
  }
}
