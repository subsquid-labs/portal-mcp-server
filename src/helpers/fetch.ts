import { DEFAULT_RETRIES, DEFAULT_TIMEOUT, STREAM_TIMEOUT } from '../constants/index.js'
import { portalRequestsTotal } from '../metrics.js'
import { createTimeoutError, parsePortalError, wrapError } from './errors.js'

// ============================================================================
// Portal API Wrapper Functions
// ============================================================================
//
// These functions call the SQD Portal API at https://portal.sqd.dev
//
// Portal API Documentation:
// - EVM API: /Users/account/sqd-docs-1/en/api/evm/openapi.yaml
// - Solana API: /Users/account/sqd-docs-1/en/api/solana/openapi.yaml
//
// All queries use POST /datasets/{dataset}/stream with:
// - Request body: { type: "evm"|"solana", fromBlock, toBlock, logs: [...], fields: {...} }
// - Response: NDJSON stream (newline-delimited JSON)
//
// See CLAUDE.md for full architecture documentation.
// ============================================================================

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface StreamStopAfterItems {
  keys: string[]
  limit: number
}

export interface PortalFetchStreamOptions {
  timeout?: number
  maxBlocks?: number
  maxBytes?: number
  retries?: number
  stopAfterItems?: StreamStopAfterItems
}

export interface PortalFetchStreamVisitOptions extends PortalFetchStreamOptions {
  onRecord: (record: unknown) => void | Promise<void>
}

export interface PortalFetchStreamRangeOptions extends PortalFetchStreamOptions {
  getBlockNumber?: (record: unknown) => number | undefined
}

function normalizePortalFetchStreamOptions(
  timeoutOrOptions: number | PortalFetchStreamOptions,
  maxBlocks: number,
  maxBytes: number,
  retries: number,
) {
  if (typeof timeoutOrOptions === 'object') {
    return {
      timeout: timeoutOrOptions.timeout ?? STREAM_TIMEOUT,
      maxBlocks: timeoutOrOptions.maxBlocks ?? 0,
      maxBytes: timeoutOrOptions.maxBytes ?? 50 * 1024 * 1024,
      retries: timeoutOrOptions.retries ?? DEFAULT_RETRIES,
      stopAfterItems: timeoutOrOptions.stopAfterItems,
    }
  }

  return {
    timeout: timeoutOrOptions,
    maxBlocks,
    maxBytes,
    retries,
    stopAfterItems: undefined,
  }
}

function countMatchingItems(record: unknown, stopAfterItems?: StreamStopAfterItems): number {
  if (!stopAfterItems || stopAfterItems.limit <= 0 || !record || typeof record !== 'object') {
    return 0
  }

  let total = 0
  for (const key of stopAfterItems.keys) {
    const value = (record as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      total += value.length
    }
  }

  return total
}

function parseBlockNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

export function getRecordBlockNumber(record: unknown): number | undefined {
  if (!record || typeof record !== 'object') {
    return undefined
  }

  const typedRecord = record as {
    number?: unknown
    header?: {
      number?: unknown
    }
  }

  return parseBlockNumber(typedRecord.number) ?? parseBlockNumber(typedRecord.header?.number)
}

export async function portalFetch<T>(
  url: string,
  options: {
    method?: string
    body?: unknown
    timeout?: number
    retries?: number
  } = {},
): Promise<T> {
  const { method = 'GET', body, timeout = DEFAULT_TIMEOUT, retries = DEFAULT_RETRIES } = options

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Accept-Encoding': 'gzip',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: controller.signal,
      }

      if (body) {
        fetchOptions.body = JSON.stringify(body)
      }

      const response = await fetch(url, fetchOptions)
      clearTimeout(timeoutId)

      portalRequestsTotal.inc({ method, status_code: response.status })

      // Handle specific status codes
      if (response.status === 204) {
        return [] as T
      }

      if (response.status === 409) {
        // Reorg detected - retry with backoff
        lastError = new Error(
          'Chain reorganization detected (409 Conflict). The requested block range may have been affected by a reorg. Try with a different fromBlock or use finalized blocks.',
        )
        const delay = Math.pow(2, attempt) * 1000
        await sleep(delay)
        continue
      }

      if (response.status === 429) {
        // Rate limited - check Retry-After header
        const retryAfter = response.headers.get('Retry-After')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * 1000
        lastError = new Error(
          `Rate limited (429). ${retryAfter ? `Retry after ${retryAfter}s.` : `Retrying in ${delay}ms.`}`,
        )
        await sleep(delay)
        continue
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw parsePortalError(response.status, errorText, { url, query: body })
      }

      return (await response.json()) as T
    } catch (error) {
      clearTimeout(timeoutId)

      // Check for timeout/abort
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('abort'))) {
        throw createTimeoutError(timeout, { url, attempt: attempt + 1, max_attempts: retries + 1 })
      }

      lastError = wrapError(error, { url, attempt: attempt + 1, max_attempts: retries + 1 }) as Error

      // Don't retry on client errors (except 409/429 handled above)
      if (lastError.message.includes('HTTP 4')) {
        throw lastError
      }

      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000
        await sleep(delay)
      }
    }
  }

  throw lastError || new Error('Request failed after retries')
}

/**
 * Stream Portal API results with early termination.
 *
 * maxBlocks: stop reading after this many NDJSON lines (each line = one block).
 * Default 0 = no limit (reads entire response).
 *
 * maxBytes: stop reading after accumulating this many bytes of raw text.
 * Prevents V8 string-length crashes on unexpectedly large responses.
 * Default 50MB.
 */
export async function portalFetchStream(
  url: string,
  body: unknown,
  timeoutOrOptions: number | PortalFetchStreamOptions = STREAM_TIMEOUT,
  maxBlocks: number = 0,
  maxBytes: number = 50 * 1024 * 1024,
  _retries: number = DEFAULT_RETRIES,
): Promise<unknown[]> {
  const options = normalizePortalFetchStreamOptions(timeoutOrOptions, maxBlocks, maxBytes, _retries)
  const { timeout, stopAfterItems } = options
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      portalRequestsTotal.inc({ method: 'POST', status_code: response.status })

      if (response.status === 204) {
        return []
      }

      if (response.status === 409) {
        lastError = new Error(
          'Chain reorganization detected (409 Conflict). The requested block range may have been affected by a reorg. Try with a different fromBlock or use finalized blocks.',
        )
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * 1000
        lastError = new Error(
          `Rate limited (429). ${retryAfter ? `Retry after ${retryAfter}s.` : 'Please wait before retrying.'}`,
        )
        await sleep(delay)
        continue
      }

      if (response.status === 503) {
        lastError = parsePortalError(503, await response.text(), { url, query: body })
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw parsePortalError(response.status, errorText, { url, query: body })
      }

      // Fallback for environments without ReadableStream
      if (!response.body) {
        const results: unknown[] = []
        let matchedItems = 0
        const text = await response.text()

        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const parsed = JSON.parse(trimmed)
          results.push(parsed)
          matchedItems += countMatchingItems(parsed, stopAfterItems)

          if (options.maxBlocks > 0 && results.length >= options.maxBlocks) {
            return results
          }
          if (stopAfterItems && matchedItems >= stopAfterItems.limit) {
            return results
          }
        }

        return results
      }

      const results: unknown[] = []
      let buffer = ''
      let totalBytes = 0
      let matchedItems = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          totalBytes += chunk.length
          buffer += chunk

          let newlineIdx: number
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim()
            buffer = buffer.slice(newlineIdx + 1)

            if (!line) continue

            const parsed = JSON.parse(line)
            results.push(parsed)
            matchedItems += countMatchingItems(parsed, stopAfterItems)

            if (options.maxBlocks > 0 && results.length >= options.maxBlocks) {
              await reader.cancel()
              return results
            }

            if (stopAfterItems && matchedItems >= stopAfterItems.limit) {
              await reader.cancel()
              return results
            }
          }

          if (totalBytes > options.maxBytes) {
            await reader.cancel()
            throw new Error(
              `Response too large (>${Math.round(options.maxBytes / 1024 / 1024)}MB). Add filters or reduce block range.`,
            )
          }
        }

        const remaining = buffer.trim()
        if (remaining) {
          const parsed = JSON.parse(remaining)
          results.push(parsed)
          matchedItems += countMatchingItems(parsed, stopAfterItems)

          if (stopAfterItems && matchedItems >= stopAfterItems.limit) {
            return results
          }
        }
      } finally {
        reader.releaseLock()
      }

      return results
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('abort'))) {
        throw createTimeoutError(timeout, { url, query: body })
      }

      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes('HTTP 4') && !errMsg.includes('409') && !errMsg.includes('429')) {
        throw wrapError(error, { url, query: body })
      }

      lastError = wrapError(error, { url, query: body }) as Error

      if (attempt < options.retries) {
        await sleep(Math.pow(2, attempt) * 1000)
      }
    }
  } // end for loop

  throw lastError || new Error('Stream request failed after retries')
}

/**
 * Stream Portal API results and process each NDJSON record incrementally
 * without materializing the full response in memory.
 *
 * Returns the number of processed NDJSON records.
 */
export async function portalFetchStreamVisit(
  url: string,
  body: unknown,
  options: PortalFetchStreamVisitOptions,
): Promise<number> {
  const normalizedOptions = normalizePortalFetchStreamOptions(options, 0, 50 * 1024 * 1024, DEFAULT_RETRIES)
  const { timeout, stopAfterItems } = normalizedOptions
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= normalizedOptions.retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      portalRequestsTotal.inc({ method: 'POST', status_code: response.status })

      if (response.status === 204) {
        return 0
      }

      if (response.status === 409) {
        lastError = new Error(
          'Chain reorganization detected (409 Conflict). The requested block range may have been affected by a reorg. Try with a different fromBlock or use finalized blocks.',
        )
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * 1000
        lastError = new Error(
          `Rate limited (429). ${retryAfter ? `Retry after ${retryAfter}s.` : 'Please wait before retrying.'}`,
        )
        await sleep(delay)
        continue
      }

      if (response.status === 503) {
        lastError = parsePortalError(503, await response.text(), { url, query: body })
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw parsePortalError(response.status, errorText, { url, query: body })
      }

      let processedRecords = 0
      let matchedItems = 0

      if (!response.body) {
        const text = await response.text()

        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const parsed = JSON.parse(trimmed)
          processedRecords++
          matchedItems += countMatchingItems(parsed, stopAfterItems)
          await options.onRecord(parsed)

          if (normalizedOptions.maxBlocks > 0 && processedRecords >= normalizedOptions.maxBlocks) {
            return processedRecords
          }
          if (stopAfterItems && matchedItems >= stopAfterItems.limit) {
            return processedRecords
          }
        }

        return processedRecords
      }

      let buffer = ''
      let totalBytes = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          totalBytes += chunk.length
          buffer += chunk

          let newlineIdx: number
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim()
            buffer = buffer.slice(newlineIdx + 1)

            if (!line) continue

            const parsed = JSON.parse(line)
            processedRecords++
            matchedItems += countMatchingItems(parsed, stopAfterItems)
            await options.onRecord(parsed)

            if (normalizedOptions.maxBlocks > 0 && processedRecords >= normalizedOptions.maxBlocks) {
              await reader.cancel()
              return processedRecords
            }

            if (stopAfterItems && matchedItems >= stopAfterItems.limit) {
              await reader.cancel()
              return processedRecords
            }
          }

          if (totalBytes > normalizedOptions.maxBytes) {
            await reader.cancel()
            throw new Error(
              `Response too large (>${Math.round(normalizedOptions.maxBytes / 1024 / 1024)}MB). Add filters or reduce block range.`,
            )
          }
        }

        const remaining = buffer.trim()
        if (remaining) {
          const parsed = JSON.parse(remaining)
          processedRecords++
          matchedItems += countMatchingItems(parsed, stopAfterItems)
          await options.onRecord(parsed)
        }
      } finally {
        reader.releaseLock()
      }

      return processedRecords
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('abort'))) {
        throw createTimeoutError(timeout, { url, query: body })
      }

      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes('HTTP 4') && !errMsg.includes('409') && !errMsg.includes('429')) {
        throw wrapError(error, { url, query: body })
      }

      lastError = wrapError(error, { url, query: body }) as Error

      if (attempt < normalizedOptions.retries) {
        await sleep(Math.pow(2, attempt) * 1000)
      }
    }
  }

  throw lastError || new Error('Stream request failed after retries')
}

/**
 * Fetch a block range and keep paging forward if Portal returns only a partial
 * contiguous subrange with 200 OK.
 */
export async function portalFetchStreamRange(
  url: string,
  body: unknown,
  options: PortalFetchStreamRangeOptions = {},
): Promise<unknown[]> {
  if (!body || typeof body !== 'object') {
    return portalFetchStream(url, body, options)
  }

  const typedBody = body as Record<string, unknown>
  const requestedFrom = parseBlockNumber(typedBody.fromBlock)
  const requestedTo = parseBlockNumber(typedBody.toBlock)

  if (requestedFrom === undefined || requestedTo === undefined || requestedFrom > requestedTo) {
    return portalFetchStream(url, body, options)
  }

  const getBlockNumber = options.getBlockNumber ?? getRecordBlockNumber
  const results: unknown[] = []
  const stopAfterLimit = options.stopAfterItems?.limit ?? 0
  let matchedItems = 0
  let currentFrom = requestedFrom
  let remainingBlockBudget = options.maxBlocks ?? 0

  while (currentFrom <= requestedTo) {
    const stopAfterItems =
      options.stopAfterItems && stopAfterLimit > 0
        ? {
            ...options.stopAfterItems,
            limit: Math.max(1, stopAfterLimit - matchedItems),
          }
        : undefined

    const chunk = await portalFetchStream(
      url,
      {
        ...typedBody,
        fromBlock: currentFrom,
        toBlock: requestedTo,
      },
      {
        ...options,
        maxBlocks: remainingBlockBudget > 0 ? remainingBlockBudget : 0,
        stopAfterItems,
      },
    )

    if (chunk.length === 0) {
      break
    }

    results.push(...chunk)
    matchedItems += chunk.reduce<number>(
      (sum, record) => sum + countMatchingItems(record, options.stopAfterItems),
      0,
    )

    if (stopAfterLimit > 0 && matchedItems >= stopAfterLimit) {
      break
    }

    if (remainingBlockBudget > 0) {
      remainingBlockBudget = Math.max(0, remainingBlockBudget - chunk.length)
      if (remainingBlockBudget === 0) {
        break
      }
    }

    const lastReturnedBlock = getBlockNumber(chunk[chunk.length - 1])
    if (lastReturnedBlock === undefined || lastReturnedBlock < currentFrom) {
      break
    }

    if (lastReturnedBlock >= requestedTo) {
      break
    }

    currentFrom = lastReturnedBlock + 1
  }

  return results
}
