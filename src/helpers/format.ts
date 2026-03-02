// ============================================================================
// Result Formatting
// ============================================================================

const MAX_RESPONSE_LENGTH = 500_000_000 // 500MB - well under Node.js limit
const TRUNCATION_THRESHOLD = 400_000_000 // Start warning at 400MB

export interface FormatOptions {
  maxItems?: number
  warnOnTruncation?: boolean
  metadata?: {
    dataset?: string
    from_block?: number
    to_block?: number
    query_start_time?: number
  }
}

export interface ResponseMetadata {
  dataset?: string
  queried_blocks?: string
  response_time_ms?: number
  total_found?: number
  returned?: number
  has_more?: boolean
  estimated_total?: number
}

/**
 * Safely format results with automatic truncation if response would be too large
 */
export function formatResult(
  data: unknown,
  message?: string,
  options?: FormatOptions,
): { content: Array<{ type: 'text'; text: string }> } {
  const maxItems = options?.maxItems
  const warnOnTruncation = options?.warnOnTruncation ?? true

  let dataToFormat = data
  let truncated = false
  let originalCount = 0

  // Handle array truncation
  if (Array.isArray(data) && maxItems && data.length > maxItems) {
    originalCount = data.length
    dataToFormat = data.slice(0, maxItems)
    truncated = true
  }

  // First try: Format the data
  let jsonString: string
  try {
    jsonString = JSON.stringify(dataToFormat, null, 2)
  } catch (error) {
    // Fallback: Try without pretty-printing
    try {
      jsonString = JSON.stringify(dataToFormat)
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Unable to format response. Data too complex to serialize.`,
          },
        ],
      }
    }
  }

  // Check if response is too large
  const estimatedSize = jsonString.length
  if (estimatedSize > MAX_RESPONSE_LENGTH) {
    // Response would exceed safe limits - truncate more aggressively
    if (Array.isArray(dataToFormat)) {
      const safeCount = Math.floor((dataToFormat.length * MAX_RESPONSE_LENGTH) / estimatedSize)
      originalCount = Array.isArray(data) ? data.length : dataToFormat.length
      dataToFormat = (dataToFormat as unknown[]).slice(0, Math.max(1, safeCount))
      jsonString = JSON.stringify(dataToFormat, null, 2)
      truncated = true
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Response too large (${(estimatedSize / 1_000_000).toFixed(1)}MB). Add filters or reduce block range.`,
          },
        ],
      }
    }
  }

  // Build metadata if provided
  const metadata = options?.metadata
  let responseWithMeta: unknown = dataToFormat

  if (metadata) {
    const meta: ResponseMetadata = {}

    if (metadata.dataset) {
      meta.dataset = metadata.dataset
    }

    if (metadata.from_block !== undefined && metadata.to_block !== undefined) {
      meta.queried_blocks = `${metadata.from_block}-${metadata.to_block}`
    }

    if (metadata.query_start_time) {
      meta.response_time_ms = Date.now() - metadata.query_start_time
    }

    if (Array.isArray(dataToFormat)) {
      meta.total_found = originalCount || dataToFormat.length
      meta.returned = dataToFormat.length

      // Indicate if there are more results (when truncated or hit limit)
      if (truncated || (maxItems && dataToFormat.length >= maxItems)) {
        meta.has_more = true
        if (originalCount > 0) {
          meta.estimated_total = originalCount
        }
      }
    }

    // Wrap data with metadata
    if (Array.isArray(dataToFormat)) {
      responseWithMeta = {
        items: dataToFormat,
        _meta: meta,
      }
    } else if (typeof dataToFormat === 'object' && dataToFormat !== null) {
      responseWithMeta = {
        ...dataToFormat,
        _meta: meta,
      }
    }

    // Re-serialize with metadata
    try {
      jsonString = JSON.stringify(responseWithMeta, null, 2)
    } catch {
      // If serialization fails, fall back to original
      jsonString = JSON.stringify(dataToFormat, null, 2)
    }
  }

  // Build final message
  let finalMessage = message || ''

  if (truncated && warnOnTruncation) {
    const truncatedCount = Array.isArray(dataToFormat) ? dataToFormat.length : 0
    finalMessage += `\n\nWARNING: Results truncated: Showing ${truncatedCount.toLocaleString()} of ${originalCount.toLocaleString()} items.`
    finalMessage += `\nTo get all results: Use smaller block ranges or add more specific filters.`
  }

  if (estimatedSize > TRUNCATION_THRESHOLD && !truncated) {
    finalMessage += `\n\nWARNING: Large response (${(estimatedSize / 1_000_000).toFixed(1)}MB). Consider using more filters or smaller ranges.`
  }

  const text = finalMessage ? `${finalMessage.trim()}\n\n${jsonString}` : jsonString

  return { content: [{ type: 'text', text }] }
}

/**
 * Format result with automatic array truncation
 */
export function formatResultWithLimit(
  data: unknown,
  message: string,
  limit: number,
): { content: Array<{ type: 'text'; text: string }> } {
  return formatResult(data, message, { maxItems: limit, warnOnTruncation: true })
}
