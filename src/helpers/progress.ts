import { AsyncLocalStorage } from 'node:async_hooks'

import type { ServerContext } from '@modelcontextprotocol/server'

export type ProgressToken = string | number

export type PortalProgressEvent = {
  progress: number
  total?: number
  message?: string
}

type ProgressState = {
  token: ProgressToken
  notify: ServerContext['mcpReq']['notify']
  signal?: AbortSignal
  minIntervalMs: number
  lastSentAt: number
  lastProgress: number
  lastPhase?: string
  closed: boolean
}

const progressStorage = new AsyncLocalStorage<ProgressState | undefined>()

const DEFAULT_PROGRESS_INTERVAL_MS = 250

export function readProgressToken(context: ServerContext | undefined): ProgressToken | undefined {
  const token = context?.mcpReq._meta?.progressToken
  return typeof token === 'string' || typeof token === 'number' ? token : undefined
}

/**
 * Run a tool handler with an active `notifications/progress` emitter when the
 * caller supplied `_meta.progressToken`. Callers without a token pay zero cost.
 */
export async function runWithPortalProgress<T>(
  context: ServerContext | undefined,
  callback: () => Promise<T>,
  options?: { minIntervalMs?: number },
): Promise<T> {
  const token = readProgressToken(context)
  const notify = context?.mcpReq.notify
  if (token === undefined || typeof notify !== 'function') {
    return callback()
  }

  const state: ProgressState = {
    token,
    notify,
    signal: context?.mcpReq.signal,
    minIntervalMs: options?.minIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
    lastSentAt: 0,
    lastProgress: -1,
    closed: false,
  }

  try {
    return await progressStorage.run(state, callback)
  } finally {
    state.closed = true
  }
}

export function hasPortalProgressReporter(): boolean {
  const state = progressStorage.getStore()
  return Boolean(state && !state.closed && !state.signal?.aborted)
}

/**
 * Emit a throttled `notifications/progress` update for the current tool call.
 * Phase changes and terminal updates bypass the time throttle; transport errors
 * are swallowed so progress reporting can never fail a healthy tool call.
 */
export function reportPortalProgress(event: PortalProgressEvent & { phase?: string; force?: boolean }): void {
  const state = progressStorage.getStore()
  if (!state || state.closed || state.signal?.aborted) return

  const now = Date.now()
  const phaseChanged = event.phase !== undefined && event.phase !== state.lastPhase
  const completed = event.total !== undefined && event.progress >= event.total
  if (!event.force && !phaseChanged && !completed && now - state.lastSentAt < state.minIntervalMs) {
    return
  }

  const progress = Math.max(state.lastProgress + (phaseChanged ? 0 : 0), event.progress)
  state.lastSentAt = now
  state.lastProgress = progress
  if (event.phase !== undefined) state.lastPhase = event.phase

  const params: Record<string, unknown> = {
    progressToken: state.token,
    progress,
    ...(event.total !== undefined ? { total: event.total } : {}),
    ...(event.message ? { message: event.message } : {}),
  }

  try {
    void Promise.resolve(
      state.notify({
        method: 'notifications/progress',
        params,
      }),
    ).catch(() => undefined)
  } catch {
    // Progress is best-effort; never interrupt a running query.
  }
}
