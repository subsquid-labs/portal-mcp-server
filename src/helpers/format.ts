// ============================================================================
// Result Formatting
// ============================================================================

import { getToolContract } from './tool-ux.js'

const MAX_RESPONSE_LENGTH = 50_000 // 50KB - keeps responses within MCP client context limits

export interface FormatOptions {
  maxItems?: number
  warnOnTruncation?: boolean
  notices?: string[]
  pagination?: Record<string, unknown>
  ordering?: unknown
  freshness?: unknown
  coverage?: unknown
  toolName?: string
  execution?: Record<string, unknown>
  metadata?: {
    network?: string
    dataset?: string
    from_block?: number
    to_block?: number
    query_start_time?: number
  }
}

export interface ResponseMetadata {
  network?: string
  dataset?: string
  queried_blocks?: string
  response_time_ms?: number
  returned?: number
  has_more?: boolean
}

const TRUNCATABLE_ARRAY_KEYS = new Set([
  'items',
  'time_series',
  'ohlc',
  'current_series',
  'previous_series',
  'comparison_series',
  'bucket_deltas',
  'top_contracts',
  'top_programs',
  'programs',
  'volume_by_coin',
  'top_traders_by_volume',
  'top_pnl_winners',
  'top_pnl_losers',
  'recent_outputs',
  'recent_inputs',
  'summary_rows',
])

type TruncatableArrayRef = {
  key: string
  path: string
  values: unknown[]
  replace: (nextValues: unknown[]) => void
}

function buildInferredExecutionMetadata(metadata?: FormatOptions['metadata']) {
  if (!metadata) return undefined

  if (metadata.from_block === undefined && metadata.to_block === undefined) {
    return undefined
  }

  return {
    scan_window: {
      ...(metadata.from_block !== undefined ? { from_block: metadata.from_block } : {}),
      ...(metadata.to_block !== undefined ? { to_block: metadata.to_block } : {}),
    },
  }
}

function mergeExecutionMetadata(
  inferredExecution: Record<string, unknown> | undefined,
  explicitExecution: Record<string, unknown> | undefined,
) {
  if (!inferredExecution && !explicitExecution) {
    return undefined
  }

  const merged = {
    ...(inferredExecution || {}),
    ...(explicitExecution || {}),
  } as Record<string, unknown>

  if (
    inferredExecution?.['scan_window']
    && explicitExecution?.['scan_window']
    && typeof inferredExecution['scan_window'] === 'object'
    && inferredExecution['scan_window'] !== null
    && typeof explicitExecution['scan_window'] === 'object'
    && explicitExecution['scan_window'] !== null
  ) {
    merged.scan_window = {
      ...(inferredExecution['scan_window'] as Record<string, unknown>),
      ...(explicitExecution['scan_window'] as Record<string, unknown>),
    }
  }

  return merged
}

function collectTruncatableArrays(
  value: unknown,
  path = '$',
  results: TruncatableArrayRef[] = [],
): TruncatableArrayRef[] {
  if (!value || typeof value !== 'object') {
    return results
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectTruncatableArrays(entry, `${path}[${index}]`, results))
    return results
  }

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`
    if (Array.isArray(child)) {
      if (TRUNCATABLE_ARRAY_KEYS.has(key) || key.endsWith('_items') || key.endsWith('_series')) {
        results.push({
          key,
          path: childPath,
          values: child,
          replace: (nextValues) => {
            record[key] = nextValues
          },
        })
      }
      child.forEach((entry, index) => collectTruncatableArrays(entry, `${childPath}[${index}]`, results))
      continue
    }

    collectTruncatableArrays(child, childPath, results)
  }

  return results
}

function truncateNestedArraysToFit(
  value: unknown,
  maxLength: number,
): { data: unknown; truncatedPaths: string[]; jsonString?: string } | undefined {
  let working: unknown
  try {
    working = JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }

  const truncatedPaths = new Set<string>()
  let jsonString = JSON.stringify(working, null, 2)
  if (jsonString.length <= maxLength) {
    return { data: working, truncatedPaths: [], jsonString }
  }

  while (jsonString.length > maxLength) {
    const candidates = collectTruncatableArrays(working).filter((candidate) => candidate.values.length > 1)
    if (candidates.length === 0) {
      return undefined
    }

    candidates.sort((left, right) => right.values.length - left.values.length)
    const target = candidates[0]
    const nextLength = Math.max(1, Math.floor(target.values.length / 2))
    if (nextLength >= target.values.length) {
      return undefined
    }

    target.replace(target.values.slice(0, nextLength))
    truncatedPaths.add(target.path)
    jsonString = JSON.stringify(working, null, 2)
  }

  return {
    data: working,
    truncatedPaths: Array.from(truncatedPaths),
    jsonString,
  }
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
  const notices = [...(options?.notices || [])]

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
      const nestedTruncation = truncateNestedArraysToFit(dataToFormat, MAX_RESPONSE_LENGTH)
      if (nestedTruncation) {
        dataToFormat = nestedTruncation.data
        jsonString = nestedTruncation.jsonString ?? JSON.stringify(dataToFormat, null, 2)
        truncated = true
        const pathLabel = nestedTruncation.truncatedPaths.slice(0, 3).join(', ')
        const extraCount = Math.max(0, nestedTruncation.truncatedPaths.length - 3)
        notices.push(
          extraCount > 0
            ? `Large nested arrays were truncated to fit MCP limits (${pathLabel}, +${extraCount} more).`
            : `Large nested arrays were truncated to fit MCP limits (${pathLabel}).`,
        )
      } else {
        return {
          content: [{ type: 'text', text: `Error: Response too large. Add filters or reduce block range.` }],
        }
      }
    }
  }

  if (truncated && (options?.warnOnTruncation ?? true)) {
    notices.push(
      `Results truncated: showing ${Array.isArray(dataToFormat) ? (dataToFormat as unknown[]).length : 0} of ${originalCount} items.`,
    )
  }

  // Attach metadata
  const metadata = options?.metadata
  let responsePayload: unknown = dataToFormat

  if (metadata) {
    const meta: ResponseMetadata = {}
    if (metadata.network) meta.network = metadata.network
    if (metadata.dataset) meta.dataset = metadata.dataset
    if (metadata.from_block !== undefined && metadata.to_block !== undefined) {
      meta.queried_blocks = `${metadata.from_block}-${metadata.to_block}`
    }
    if (metadata.query_start_time) meta.response_time_ms = Date.now() - metadata.query_start_time
    if (Array.isArray(dataToFormat)) {
      meta.returned = (dataToFormat as unknown[]).length
      if (truncated) meta.has_more = true
    }

    if (Array.isArray(dataToFormat)) {
      responsePayload = { items: dataToFormat, _meta: meta }
    } else if (typeof dataToFormat === 'object' && dataToFormat !== null) {
      responsePayload = { ...dataToFormat, _meta: meta }
    } else {
      responsePayload = { value: dataToFormat, _meta: meta }
    }
  } else if (Array.isArray(dataToFormat)) {
    responsePayload = { items: dataToFormat }
  } else if (typeof dataToFormat !== 'object' || dataToFormat === null) {
    responsePayload = { value: dataToFormat }
  }

  if (typeof responsePayload === 'object' && responsePayload !== null) {
    const payloadRecord = responsePayload as Record<string, unknown>
    const toolContract = options?.toolName ? getToolContract(options.toolName) : undefined
    const execution = mergeExecutionMetadata(buildInferredExecutionMetadata(metadata), options?.execution)

    if (message?.trim()) {
      payloadRecord._summary = message.trim()
    }
    if (toolContract) {
      payloadRecord._tool_contract = toolContract
    }
    if (options?.pagination) {
      payloadRecord._pagination = options.pagination
    }
    if (options?.ordering !== undefined) {
      payloadRecord._ordering = options.ordering
    }
    if (options?.freshness !== undefined) {
      payloadRecord._freshness = options.freshness
    }
    if (options?.coverage !== undefined) {
      payloadRecord._coverage = options.coverage
    }
    if (execution) {
      payloadRecord._execution = execution
    }
    if (notices.length === 1) {
      payloadRecord._notice = notices[0]
    } else if (notices.length > 1) {
      payloadRecord._notices = notices
    }
    responsePayload = payloadRecord
  }

  try {
    jsonString = JSON.stringify(responsePayload, null, 2)
  } catch {
    try {
      jsonString = JSON.stringify(responsePayload)
    } catch {
      return {
        content: [{ type: 'text', text: 'Error: Unable to serialize response.' }],
      }
    }
  }

  return { content: [{ type: 'text', text: jsonString }] }
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
