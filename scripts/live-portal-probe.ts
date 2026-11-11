type ProbeClock = {
  now: () => number
  wait: (delayMs: number) => Promise<void>
}

type ProbeOptions<T> = {
  accept?: (value: T) => boolean
  maxAttempts?: number
  totalBudgetMs?: number
  clock?: ProbeClock
}

const TRANSIENT_CODES = new Set(['rate_limited', 'upstream_unavailable', 'upstream_timeout', 'upstream_error'])
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 529])
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])

function transientRetryDelay(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const failure = error as Record<string, unknown>
  if ('retryable' in failure) {
    if (failure.retryable !== true || failure.origin !== 'upstream' || !TRANSIENT_CODES.has(String(failure.code))) {
      return undefined
    }
    const hint = failure.retryAfterMs ?? failure.retry_after_ms
    return typeof hint === 'number' && Number.isFinite(hint) && hint >= 0 ? hint : 0
  }
  if (failure.name === 'TimeoutError') return 0
  const cause = failure.cause as { code?: string } | undefined
  if (cause?.code && NETWORK_CODES.has(cause.code)) return 0
  return undefined
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export async function retryPortalProbe<T>(
  label: string,
  probe: (remainingBudgetMs: number) => Promise<T>,
  options: ProbeOptions<T> = {},
): Promise<T> {
  const clock = options.clock ?? {
    now: Date.now,
    wait: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  }
  const maxAttempts = options.maxAttempts ?? 4
  const totalBudgetMs = options.totalBudgetMs ?? 60_000
  const startedAt = clock.now()

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let value: T
    try {
      value = await probe(Math.max(1, totalBudgetMs - (clock.now() - startedAt)))
    } catch (error) {
      const retryAfterMs = transientRetryDelay(error)
      if (retryAfterMs === undefined || attempt === maxAttempts) throw error
      const delayMs = Math.max(1_500 * 2 ** (attempt - 1), retryAfterMs)
      if (clock.now() - startedAt + delayMs >= totalBudgetMs) throw error
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`RETRY ${label}: attempt ${attempt}/${maxAttempts}, waiting ${delayMs}ms after ${reason}`)
      await clock.wait(delayMs)
      continue
    }

    if (!options.accept || options.accept(value) || attempt === maxAttempts) return value
    const delayMs = 1_500 * 2 ** (attempt - 1)
    if (clock.now() - startedAt + delayMs >= totalBudgetMs) return value
    console.warn(`RETRY ${label}: attempt ${attempt}/${maxAttempts}, waiting ${delayMs}ms for verified evidence`)
    await clock.wait(delayMs)
  }
  throw new Error(`${label}: no Portal probe attempts configured`)
}

export async function fetchPortalText(
  label: string,
  url: string,
  init: RequestInit = {},
  options: ProbeOptions<string> = {},
): Promise<string> {
  return retryPortalProbe(
    label,
    async (remainingBudgetMs) => {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(30_000, remainingBudgetMs)))
      const response = await fetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      })
      const text = await response.text()
      if (!response.ok) {
        throw Object.assign(new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 300)}`), {
          code: response.status === 429 || response.status === 529 ? 'rate_limited' : 'upstream_error',
          origin: 'upstream',
          retryable: TRANSIENT_STATUSES.has(response.status),
          retryAfterMs:
            parseRetryAfter(response.headers.get('retry-after'), options.clock?.now() ?? Date.now()) ??
            (response.status === 529 ? 5_000 : undefined),
        })
      }
      return text
    },
    options,
  )
}
