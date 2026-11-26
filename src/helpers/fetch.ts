import { Buffer } from 'node:buffer'

import { DEFAULT_RETRIES, DEFAULT_TIMEOUT, STREAM_TIMEOUT } from '../constants/index.js'
import { portalRequestsTotal, portalRetriesTotal } from '../metrics.js'
import { type UpstreamSpan, startUpstreamSpan } from '../tracing.js'
import { portalAdmission } from './admission.js'
import { ActionableError, RequestCancelledError, createTimeoutError, parsePortalError, wrapError } from './errors.js'
import { applyGuardrail } from './guardrails.js'
import { reportPortalProgress } from './progress.js'
import {
  type RequestAbortContext,
  createRequestAbortContext,
  getPortalRequestDeadlineAt,
  getPortalRequestSignal,
  isAbortLike,
  runWhilePortalBackoffSleep,
  withPortalFetchAdmissionTracking,
} from './request-context.js'
import { PortalStreamError, StreamDelivery } from './stream-progress.js'

// ============================================================================

export const INITIAL_RETRY_DELAY_MS = 1_000
export const MAX_RETRY_DELAY_MS = 10_000
export const MAX_RETRY_WALL_CLOCK_MS = 18_000
export const MAX_SHARED_COOLDOWN_MS = 10_000
export const OVERLOAD_RETRIES = 10
export const OVERLOAD_INITIAL_RETRY_DELAY_MS = 150
export const OVERLOAD_MAX_RETRY_DELAY_MS = 500
const MIN_RETRY_ATTEMPT_WINDOW_MS = 1_000
const MAX_ERROR_BODY_BYTES = 4_000
const MAX_TRACKED_RATE_LIMIT_BUCKETS = 256

type PortalRetryReason =
  | 'rate_limited'
  | 'overloaded'
  | 'admission_overloaded'
  | 'server_error'
  | 'conflict'
  | 'timeout'
  | 'network_error'
  | 'stream_error'

type OriginRateLimitState = {
  cooldownUntil: number
  streak: number
  lastRateLimitAt: number
}

const rateLimitBuckets = new Map<string, OriginRateLimitState>()

/**
 * Scope shared rate-limit cooldowns by origin, dataset, and endpoint class so
 * stream overloads on one dataset do not stall `/head`, `/metadata`, `/datasets`,
 * or unrelated datasets.
 */
export function rateLimitBucketKey(url: string): string {
  try {
    const parsed = new URL(url)
    const datasetMatch = parsed.pathname.match(/^\/datasets\/([^/]+)\/([^/]+)/)
    if (datasetMatch) {
      const dataset = datasetMatch[1]
      const segment = datasetMatch[2]
      if (segment === 'stream') return `${parsed.origin}/datasets/${dataset}/stream`
      if (segment === 'timestamps') return `${parsed.origin}/datasets/${dataset}/timestamps`
      return `${parsed.origin}/datasets/${dataset}/meta`
    }
    if (parsed.pathname === '/datasets' || parsed.pathname === '/datasets/') {
      return `${parsed.origin}/datasets`
    }
    return parsed.origin
  } catch {
    return url
  }
}

export function resetPortalRateLimitState(): void {
  rateLimitBuckets.clear()
}

export function getOriginCooldownRemainingMs(url: string, now = Date.now()): number {
  const state = rateLimitBuckets.get(rateLimitBucketKey(url))
  if (!state) return 0
  return Math.max(0, state.cooldownUntil - now)
}

function recordOriginRateLimit(url: string, retryAfterMs?: number, now = Date.now()): void {
  const key = rateLimitBucketKey(url)
  const existing = rateLimitBuckets.get(key)
  /* Concurrent failures from one wave share a single streak increment so a
     batch of parallel chunks does not jump straight to the cooldown ceiling. */
  const streak = !existing || now >= existing.cooldownUntil ? (existing?.streak ?? 0) + 1 : Math.max(1, existing.streak)
  const cooldownMs =
    retryAfterMs !== undefined
      ? Math.min(Math.max(0, retryAfterMs), MAX_SHARED_COOLDOWN_MS)
      : Math.min(INITIAL_RETRY_DELAY_MS * 2 ** (streak - 1), MAX_SHARED_COOLDOWN_MS)
  if (cooldownMs <= 0) return

  if (!existing && rateLimitBuckets.size >= MAX_TRACKED_RATE_LIMIT_BUCKETS) {
    const oldestKey = rateLimitBuckets.keys().next().value
    if (oldestKey !== undefined) rateLimitBuckets.delete(oldestKey)
  }

  rateLimitBuckets.set(key, {
    cooldownUntil: Math.max(existing?.cooldownUntil ?? 0, now + cooldownMs),
    streak,
    lastRateLimitAt: Math.max(existing?.lastRateLimitAt ?? 0, now),
  })
}

function recordOriginSuccess(url: string, requestStartedAt: number): void {
  const key = rateLimitBucketKey(url)
  const existing = rateLimitBuckets.get(key)
  if (existing && requestStartedAt >= existing.lastRateLimitAt) {
    rateLimitBuckets.delete(key)
  }
}

async function waitForOriginCooldown(
  url: string,
  retries: number,
  requestTimeoutMs: number,
  retryStartedAt: number,
  retryBudgetMs: number,
  respectCooldown: boolean,
): Promise<boolean> {
  if (!respectCooldown) return true
  const now = Date.now()
  const remaining = getOriginCooldownRemainingMs(url, now)
  if (remaining <= 0) return true

  const staggerMs = Math.floor(Math.random() * 251)
  const waitMs = remaining + staggerMs
  const minAttemptWindow = Math.min(MIN_RETRY_ATTEMPT_WINDOW_MS, requestTimeoutMs)
  const retryCeiling =
    retries > 0 ? retryStartedAt + retryBudgetMs : retryStartedAt + Math.min(requestTimeoutMs, retryBudgetMs)
  const effectiveCeiling = Math.min(retryCeiling, getPortalRequestDeadlineAt() ?? Number.POSITIVE_INFINITY)
  if (now + waitMs + minAttemptWindow > effectiveCeiling) {
    return false
  }
  await runWhilePortalBackoffSleep(() => sleep(waitMs))
  return true
}

export function parseRetryAfterMs(retryAfter?: string | null, now = Date.now()): number | undefined {
  if (!retryAfter) return undefined
  const trimmed = retryAfter.trim()
  if (!trimmed) return undefined

  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1_000) : undefined
  }

  const parsedDate = Date.parse(trimmed)
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - now)
  }

  return undefined
}

export function computeRetryAttemptTimeoutMs(
  requestTimeoutMs: number,
  retries: number,
  startedAt: number,
  now = Date.now(),
  retryBudgetMs = MAX_RETRY_WALL_CLOCK_MS,
  deadlineAt = getPortalRequestDeadlineAt(),
): number {
  const retryCeiling = retries > 0 ? startedAt + retryBudgetMs : Number.POSITIVE_INFINITY
  const effectiveCeiling = Math.min(retryCeiling, deadlineAt ?? Number.POSITIVE_INFINITY)
  if (!Number.isFinite(effectiveCeiling)) return requestTimeoutMs
  const remainingBudget = effectiveCeiling - now
  return Math.max(0, Math.min(requestTimeoutMs, remainingBudget))
}

export function computeRetryDelayMs(
  attempt: number,
  retryAfter?: string | number | null,
  random: () => number = Math.random,
  now = Date.now(),
): number {
  const retryAfterMs =
    typeof retryAfter === 'number'
      ? Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.round(retryAfter)
        : undefined
      : parseRetryAfterMs(retryAfter, now)
  const exponentialCap = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, attempt), MAX_RETRY_DELAY_MS)
  const jitter = Math.max(0, Math.min(0.999_999_999, random()))
  if (retryAfterMs !== undefined) {
    /* Honor upstream Retry-After while still scaling exponentially if repeated
       retries receive tiny hints such as 0 or 1 second. Keep jitter tight on
       multi-second Retry-After windows so a 10s wait still fits interactive
       latency budgets. */
    const floor = Math.max(retryAfterMs, attempt > 0 ? Math.floor(exponentialCap / 2) : 0)
    const jitterWindow = retryAfterMs > 5_000 ? 500 : Math.min(1_000, exponentialCap)
    return floor + Math.floor(jitter * (jitterWindow + 1))
  }
  /* Equal jitter keeps retries spaced at least half the exponential window so
     concurrent callers de-correlate without slamming Portal immediately. */
  const minDelay = Math.floor(exponentialCap / 2)
  return minDelay + Math.floor(jitter * (exponentialCap - minDelay + 1))
}

export function computeOverloadRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(OVERLOAD_INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, attempt), OVERLOAD_MAX_RETRY_DELAY_MS)
  const jitter = Math.max(0, Math.min(0.999_999_999, random()))
  const minDelay = Math.floor(cap / 2)
  return minDelay + Math.floor(jitter * (cap - minDelay + 1))
}

function retryLimitFor(reason: PortalRetryReason, callerRetries: number): number {
  return callerRetries > 0 && reason === 'overloaded' ? Math.max(callerRetries, OVERLOAD_RETRIES) : callerRetries
}

function classifyRetryReason(error: unknown, status?: number): PortalRetryReason {
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 529) return 'overloaded'
  if (status === 408) return 'timeout'
  if (status !== undefined && status >= 500) return 'server_error'
  if (error instanceof ActionableError) {
    if (error.code === 'overloaded' && error.origin === 'server') return 'admission_overloaded'
    if (error.code === 'rate_limited') return 'rate_limited'
    if (error.code === 'overloaded') return 'overloaded'
    if (error.code === 'upstream_reorg') return 'conflict'
    if (error.code === 'upstream_timeout') return 'timeout'
    if (error.code === 'upstream_unavailable') return 'server_error'
    if (error.message.includes('incomplete or malformed data stream')) return 'stream_error'
  }
  return 'network_error'
}

async function waitForRetry(
  attempt: number,
  retries: number,
  requestTimeoutMs: number,
  startedAt: number,
  retryBudgetMs: number,
  delayMs = computeRetryDelayMs(attempt),
): Promise<boolean> {
  if (attempt >= retries) return false
  const minAttemptWindow = Math.min(MIN_RETRY_ATTEMPT_WINDOW_MS, requestTimeoutMs)
  const effectiveCeiling = Math.min(startedAt + retryBudgetMs, getPortalRequestDeadlineAt() ?? Number.POSITIVE_INFINITY)
  if (Date.now() + delayMs + minAttemptWindow > effectiveCeiling) return false
  reportPortalProgress({
    phase: 'retry',
    progress: attempt + 1,
    total: retries + 1,
    message: `Portal busy, retrying (attempt ${attempt + 2}/${retries + 1})`,
  })
  await runWhilePortalBackoffSleep(() => sleep(delayMs))
  return true
}

async function readBoundedErrorText(response: Response): Promise<string> {
  if (!response.body) {
    try {
      const text = await response.text()
      return text.length > MAX_ERROR_BODY_BYTES ? `${text.slice(0, MAX_ERROR_BODY_BYTES)}…` : text
    } catch {
      return ''
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let totalBytes = 0
  let truncated = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (totalBytes + value.byteLength > MAX_ERROR_BODY_BYTES) {
        const remaining = Math.max(0, MAX_ERROR_BODY_BYTES - totalBytes)
        if (remaining > 0) {
          text += decoder.decode(value.subarray(0, remaining), { stream: true })
        }
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
      totalBytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return truncated ? `${text}…` : text
  } catch {
    await reader.cancel().catch(() => undefined)
    return ''
  } finally {
    reader.releaseLock()
  }
}

type NonOkPortalOutcome = {
  error: ActionableError
  retryDelayMs: number
  reason: PortalRetryReason
}

async function inspectNonOkPortalResponse(
  response: Response,
  url: string,
  body: unknown,
  attempt: number,
  upstream?: UpstreamSpan,
): Promise<NonOkPortalOutcome> {
  const headerRetryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'))
  const errorText = await readBoundedErrorText(response)
  const fallbackRetryDelayMs = computeRetryDelayMs(attempt, headerRetryAfterMs)
  const parsedError = parsePortalError(
    response.status,
    response.status === 409 && !errorText ? '409 Conflict' : errorText,
    { url, query: body },
    {
      retryAfterMs:
        response.status === 429
          ? (headerRetryAfterMs ?? Math.ceil(fallbackRetryDelayMs / 1_000) * 1_000)
          : headerRetryAfterMs,
    },
  )
  upstream?.fail(parsedError.code)

  /* Pace concurrent callers behind a shared dataset/endpoint cooldown on 429
     rate limits. Portal 529 overloads are per-request worker saturation while
     sibling requests on the same dataset often still succeed immediately, so
     a 529 sets no shared cooldown and does not stall unrelated callers. */
  if (response.status === 429) {
    recordOriginRateLimit(url, headerRetryAfterMs)
  }

  /* A 529 returns at once, and one advertised wait uses most of the retry
     budget, so retry on a short backoff and fit more attempts in the same
     budget. */
  const retryDelayMs =
    response.status === 429
      ? fallbackRetryDelayMs
      : response.status === 529
        ? computeOverloadRetryDelayMs(attempt)
        : computeRetryDelayMs(attempt, headerRetryAfterMs ?? parsedError.retryAfterMs)

  return {
    error: parsedError,
    retryDelayMs,
    reason: classifyRetryReason(parsedError, response.status),
  }
}
// Portal API Wrapper Functions
// ============================================================================
//
// These functions call the SQD Portal API at https://portal.sqd.dev
//
// Public API documentation: https://docs.sqd.dev/
//
// All queries use POST /datasets/{dataset}/stream with:
// - Request body: { type: "evm"|"solana", fromBlock, toBlock, logs: [...], fields: {...} }
// - Response: NDJSON stream (newline-delimited JSON)
//
// See src/resources/schema.ts for the API schemas exposed through MCP.
// ============================================================================

export async function sleep(ms: number): Promise<void> {
  const requestSignal = getPortalRequestSignal()
  if (!requestSignal) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
  if (requestSignal.aborted) throw new RequestCancelledError()

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      requestSignal.removeEventListener('abort', cancelWait)
      resolve()
    }, ms)
    const cancelWait = () => {
      clearTimeout(timeoutId)
      reject(new RequestCancelledError())
    }
    requestSignal.addEventListener('abort', cancelWait, { once: true })
  })
}

function rethrowAbort(
  error: unknown,
  abortContext: RequestAbortContext,
  timeout: number,
  context?: Record<string, unknown>,
): void {
  if (!isAbortLike(error) && !abortContext.signal.aborted) return
  if (abortContext.wasCancelled()) throw new RequestCancelledError()
  if (abortContext.didTimeout()) throw createTimeoutError(timeout, context)
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
  retryBudgetMs?: number
  respectCooldown?: boolean
  stopAfterItems?: StreamStopAfterItems
}

export interface PortalFetchStreamVisitOptions extends PortalFetchStreamOptions {
  onRecord: (record: unknown) => void | Promise<void>
}

export interface PortalFetchStreamRangeOptions extends PortalFetchStreamOptions {
  getBlockNumber?: (record: unknown) => number | undefined
}

export interface PortalFetchRecentRecordsOptions extends PortalFetchStreamRangeOptions {
  itemKeys: string[]
  countItems?: (record: unknown) => number
  limit: number
  chunkSize: number
  maxChunks?: number
  concurrency?: number
  initialSequentialChunks?: number
}

/* The byte budget is usually tens of megabytes, but an operator ceiling can set
   it far lower, and rounding that to megabytes reported a 2KB cap as ">0MB". */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes} bytes`
}

function enforceStreamByteLimit(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new ActionableError(
      `Response too large (>${humanBytes(maxBytes)}). Add filters or reduce block range.`,
      ['Add filters or reduce the block range'],
      { max_bytes: maxBytes },
      { code: 'response_too_large', origin: 'client_input', retryable: false },
    )
  }
}

function normalizePortalFetchStreamOptions(
  timeoutOrOptions: number | PortalFetchStreamOptions,
  maxBlocks: number,
  maxBytes: number,
  retries: number,
) {
  /* An operator ceiling lowers the byte budget the stream already enforces, so
     an over-budget response ends in the same `response_too_large` refusal it
     ends in today rather than a shape nothing has seen before. */
  const guarded = (requested: number) => applyGuardrail('max_upstream_bytes', requested).value
  if (typeof timeoutOrOptions === 'object') {
    const effectiveRetries = timeoutOrOptions.retries ?? DEFAULT_RETRIES
    return {
      timeout: timeoutOrOptions.timeout ?? STREAM_TIMEOUT,
      maxBlocks: timeoutOrOptions.maxBlocks ?? 0,
      maxBytes: guarded(timeoutOrOptions.maxBytes ?? 50 * 1024 * 1024),
      retries: effectiveRetries,
      retryBudgetMs: timeoutOrOptions.retryBudgetMs ?? MAX_RETRY_WALL_CLOCK_MS,
      respectCooldown: timeoutOrOptions.respectCooldown ?? effectiveRetries > 0,
      stopAfterItems: timeoutOrOptions.stopAfterItems,
    }
  }

  return {
    timeout: timeoutOrOptions,
    maxBlocks,
    maxBytes: guarded(maxBytes),
    retries,
    retryBudgetMs: MAX_RETRY_WALL_CLOCK_MS,
    respectCooldown: retries > 0,
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
    retryBudgetMs?: number
    respectCooldown?: boolean
  } = {},
): Promise<T> {
  return withPortalFetchAdmissionTracking(async () => {
    const {
      method = 'GET',
      body,
      timeout = DEFAULT_TIMEOUT,
      retries = DEFAULT_RETRIES,
      retryBudgetMs = MAX_RETRY_WALL_CLOCK_MS,
      respectCooldown = retries > 0,
    } = options

    let lastError: Error | null = null
    let pendingRetryReason: PortalRetryReason | undefined
    const retryStartedAt = Date.now()

    for (let attempt = 0; attempt <= retryLimitFor('overloaded', retries); attempt++) {
      if (!(await waitForOriginCooldown(url, retries, timeout, retryStartedAt, retryBudgetMs, respectCooldown))) {
        if (lastError) break
      }
      const attemptTimeout = computeRetryAttemptTimeoutMs(timeout, retries, retryStartedAt, Date.now(), retryBudgetMs)
      if (attemptTimeout <= 0) break
      if (pendingRetryReason) {
        portalRetriesTotal.inc({ method, reason: pendingRetryReason })
        pendingRetryReason = undefined
      }
      const attemptStartedAt = Date.now()
      const abortContext = createRequestAbortContext(attemptTimeout)
      let releaseAdmission: (() => void) | undefined
      let upstream: UpstreamSpan | undefined

      try {
        releaseAdmission = await portalAdmission.acquire(abortContext.signal)
        upstream = startUpstreamSpan({ method, url, attempt })
        const fetchOptions: RequestInit = {
          method,
          headers: {
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/json',
            Accept: 'application/json',
            /* Nothing when tracing is off, and a W3C traceparent when it is on,
               so a Portal-side trace can join this one. */
            ...upstream.headers(),
          },
          signal: abortContext.signal,
        }

        if (body) {
          fetchOptions.body = JSON.stringify(body)
        }

        const response = await fetch(url, fetchOptions)

        upstream.setAttribute('http.response.status_code', response.status)
        /* This path parses JSON rather than counting bytes, so the declared
           length is the only size there is. Absent it, say nothing: `Number(null)`
           is 0, and a reported zero would be a claim rather than a gap. */
        const declaredBytes = Number(response.headers.get('content-length') ?? Number.NaN)
        if (Number.isFinite(declaredBytes)) upstream.setAttribute('mcp.upstream.bytes', declaredBytes)
        portalRequestsTotal.inc({ method, status_code: response.status })

        if (response.status === 204) {
          recordOriginSuccess(url, attemptStartedAt)
          return [] as T
        }

        if (!response.ok) {
          const outcome = await inspectNonOkPortalResponse(response, url, body, attempt, upstream)
          if (!outcome.error.retryable) throw outcome.error
          lastError = outcome.error
          releaseAdmission()
          releaseAdmission = undefined
          if (
            !(await waitForRetry(
              attempt,
              retryLimitFor(outcome.reason, retries),
              timeout,
              retryStartedAt,
              retryBudgetMs,
              outcome.retryDelayMs,
            ))
          )
            break
          pendingRetryReason = outcome.reason
          continue
        }

        recordOriginSuccess(url, attemptStartedAt)
        return (await response.json()) as T
      } catch (error) {
        rethrowAbort(error, abortContext, attemptTimeout, { url, attempt: attempt + 1, max_attempts: retries + 1 })

        lastError = wrapError(error, { url, attempt: attempt + 1, max_attempts: retries + 1 }) as Error
        upstream?.fail(lastError instanceof ActionableError ? lastError.code : lastError.name)

        if (lastError instanceof ActionableError && !lastError.retryable) {
          throw lastError
        }

        releaseAdmission?.()
        releaseAdmission = undefined
        const retryHint = lastError instanceof ActionableError ? lastError.retryAfterMs : undefined
        const retryDelay = computeRetryDelayMs(attempt, retryHint)
        if (!(await waitForRetry(attempt, retries, timeout, retryStartedAt, retryBudgetMs, retryDelay))) break
        pendingRetryReason = classifyRetryReason(lastError)
      } finally {
        releaseAdmission?.()
        /* Closed here rather than after the fetch, so the span covers reading
           the body as well: on a streaming read that is nearly all of it. */
        upstream?.end()
        abortContext.cleanup()
      }
    }

    throw lastError || new Error('Request failed after retries')
  })
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
  return withPortalFetchAdmissionTracking(async () => {
    const options = normalizePortalFetchStreamOptions(timeoutOrOptions, maxBlocks, maxBytes, _retries)
    const { timeout, stopAfterItems, retryBudgetMs, respectCooldown } = options
    let lastError: Error | null = null
    let pendingRetryReason: PortalRetryReason | undefined
    const retryStartedAt = Date.now()

    for (let attempt = 0; attempt <= retryLimitFor('overloaded', options.retries); attempt++) {
      if (
        !(await waitForOriginCooldown(url, options.retries, timeout, retryStartedAt, retryBudgetMs, respectCooldown))
      ) {
        if (lastError) break
      }
      const attemptTimeout = computeRetryAttemptTimeoutMs(
        timeout,
        options.retries,
        retryStartedAt,
        Date.now(),
        retryBudgetMs,
      )
      if (attemptTimeout <= 0) break
      if (pendingRetryReason) {
        portalRetriesTotal.inc({ method: 'POST', reason: pendingRetryReason })
        pendingRetryReason = undefined
      }
      const attemptStartedAt = Date.now()
      const abortContext = createRequestAbortContext(attemptTimeout)
      let releaseAdmission: (() => void) | undefined
      let upstream: UpstreamSpan | undefined

      try {
        releaseAdmission = await portalAdmission.acquire(abortContext.signal)
        upstream = startUpstreamSpan({ method: 'POST', url, attempt })
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson',
            /* Nothing when tracing is off, and a W3C traceparent when it is on,
               so a Portal-side trace can join this one. */
            ...upstream.headers(),
          },
          body: JSON.stringify(body),
          signal: abortContext.signal,
        })

        upstream.setAttribute('http.response.status_code', response.status)
        portalRequestsTotal.inc({ method: 'POST', status_code: response.status })

        if (response.status === 204) {
          recordOriginSuccess(url, attemptStartedAt)
          return []
        }

        if (!response.ok) {
          const outcome = await inspectNonOkPortalResponse(response, url, body, attempt, upstream)
          if (!outcome.error.retryable) throw outcome.error
          lastError = outcome.error
          releaseAdmission()
          releaseAdmission = undefined
          if (
            !(await waitForRetry(
              attempt,
              retryLimitFor(outcome.reason, options.retries),
              timeout,
              retryStartedAt,
              retryBudgetMs,
              outcome.retryDelayMs,
            ))
          )
            break
          pendingRetryReason = outcome.reason
          continue
        }

        recordOriginSuccess(url, attemptStartedAt)

        // Fallback for environments without ReadableStream
        if (!response.body) {
          const results: unknown[] = []
          let matchedItems = 0
          const text = await response.text()
          enforceStreamByteLimit(Buffer.byteLength(text, 'utf8'), options.maxBytes)

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

            totalBytes += value.byteLength
            enforceStreamByteLimit(totalBytes, options.maxBytes)
            buffer += decoder.decode(value, { stream: true })

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
          }

          buffer += decoder.decode()
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
          /* Once, on the way out, rather than on every chunk. */
          upstream?.setAttribute('mcp.upstream.bytes', totalBytes)
          // An errored stream rejects cancellation; preserve the original failure.
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }

        return results
      } catch (error) {
        rethrowAbort(error, abortContext, attemptTimeout, { url, query: body })

        lastError = wrapError(error, { url, query: body }) as Error
        upstream?.fail(lastError instanceof ActionableError ? lastError.code : lastError.name)
        if (lastError instanceof ActionableError && !lastError.retryable) throw lastError

        releaseAdmission?.()
        releaseAdmission = undefined
        const retryHint = lastError instanceof ActionableError ? lastError.retryAfterMs : undefined
        const retryDelay = computeRetryDelayMs(attempt, retryHint)
        if (!(await waitForRetry(attempt, options.retries, timeout, retryStartedAt, retryBudgetMs, retryDelay))) break
        pendingRetryReason = classifyRetryReason(lastError)
      } finally {
        releaseAdmission?.()
        /* Closed here rather than after the fetch, so the span covers reading
         the body as well: on a streaming read that is nearly all of it. */
        upstream?.end()
        abortContext.cleanup()
      }
    } // end for loop

    throw lastError || new Error('Stream request failed after retries')
  })
}

/**
 * Stream Portal API results and process each NDJSON record incrementally
 * without materializing the full response in memory.
 *
 * Returns the number of processed NDJSON records.
 * A failed response is never replayed after a record reaches the visitor.
 * Adaptive callers may resume only from a validated completed-block checkpoint;
 * all other callers must discard accumulated state on failure.
 */
export async function portalFetchStreamVisit(
  url: string,
  body: unknown,
  options: PortalFetchStreamVisitOptions,
): Promise<number> {
  return withPortalFetchAdmissionTracking(async () => {
    const normalizedOptions = normalizePortalFetchStreamOptions(options, 0, 50 * 1024 * 1024, DEFAULT_RETRIES)
    const { timeout, stopAfterItems, retryBudgetMs, respectCooldown } = normalizedOptions
    let lastError: Error | null = null
    let pendingRetryReason: PortalRetryReason | undefined
    const retryStartedAt = Date.now()

    for (let attempt = 0; attempt <= retryLimitFor('overloaded', normalizedOptions.retries); attempt++) {
      if (
        !(await waitForOriginCooldown(
          url,
          normalizedOptions.retries,
          timeout,
          retryStartedAt,
          retryBudgetMs,
          respectCooldown,
        ))
      ) {
        if (lastError) break
      }
      const attemptTimeout = computeRetryAttemptTimeoutMs(
        timeout,
        normalizedOptions.retries,
        retryStartedAt,
        Date.now(),
        retryBudgetMs,
      )
      if (attemptTimeout <= 0) break
      if (pendingRetryReason) {
        portalRetriesTotal.inc({ method: 'POST', reason: pendingRetryReason })
        pendingRetryReason = undefined
      }
      const attemptStartedAt = Date.now()
      const abortContext = createRequestAbortContext(attemptTimeout)
      let releaseAdmission: (() => void) | undefined
      let upstream: UpstreamSpan | undefined
      let processedRecords = 0
      const delivery = new StreamDelivery()

      try {
        releaseAdmission = await portalAdmission.acquire(abortContext.signal)
        upstream = startUpstreamSpan({ method: 'POST', url, attempt })
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson',
            /* Nothing when tracing is off, and a W3C traceparent when it is on,
               so a Portal-side trace can join this one. */
            ...upstream.headers(),
          },
          body: JSON.stringify(body),
          signal: abortContext.signal,
        })

        upstream.setAttribute('http.response.status_code', response.status)
        portalRequestsTotal.inc({ method: 'POST', status_code: response.status })

        if (response.status === 204) {
          recordOriginSuccess(url, attemptStartedAt)
          return 0
        }

        if (!response.ok) {
          const outcome = await inspectNonOkPortalResponse(response, url, body, attempt, upstream)
          if (!outcome.error.retryable) throw outcome.error
          lastError = outcome.error
          releaseAdmission()
          releaseAdmission = undefined
          if (
            !(await waitForRetry(
              attempt,
              retryLimitFor(outcome.reason, normalizedOptions.retries),
              timeout,
              retryStartedAt,
              retryBudgetMs,
              outcome.retryDelayMs,
            ))
          )
            break
          pendingRetryReason = outcome.reason
          continue
        }

        recordOriginSuccess(url, attemptStartedAt)

        let matchedItems = 0

        if (!response.body) {
          const text = await response.text()
          enforceStreamByteLimit(Buffer.byteLength(text, 'utf8'), normalizedOptions.maxBytes)

          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue

            const parsed = JSON.parse(trimmed)
            processedRecords++
            matchedItems += countMatchingItems(parsed, stopAfterItems)
            await delivery.deliver(parsed, options.onRecord, getRecordBlockNumber)

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

            totalBytes += value.byteLength
            enforceStreamByteLimit(totalBytes, normalizedOptions.maxBytes)
            buffer += decoder.decode(value, { stream: true })

            let newlineIdx: number
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newlineIdx).trim()
              buffer = buffer.slice(newlineIdx + 1)

              if (!line) continue

              const parsed = JSON.parse(line)
              processedRecords++
              matchedItems += countMatchingItems(parsed, stopAfterItems)
              await delivery.deliver(parsed, options.onRecord, getRecordBlockNumber)

              if (normalizedOptions.maxBlocks > 0 && processedRecords >= normalizedOptions.maxBlocks) {
                await reader.cancel()
                return processedRecords
              }

              if (stopAfterItems && matchedItems >= stopAfterItems.limit) {
                await reader.cancel()
                return processedRecords
              }
            }
          }

          buffer += decoder.decode()
          const remaining = buffer.trim()
          if (remaining) {
            const parsed = JSON.parse(remaining)
            processedRecords++
            matchedItems += countMatchingItems(parsed, stopAfterItems)
            await delivery.deliver(parsed, options.onRecord, getRecordBlockNumber)
          }
        } finally {
          /* Once, on the way out, rather than on every chunk. */
          upstream?.setAttribute('mcp.upstream.bytes', totalBytes)
          // An errored stream rejects cancellation; preserve the original failure.
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }

        return processedRecords
      } catch (error) {
        if (error instanceof RequestCancelledError || abortContext.wasCancelled()) throw new RequestCancelledError()
        let cause = error
        if (!delivery.visitorFailed) {
          try {
            rethrowAbort(error, abortContext, attemptTimeout, { url, query: body })
          } catch (abortError) {
            cause = abortError
          }
        }
        if (delivery.deliveredRecords > 0) throw new PortalStreamError(cause, delivery)
        if (!delivery.visitorFailed && abortContext.didTimeout()) throw cause

        lastError = wrapError(cause, { url, query: body }) as Error
        upstream?.fail(lastError instanceof ActionableError ? lastError.code : lastError.name)
        if (lastError instanceof ActionableError && !lastError.retryable) throw lastError

        releaseAdmission?.()
        releaseAdmission = undefined
        const retryHint = lastError instanceof ActionableError ? lastError.retryAfterMs : undefined
        const retryDelay = computeRetryDelayMs(attempt, retryHint)
        if (
          !(await waitForRetry(attempt, normalizedOptions.retries, timeout, retryStartedAt, retryBudgetMs, retryDelay))
        )
          break
        pendingRetryReason = classifyRetryReason(lastError)
      } finally {
        releaseAdmission?.()
        /* Closed here rather than after the fetch, so the span covers reading
         the body as well: on a streaming read that is nearly all of it. */
        upstream?.end()
        abortContext.cleanup()
      }
    }

    throw lastError || new Error('Stream request failed after retries')
  })
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
    matchedItems += chunk.reduce<number>((sum, record) => sum + countMatchingItems(record, options.stopAfterItems), 0)

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
      reportPortalProgress({
        phase: 'stream',
        progress: requestedTo - requestedFrom + 1,
        total: requestedTo - requestedFrom + 1,
        message: `Streamed blocks ${requestedFrom.toLocaleString('en-US')}-${requestedTo.toLocaleString('en-US')}`,
      })
      break
    }

    reportPortalProgress({
      phase: 'stream',
      progress: Math.max(1, lastReturnedBlock - requestedFrom + 1),
      total: requestedTo - requestedFrom + 1,
      message: `Streaming blocks (${(lastReturnedBlock - requestedFrom + 1).toLocaleString('en-US')}/${(requestedTo - requestedFrom + 1).toLocaleString('en-US')})`,
    })
    currentFrom = lastReturnedBlock + 1
  }

  return results
}

/**
 * Stream a complete block range and process each NDJSON record incrementally,
 * continuing forward if Portal returns only a partial contiguous subrange.
 */
export async function portalFetchStreamRangeVisit(
  url: string,
  body: unknown,
  options: PortalFetchStreamVisitOptions & PortalFetchStreamRangeOptions,
): Promise<number> {
  if (!body || typeof body !== 'object') {
    return portalFetchStreamVisit(url, body, options)
  }

  const typedBody = body as Record<string, unknown>
  const requestedFrom = parseBlockNumber(typedBody.fromBlock)
  const requestedTo = parseBlockNumber(typedBody.toBlock)

  if (requestedFrom === undefined || requestedTo === undefined || requestedFrom > requestedTo) {
    return portalFetchStreamVisit(url, body, options)
  }

  const getBlockNumber = options.getBlockNumber ?? getRecordBlockNumber
  const stopAfterLimit = options.stopAfterItems?.limit ?? 0
  let matchedItems = 0
  let processedRecords = 0
  let currentFrom = requestedFrom
  let remainingBlockBudget = options.maxBlocks ?? 0
  const delivery = new StreamDelivery()

  while (currentFrom <= requestedTo) {
    let lastReturnedBlock: number | undefined
    const stopAfterItems =
      options.stopAfterItems && stopAfterLimit > 0
        ? {
            ...options.stopAfterItems,
            limit: Math.max(1, stopAfterLimit - matchedItems),
          }
        : undefined

    let chunkProcessed: number
    try {
      chunkProcessed = await portalFetchStreamVisit(
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
          onRecord: async (record) => {
            await delivery.deliver(record, options.onRecord, getBlockNumber)
            processedRecords++
            matchedItems += countMatchingItems(record, options.stopAfterItems)

            const recordBlock = getBlockNumber(record)
            if (recordBlock !== undefined) {
              lastReturnedBlock = recordBlock
            }
          },
        },
      )
    } catch (error) {
      if (error instanceof RequestCancelledError) throw error
      if (delivery.deliveredRecords > 0) throw new PortalStreamError(error, delivery)
      throw error
    }

    if (chunkProcessed === 0) {
      break
    }

    if (stopAfterLimit > 0 && matchedItems >= stopAfterLimit) {
      break
    }

    if (remainingBlockBudget > 0) {
      remainingBlockBudget = Math.max(0, remainingBlockBudget - chunkProcessed)
      if (remainingBlockBudget === 0) {
        break
      }
    }

    if (lastReturnedBlock === undefined || lastReturnedBlock < currentFrom) {
      break
    }

    if (lastReturnedBlock >= requestedTo) {
      reportPortalProgress({
        phase: 'stream',
        progress: requestedTo - requestedFrom + 1,
        total: requestedTo - requestedFrom + 1,
        message: `Streamed blocks ${requestedFrom.toLocaleString('en-US')}-${requestedTo.toLocaleString('en-US')}`,
      })
      break
    }

    reportPortalProgress({
      phase: 'stream',
      progress: Math.max(1, lastReturnedBlock - requestedFrom + 1),
      total: requestedTo - requestedFrom + 1,
      message: `Streaming blocks (${(lastReturnedBlock - requestedFrom + 1).toLocaleString('en-US')}/${(requestedTo - requestedFrom + 1).toLocaleString('en-US')})`,
    })
    currentFrom = lastReturnedBlock + 1
  }

  return processedRecords
}

/* Where a backward scan stopped. `exhausted` means every block of the
   requested window was read. A scan that filled its page early, or ran into
   maxChunks, leaves the blocks below scannedFromBlock unread, and a response
   that calls such a window complete is describing blocks it never opened. */
export interface RecentScanSummary {
  scannedFromBlock: number
  scannedToBlock: number
  exhausted: boolean
  chunksVisited: number
  matchedItems: number
}

/**
 * Fetch recent matching records from the end of a range, chunking backward so
 * limit-based "recent" queries return the latest matches rather than the oldest
 * matches in the window.
 */
export async function portalFetchRecentRecords(
  url: string,
  body: unknown,
  options: PortalFetchRecentRecordsOptions,
): Promise<unknown[]> {
  const result = await portalFetchRecentRecordsWithScan(url, body, options)
  return result.records
}

/* The same fetch, with the scan summary a caller needs to say how much of
   the window it actually read. A body without a block range streams the
   whole range and has no scan to summarise. */
export async function portalFetchRecentRecordsWithScan(
  url: string,
  body: unknown,
  options: PortalFetchRecentRecordsOptions,
): Promise<{ records: unknown[]; scan: RecentScanSummary | undefined }> {
  if (!body || typeof body !== 'object') {
    return { records: await portalFetchStreamRange(url, body, options), scan: undefined }
  }

  const typedBody = body as Record<string, unknown>
  const requestedFrom = parseBlockNumber(typedBody.fromBlock)
  const requestedTo = parseBlockNumber(typedBody.toBlock)

  if (requestedFrom === undefined || requestedTo === undefined || requestedFrom > requestedTo) {
    return { records: await portalFetchStreamRange(url, body, options), scan: undefined }
  }

  const chunkSize = Math.max(1, options.chunkSize)
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
  const initialSequentialChunks = Math.max(0, Math.floor(options.initialSequentialChunks ?? 0))
  const recentRecords: unknown[] = []
  let matchedItems = 0
  let currentTo = requestedTo
  let chunksVisited = 0
  let scannedFromBlock = requestedTo + 1

  while (currentTo >= requestedFrom && matchedItems < options.limit) {
    if (options.maxChunks !== undefined && chunksVisited >= options.maxChunks) {
      break
    }

    const batchConcurrency = chunksVisited < initialSequentialChunks ? 1 : concurrency
    const batch: Array<{ fromBlock: number; toBlock: number }> = []
    let plannedTo = currentTo
    while (batch.length < batchConcurrency && plannedTo >= requestedFrom) {
      if (options.maxChunks !== undefined && chunksVisited + batch.length >= options.maxChunks) break
      const chunkFrom = Math.max(requestedFrom, plannedTo - chunkSize + 1)
      batch.push({ fromBlock: chunkFrom, toBlock: plannedTo })
      plannedTo = chunkFrom - 1
    }
    if (batch.length === 0) break

    const outcomes = await Promise.allSettled(
      batch.map((chunk) =>
        portalFetchStreamRange(
          url,
          {
            ...typedBody,
            fromBlock: chunk.fromBlock,
            toBlock: chunk.toBlock,
          },
          {
            ...options,
            stopAfterItems: undefined,
            maxBlocks: 0,
          },
        ),
      ),
    )

    for (let index = 0; index < outcomes.length && matchedItems < options.limit; index += 1) {
      const outcome = outcomes[index]
      if (outcome.status === 'rejected') throw outcome.reason
      chunksVisited += 1
      scannedFromBlock = batch[index].fromBlock

      if (outcome.value.length > 0) {
        recentRecords.unshift(...outcome.value)
        matchedItems += outcome.value.reduce<number>(
          (sum, record) =>
            sum +
            (options.countItems
              ? options.countItems(record)
              : countMatchingItems(record, { keys: options.itemKeys, limit: Number.MAX_SAFE_INTEGER })),
          0,
        )
      }
    }

    currentTo = batch[batch.length - 1].fromBlock - 1
  }

  return {
    records: recentRecords,
    scan: {
      scannedFromBlock,
      scannedToBlock: requestedTo,
      exhausted: scannedFromBlock <= requestedFrom,
      chunksVisited,
      matchedItems,
    },
  }
}
