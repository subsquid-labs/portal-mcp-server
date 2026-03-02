import { DEFAULT_RETRIES, DEFAULT_TIMEOUT, STREAM_TIMEOUT } from '../constants/index.js'
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

export async function portalFetchStream(
  url: string,
  body: unknown,
  timeout: number = STREAM_TIMEOUT,
): Promise<unknown[]> {
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

    if (response.status === 204) {
      return []
    }

    if (response.status === 409) {
      throw new Error(
        'Chain reorganization detected (409 Conflict). The requested block range may have been affected by a reorg. Try with a different fromBlock or use finalized blocks.',
      )
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After')
      throw new Error(
        `Rate limited (429). ${retryAfter ? `Retry after ${retryAfter}s.` : 'Please wait before retrying.'}`,
      )
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw parsePortalError(response.status, errorText, { url, query: body })
    }

    const text = await response.text()
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
  } catch (error) {
    clearTimeout(timeoutId)

    // Check for timeout/abort
    if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('abort'))) {
      throw createTimeoutError(timeout, { url, query: body })
    }

    throw wrapError(error, { url, query: body })
  }
}
