// ============================================================================
// Error Handling with Actionable Messages
// ============================================================================

export class ActionableError extends Error {
  constructor(
    message: string,
    public suggestions: string[],
    public context?: Record<string, unknown>,
  ) {
    // Build the full message including suggestions
    const parts = [message]

    if (suggestions.length > 0) {
      parts.push('\n\nSuggestions:')
      suggestions.forEach((suggestion, i) => {
        parts.push(`  ${i + 1}. ${suggestion}`)
      })
    }

    if (context && Object.keys(context).length > 0) {
      parts.push('\n\nContext:')
      Object.entries(context).forEach(([key, value]) => {
        parts.push(`  ${key}: ${JSON.stringify(value)}`)
      })
    }

    super(parts.join('\n'))
    this.name = 'ActionableError'
  }
}

/**
 * Parse Portal API error and provide actionable suggestions
 */
export function parsePortalError(
  status: number,
  errorText: string,
  context?: { url?: string; query?: unknown },
): ActionableError {
  const suggestions: string[] = []
  let message = `Portal API Error (${status})`

  // 400 Bad Request - Parse detailed error
  if (status === 400) {
    message = `Invalid request: ${errorText}`

    if (errorText.includes('unknown field')) {
      const fieldMatch = errorText.match(/unknown field `(\w+)`/)
      if (fieldMatch) {
        suggestions.push(`Remove the unsupported field '${fieldMatch[1]}' from your query`)
        suggestions.push('Check the Portal API documentation for valid field names')
      }
    }

    if (errorText.includes('missing field')) {
      const fieldMatch = errorText.match(/missing field '(\w+)'/)
      if (fieldMatch) {
        suggestions.push(`Add the required field '${fieldMatch[1]}' to your query`)
      }
    }

    if (errorText.includes('fromBlock')) {
      suggestions.push('Ensure fromBlock is a valid block number (integer)')
      suggestions.push('Use portal_get_head to find the latest block')
    }

    if (errorText.includes('toBlock')) {
      suggestions.push('Ensure toBlock >= fromBlock')
      suggestions.push('Use portal_get_head to find the latest block')
    }

    if (errorText.includes('invalid address')) {
      suggestions.push("Use lowercase hex addresses (e.g., '0xabc...')")
      suggestions.push('Ensure addresses are 42 characters long (0x + 40 hex digits)')
    }

    if (errorText.includes('invalid topic')) {
      suggestions.push("Use 32-byte hex topics (e.g., '0x' + 64 hex digits)")
      suggestions.push('Ensure topic0, topic1, etc. are correctly formatted')
    }

    // Generic 400 suggestions
    if (suggestions.length === 0) {
      suggestions.push('Verify all query parameters are correctly formatted')
      suggestions.push('Check that addresses are lowercase hex strings')
      suggestions.push('Ensure block numbers are valid integers')
    }
  }

  // 404 Not Found
  if (status === 404) {
    message = `Resource not found: ${errorText}`

    if (context?.url && String(context.url).includes('/timestamps/')) {
      // Timestamp-to-block lookup failed — the indexer hasn't caught up
      const tsMatch = String(context.url).match(/\/timestamps\/(\d+)\/block/)
      suggestions.push(
        `Timestamp ${tsMatch?.[1] ?? 'unknown'} is not yet indexed (indexer may lag ~1-2h behind the chain head)`,
      )
      suggestions.push('Use a longer timeframe (e.g., "24h" instead of "1h") or explicit from_block')
      suggestions.push('Use portal_get_head to get the latest block and query by block range')
    } else if (context?.url && String(context.url).includes('/datasets/')) {
      const datasetMatch = String(context.url).match(/\/datasets\/([^/]+)/)
      if (datasetMatch) {
        suggestions.push(`Dataset '${datasetMatch[1]}' not found or not available`)
        suggestions.push('Use portal_list_networks to see available datasets')
        suggestions.push("Use portal_list_networks with query: 'ethereum', 'base', etc. to find datasets by chain name")
      }
    } else {
      suggestions.push('Verify the dataset name is correct')
      suggestions.push('Use portal_list_networks to see all available datasets')
    }
  }

  // 409 Conflict (Chain Reorg)
  if (status === 409) {
    message = 'Chain reorganization detected'
    suggestions.push('Wait a few seconds and retry with the same parameters')
    suggestions.push("Query finalized blocks only (older blocks that won't reorg)")
    suggestions.push('For recent data, use smaller block ranges (< 100 blocks)')
  }

  // 429 Rate Limited
  if (status === 429) {
    const retryAfterMatch = errorText.match(/Retry after (\d+)s/)
    if (retryAfterMatch) {
      message = `Rate limited. Retry after ${retryAfterMatch[1]} seconds`
      suggestions.push(`Wait ${retryAfterMatch[1]} seconds before retrying`)
    } else {
      message = 'Rate limited'
      suggestions.push('Wait a few seconds before retrying')
    }
    suggestions.push('Reduce the frequency of your requests')
    suggestions.push('Use smaller block ranges per query')
    suggestions.push('Consider caching results')
  }

  // 503 Worker unavailable
  if (status === 503) {
    message = `Portal worker temporarily unavailable (503): ${errorText}`
    suggestions.push('IMPORTANT: This is a transient error — retry the same request immediately')
    suggestions.push('Portal workers rotate frequently; the next attempt will likely hit a different worker')
    suggestions.push('If retries fail, try a slightly different block range (e.g., shift by 100 blocks)')
    suggestions.push('Check Portal status at https://status.sqd.dev')
  }

  // Other 5xx Server Errors
  if (status >= 500 && status !== 503) {
    message = `Portal server error (${status}): ${errorText}`
    suggestions.push('This is a Portal API infrastructure issue')
    suggestions.push('Wait a few minutes and retry')
    suggestions.push('Try a different dataset or smaller block range')
    suggestions.push('Check Portal status at https://status.sqd.dev')
  }

  return new ActionableError(message, suggestions, context)
}

/**
 * Create error for timeout
 */
export function createTimeoutError(timeout: number, context?: Record<string, unknown>): ActionableError {
  const suggestions = [
    `Request timed out after ${timeout}ms`,
    'Try reducing the block range (query fewer blocks)',
    'Add more specific filters (addresses, topics) to reduce result size',
    'Split large queries into smaller block-range chunks',
    'Use a lower timeframe or explicit from_block/to_block window',
  ]

  return new ActionableError(`Request timeout after ${timeout}ms`, suggestions, context)
}

/**
 * Create error for block range issues
 */
export function createBlockRangeError(fromBlock: number, toBlock: number, reason: string): ActionableError {
  const range = toBlock - fromBlock + 1
  const suggestions = []

  if (range > 100000) {
    suggestions.push(`Block range is very large (${range.toLocaleString()} blocks)`)
    suggestions.push('Reduce range to < 10,000 blocks for logs queries')
    suggestions.push('Reduce range to < 5,000 blocks for traces queries')
    suggestions.push('Split the request into multiple smaller block ranges')
  } else if (range > 10000) {
    suggestions.push(`Block range (${range.toLocaleString()} blocks) may be slow`)
    suggestions.push('Consider reducing to < 10,000 blocks for better performance')
  }

  if (toBlock < fromBlock) {
    suggestions.push('toBlock must be >= fromBlock')
    suggestions.push(`Current: fromBlock=${fromBlock}, toBlock=${toBlock}`)
  }

  if (fromBlock < 0) {
    suggestions.push('fromBlock must be >= 0')
  }

  return new ActionableError(reason, suggestions, { fromBlock, toBlock, range })
}

/**
 * Create error for empty results with suggestions
 */
export function createEmptyResultError(queryType: string, context: Record<string, unknown>): ActionableError {
  const suggestions = [
    'No data found for the specified query',
    'Try expanding the block range',
    'Check that addresses/topics are correct',
    'Verify the dataset has data for this block range',
    'Use portal_get_head to confirm blocks exist',
  ]

  return new ActionableError(`No ${queryType} found in the specified range`, suggestions, context)
}

/**
 * Create error for invalid dataset
 */
export function createDatasetError(dataset: string, availableCount: number): ActionableError {
  const suggestions = [
    `Dataset '${dataset}' not found`,
    `Use portal_list_networks to see all ${availableCount} available datasets`,
    "Use portal_list_networks with query='ethereum' or query='base' to search by chain name",
    "Common aliases: 'ethereum', 'polygon', 'base', 'arbitrum', 'optimism'",
  ]

  return new ActionableError(`Unknown dataset: '${dataset}'`, suggestions, {
    dataset,
    available_datasets: availableCount,
  })
}

/**
 * Create error for invalid address format
 */
export function createAddressFormatError(address: string): ActionableError {
  const suggestions = []

  if (!address.startsWith('0x')) {
    suggestions.push("Address must start with '0x'")
  }

  if (address.length !== 42) {
    suggestions.push(`Address must be 42 characters (0x + 40 hex digits), got ${address.length}`)
  }

  if (!/^0x[0-9a-fA-F]+$/.test(address)) {
    suggestions.push('Address must contain only hexadecimal characters (0-9, a-f)')
  }

  if (address !== address.toLowerCase()) {
    suggestions.push('Use lowercase addresses for consistency')
    suggestions.push(`Try: ${address.toLowerCase()}`)
  }

  return new ActionableError(`Invalid address format: ${address}`, suggestions, { address })
}

function describeChainType(chainType: string): string {
  switch (chainType) {
    case 'evm':
      return 'EVM'
    case 'solana':
      return 'Solana'
    case 'bitcoin':
      return 'Bitcoin'
    case 'substrate':
      return 'Substrate'
    case 'hyperliquidFills':
      return 'Hyperliquid fills'
    case 'hyperliquidReplicaCmds':
      return 'Hyperliquid replica'
    default:
      return chainType
  }
}

export function createUnsupportedChainError(params: {
  toolName: string
  dataset: string
  actualChainType: string
  supportedChains: string[]
  suggestions?: string[]
  context?: Record<string, unknown>
}): ActionableError {
  const { toolName, dataset, actualChainType, supportedChains, suggestions = [], context } = params
  const supported = supportedChains.map((chain) => describeChainType(chain)).join(', ')

  return new ActionableError(
    `${toolName} does not support dataset '${dataset}' because it is a ${describeChainType(actualChainType)} dataset. Supported chain types: ${supported}.`,
    suggestions,
    {
      dataset,
      actual_chain_type: actualChainType,
      supported_chains: supportedChains,
      ...context,
    },
  )
}

export function createUnsupportedMetricError(params: {
  toolName: string
  metric: string
  dataset: string
  supportedMetrics: string[]
  reason?: string
  suggestions?: string[]
}): ActionableError {
  const { toolName, metric, dataset, supportedMetrics, reason, suggestions = [] } = params
  return new ActionableError(
    `${toolName} does not support metric '${metric}' for dataset '${dataset}'.${reason ? ` ${reason}` : ''}`,
    suggestions.length > 0
      ? suggestions
      : [`Use one of the supported metrics instead: ${supportedMetrics.join(', ')}.`],
    {
      dataset,
      metric,
      supported_metrics: supportedMetrics,
    },
  )
}

/**
 * Wrap any error with actionable context
 */
export function wrapError(error: unknown, context?: Record<string, unknown>): Error {
  if (error instanceof ActionableError) {
    return error
  }

  if (error instanceof Error) {
    // Check if it's a Portal API error we can parse
    const httpMatch = error.message.match(/HTTP (\d+): (.+)/)
    if (httpMatch) {
      const status = parseInt(httpMatch[1], 10)
      const errorText = httpMatch[2]
      return parsePortalError(status, errorText, context)
    }

    // Check for timeout
    if (error.message.includes('abort')) {
      return createTimeoutError(60000, context)
    }

    // Generic error - add context if provided
    if (context) {
      const suggestions = ['Review the error details and query parameters below']
      return new ActionableError(error.message, suggestions, context)
    }

    return error
  }

  return new Error(String(error))
}
