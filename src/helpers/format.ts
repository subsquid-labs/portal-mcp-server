// ============================================================================
// Result Formatting
// ============================================================================

const MAX_RESPONSE_LENGTH = 50_000 // 50KB - keeps responses within MCP client context limits

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
  returned?: number
  has_more?: boolean
}

/**
 * Format results as MCP text content with optional metadata and truncation.
 */
export function formatResult(
  data: unknown,
  message?: string,
  options?: FormatOptions,
): { content: Array<{ type: 'text'; text: string }> } {
  const maxItems = options?.maxItems

  let dataToFormat = data
  let truncated = false
  let originalCount = 0

  // Handle array truncation
  if (Array.isArray(data) && maxItems && data.length > maxItems) {
    originalCount = data.length
    dataToFormat = data.slice(0, maxItems)
    truncated = true
  }

  let jsonString: string
  try {
    jsonString = JSON.stringify(dataToFormat, null, 2)
  } catch {
    try {
      jsonString = JSON.stringify(dataToFormat)
    } catch {
      return {
        content: [{ type: 'text', text: 'Error: Unable to serialize response.' }],
      }
    }
  }

  // Truncate if too large
  if (jsonString.length > MAX_RESPONSE_LENGTH) {
    if (Array.isArray(dataToFormat)) {
      const safeCount = Math.floor(((dataToFormat as unknown[]).length * MAX_RESPONSE_LENGTH) / jsonString.length)
      originalCount = originalCount || (dataToFormat as unknown[]).length
      dataToFormat = (dataToFormat as unknown[]).slice(0, Math.max(1, safeCount))
      jsonString = JSON.stringify(dataToFormat, null, 2)
      truncated = true
    } else {
      return {
        content: [{ type: 'text', text: `Error: Response too large. Add filters or reduce block range.` }],
      }
    }
  }

  // Attach metadata
  const metadata = options?.metadata
  if (metadata) {
    const meta: ResponseMetadata = {}
    if (metadata.dataset) meta.dataset = metadata.dataset
    if (metadata.from_block !== undefined && metadata.to_block !== undefined) {
      meta.queried_blocks = `${metadata.from_block}-${metadata.to_block}`
    }
    if (metadata.query_start_time) meta.response_time_ms = Date.now() - metadata.query_start_time
    if (Array.isArray(dataToFormat)) {
      meta.returned = (dataToFormat as unknown[]).length
      if (truncated) meta.has_more = true
    }

    let responseWithMeta: unknown
    if (Array.isArray(dataToFormat)) {
      responseWithMeta = { items: dataToFormat, _meta: meta }
    } else if (typeof dataToFormat === 'object' && dataToFormat !== null) {
      responseWithMeta = { ...dataToFormat, _meta: meta }
    } else {
      responseWithMeta = dataToFormat
    }

    try {
      jsonString = JSON.stringify(responseWithMeta, null, 2)
    } catch {
      // fall through with original jsonString
    }
  }

  let finalMessage = message || ''
  if (truncated && (options?.warnOnTruncation ?? true)) {
    finalMessage += `\n\nResults truncated: showing ${Array.isArray(dataToFormat) ? (dataToFormat as unknown[]).length : 0} of ${originalCount} items.`
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
