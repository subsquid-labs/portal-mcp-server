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

  // IMPORTANT: If limit is small (<=100), skip block range validation
  // The limit parameter naturally caps the result set, making large ranges safe
  // Example: timeframe="1h" (1800 blocks) with limit=3 only returns 3 records
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
      warning: `Large block range (${blockRange.toLocaleString()} blocks) allowed due to low limit (${limit}). Query is safe because result set is capped.`,
    }
  }

  // Check if query exceeds recommended size
  if (blockRange > recommended) {
    const expectedTime = blockRange > recommended * 5 ? '>10s' : blockRange > recommended * 2 ? '3-10s' : '1-3s'

    return {
      valid: true,
      warning: `Large block range (${blockRange.toLocaleString()} blocks). Expected response time: ${expectedTime}. Recommended: <${recommended.toLocaleString()} blocks for <1s response.`,
      recommendation: hasFilters
        ? `For faster results, reduce block range to <${recommended.toLocaleString()} blocks.`
        : `Add filters (addresses, topics) to significantly improve performance.`,
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
  queryType: 'instructions' | 'token_balances' | 'balances' | 'logs' | 'rewards'
  limit: number
}

/**
 * Solana slots are extremely data-dense compared to EVM blocks.
 * A single Solana slot can contain thousands of instructions.
 * These limits prevent OOM crashes from oversized NDJSON responses.
 */
const SOLANA_MAXIMUM_RANGES = {
  instructions: { filtered: 1000, unfiltered: 10 },
  token_balances: { filtered: 1000, unfiltered: 10 },
  balances: { filtered: 1000, unfiltered: 10 },
  logs: { filtered: 1000, unfiltered: 10 },
  rewards: { filtered: 5000, unfiltered: 100 },
}

export function validateSolanaQuerySize(options: SolanaQueryValidationOptions): QueryValidationResult {
  const { slotRange, hasFilters, queryType, limit } = options
  const maximum = hasFilters ? SOLANA_MAXIMUM_RANGES[queryType].filtered : SOLANA_MAXIMUM_RANGES[queryType].unfiltered

  // Small limit makes large ranges safe
  if (limit <= 100) {
    return { valid: true }
  }

  if (slotRange > maximum) {
    return {
      valid: false,
      error: `Query too large (${slotRange.toLocaleString()} slots${hasFilters ? '' : ' unfiltered'}). ` +
        `Solana slots are data-dense — max safe range is ${maximum.toLocaleString()} slots. ` +
        `Reduce range or add filters (program_id, account, etc.) or set limit <= 100.`,
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
  const recommended = hasFilters ? RECOMMENDED_RANGES[queryType].filtered : RECOMMENDED_RANGES[queryType].unfiltered

  return `WARNING: LARGE RANGE: ${range.toLocaleString()} blocks (${fromBlock} → ${toBlock}).
   For fast responses (<1-3s), use smaller ranges:
   - Logs: <${RECOMMENDED_RANGES.logs[hasFilters ? 'filtered' : 'unfiltered'].toLocaleString()} blocks (~500ms)
   - Transactions: <${RECOMMENDED_RANGES.transactions[hasFilters ? 'filtered' : 'unfiltered'].toLocaleString()} blocks (~100ms)
   - Traces: <${RECOMMENDED_RANGES.traces[hasFilters ? 'filtered' : 'unfiltered'].toLocaleString()} blocks (expensive)
   Large ranges may take >15s or timeout.`
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
