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
  timeout: number = STREAM_TIMEOUT,
  maxBlocks: number = 0,
  maxBytes: number = 50 * 1024 * 1024,
  _retries: number = DEFAULT_RETRIES,
): Promise<unknown[]> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= _retries; attempt++) {
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

    // Stream response line-by-line with early termination
    if (!response.body) {
      // Fallback for environments without ReadableStream
      const text = await response.text()
      return text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    }

    const results: unknown[] = []
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

        // Process complete lines
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)

          if (line) {
            results.push(JSON.parse(line))

            // Early termination: max blocks reached
            if (maxBlocks > 0 && results.length >= maxBlocks) {
              reader.cancel()
              return results
            }
          }
        }

        // Safety: abort if response exceeds maxBytes
        if (totalBytes > maxBytes) {
          reader.cancel()
          throw new Error(
            `Response too large (>${Math.round(maxBytes / 1024 / 1024)}MB). Add filters or reduce block range.`,
          )
        }
      }

      // Process any remaining data in buffer
      const remaining = buffer.trim()
      if (remaining) {
        results.push(JSON.parse(remaining))
      }
    } finally {
      reader.releaseLock()
    }

    return results
  } catch (error) {
    clearTimeout(timeoutId)

    // Check for timeout/abort
    if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('abort'))) {
      throw createTimeoutError(timeout, { url, query: body })
    }

    // Don't retry on client errors
    const errMsg = error instanceof Error ? error.message : String(error)
    if (errMsg.includes('HTTP 4') && !errMsg.includes('409') && !errMsg.includes('429')) {
      throw wrapError(error, { url, query: body })
    }

    lastError = wrapError(error, { url, query: body }) as Error

    if (attempt < _retries) {
      await sleep(Math.pow(2, attempt) * 1000)
    }
  }
  } // end for loop

  throw lastError || new Error('Stream request failed after retries')
}
