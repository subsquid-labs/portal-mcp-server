import { AsyncLocalStorage } from 'node:async_hooks'

import { RequestCancelledError, createTimeoutError } from './errors.js'

const requestSignalStorage = new AsyncLocalStorage<AbortSignal | undefined>()
const requestDeadlineStorage = new AsyncLocalStorage<number | undefined>()

export type SuspendableToolLease = {
  suspend: () => void
  resume: (signal?: AbortSignal) => Promise<void>
}

type ToolAdmissionPauser = {
  activeFetches: number
  sleepingFetches: number
  paused: boolean
  lease: SuspendableToolLease
  signal?: AbortSignal
  resumePromise?: Promise<void>
}

const toolAdmissionPauserStorage = new AsyncLocalStorage<ToolAdmissionPauser | undefined>()

function createAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export type RequestAbortContext = {
  signal: AbortSignal
  didTimeout: () => boolean
  wasCancelled: () => boolean
  cleanup: () => void
}

/**
 * Keep the MCP request cancellation signal available to shared Portal helpers
 * without threading it through every tool and cache helper signature.
 */
export function runWithPortalRequestSignal<T>(signal: AbortSignal | undefined, callback: () => T): T {
  return requestSignalStorage.run(signal, callback)
}

export function getPortalRequestSignal(): AbortSignal | undefined {
  return requestSignalStorage.getStore()
}

export function getPortalRequestDeadlineAt(): number | undefined {
  return requestDeadlineStorage.getStore()
}

export function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b
  if (!b || a === b) return a
  return AbortSignal.any([a, b])
}

export function runWithToolAdmissionLease<T>(lease: SuspendableToolLease, callback: () => T, signal?: AbortSignal): T {
  return toolAdmissionPauserStorage.run(
    {
      activeFetches: 0,
      sleepingFetches: 0,
      paused: false,
      lease,
      signal,
    },
    callback,
  )
}

function maybeSuspendToolAdmission(pauser: ToolAdmissionPauser): void {
  if (pauser.activeFetches > 0 && pauser.sleepingFetches >= pauser.activeFetches && !pauser.paused) {
    pauser.paused = true
    pauser.lease.suspend()
  }
}

async function ensureToolAdmissionResumed(
  pauser: ToolAdmissionPauser,
  currentSignal = getPortalRequestSignal(),
): Promise<void> {
  if (!pauser.paused) return
  const toolSignal = pauser.signal
  if (currentSignal?.aborted) {
    throw toolSignal?.aborted ? new RequestCancelledError() : createAbortError()
  }
  if (!pauser.resumePromise) {
    const pending = pauser.lease.resume(toolSignal ?? currentSignal).then(
      () => {
        if (pauser.resumePromise === pending) {
          pauser.resumePromise = undefined
          pauser.paused = false
        }
      },
      (error) => {
        if (pauser.resumePromise === pending) {
          pauser.resumePromise = undefined
        }
        throw error
      },
    )
    /* Prevent unhandled rejection if an inner deadline caller stops awaiting
       before a later tool cancellation rejects the shared resume promise. */
    pending.catch(() => undefined)
    pauser.resumePromise = pending
  }
  const resumePromise = pauser.resumePromise
  if (!currentSignal || currentSignal === toolSignal) {
    await resumePromise
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(toolSignal?.aborted ? new RequestCancelledError() : createAbortError())
    if (currentSignal.aborted) {
      onAbort()
      return
    }
    currentSignal.addEventListener('abort', onAbort, { once: true })
    resumePromise.then(
      () => {
        currentSignal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error) => {
        currentSignal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Track an active Portal fetch within the enclosing tool call so the tool's
 * weighted admission slot can be yielded whenever all of its in-flight fetches
 * are sleeping on upstream retry backoff or rate-limit cooldown.
 */
export async function withPortalFetchAdmissionTracking<T>(callback: () => Promise<T>): Promise<T> {
  const pauser = toolAdmissionPauserStorage.getStore()
  if (!pauser) return callback()

  pauser.activeFetches += 1
  try {
    if (pauser.paused) {
      await ensureToolAdmissionResumed(pauser)
    }
    return await callback()
  } finally {
    pauser.activeFetches = Math.max(0, pauser.activeFetches - 1)
    maybeSuspendToolAdmission(pauser)
  }
}

/**
 * Yield the enclosing tool's weighted admission slot while all of its active
 * Portal fetches are sleeping, then re-acquire it before issuing the next
 * upstream attempt.
 */
export async function runWhilePortalBackoffSleep(sleepFn: () => Promise<void>): Promise<void> {
  const pauser = toolAdmissionPauserStorage.getStore()
  if (!pauser) {
    await sleepFn()
    return
  }

  pauser.sleepingFetches += 1
  maybeSuspendToolAdmission(pauser)

  try {
    await sleepFn()
  } finally {
    pauser.sleepingFetches = Math.max(0, pauser.sleepingFetches - 1)
  }

  await ensureToolAdmissionResumed(pauser)
}

export type SharedPortalWork<T> = {
  promise: Promise<T>
  controller: AbortController
  settled: boolean
  waiters: number
  sleeping: boolean
  sleepListeners: Set<(sleeping: boolean) => void>
}

/**
 * Start cacheable work with its own cancellation scope. Identical callers can
 * share the scan, and the scan is cancelled when its last waiter leaves.
 */
export function runAsSharedPortalWork<T>(callback: () => Promise<T>): SharedPortalWork<T> {
  const controller = new AbortController()
  const sleepListeners = new Set<(sleeping: boolean) => void>()
  let sleeping = false
  let workRef: SharedPortalWork<T> | undefined
  const setSleeping = (next: boolean) => {
    if (sleeping === next) return
    sleeping = next
    if (workRef) workRef.sleeping = next
    for (const listener of sleepListeners) {
      listener(next)
    }
  }
  const sharedLease: SuspendableToolLease = {
    suspend: () => setSleeping(true),
    resume: () => {
      setSleeping(false)
      return Promise.resolve()
    },
  }
  /* Shared cache work must not inherit one caller's tool deadline or directly
     suspend one caller's lease, but tracking its own backoff sleeps lets every
     waiting tool yield its weighted admission slot while the shared lookup
     sleeps on retry or cooldown. */
  const promise = requestDeadlineStorage.run(undefined, () =>
    runWithToolAdmissionLease(
      sharedLease,
      () => runWithPortalRequestSignal(controller.signal, callback),
      controller.signal,
    ),
  )
  const work: SharedPortalWork<T> = {
    promise,
    controller,
    settled: false,
    waiters: 0,
    sleeping,
    sleepListeners,
  }
  workRef = work
  const onSettled = () => {
    work.settled = true
    setSleeping(false)
    sleepListeners.clear()
  }
  promise.then(onSettled, onSettled)
  return work
}

export function waitForSharedPortalWork<T>(work: SharedPortalWork<T>, signal = getPortalRequestSignal()): Promise<T> {
  if (signal?.aborted) {
    if (work.waiters === 0 && !work.settled) work.controller.abort()
    return Promise.reject(new RequestCancelledError())
  }

  const callerPauser = toolAdmissionPauserStorage.getStore()
  work.waiters += 1

  return new Promise<T>((resolve, reject) => {
    let waiting = true
    let countedAsSleeping = false

    const onSharedSleepChange = (isSleeping: boolean) => {
      if (!waiting || !callerPauser) return
      if (isSleeping && !countedAsSleeping) {
        countedAsSleeping = true
        callerPauser.sleepingFetches += 1
        maybeSuspendToolAdmission(callerPauser)
      } else if (!isSleeping && countedAsSleeping) {
        countedAsSleeping = false
        callerPauser.sleepingFetches = Math.max(0, callerPauser.sleepingFetches - 1)
      }
    }

    if (callerPauser) {
      callerPauser.activeFetches += 1
      work.sleepListeners.add(onSharedSleepChange)
      if (work.sleeping) {
        onSharedSleepChange(true)
      }
    }

    const leave = (cancelWhenIdle: boolean, allowSuspend: boolean) => {
      if (!waiting) return
      waiting = false
      signal?.removeEventListener('abort', cancel)
      if (callerPauser) {
        work.sleepListeners.delete(onSharedSleepChange)
        if (countedAsSleeping) {
          countedAsSleeping = false
          callerPauser.sleepingFetches = Math.max(0, callerPauser.sleepingFetches - 1)
        }
        callerPauser.activeFetches = Math.max(0, callerPauser.activeFetches - 1)
        if (allowSuspend) {
          maybeSuspendToolAdmission(callerPauser)
        }
      }
      work.waiters = Math.max(0, work.waiters - 1)
      if (cancelWhenIdle && work.waiters === 0 && !work.settled) {
        work.controller.abort()
      }
    }
    const cancel = () => {
      leave(true, true)
      reject(new RequestCancelledError())
    }

    signal?.addEventListener('abort', cancel, { once: true })
    work.promise.then(
      (value) => {
        if (!waiting) return
        leave(false, false)
        if (!callerPauser?.paused) {
          resolve(value)
          return
        }
        ensureToolAdmissionResumed(callerPauser, signal).then(
          () => resolve(value),
          (error) => reject(error),
        )
      },
      (error) => {
        if (!waiting) return
        leave(false, true)
        reject(error)
      },
    )
  })
}

export function createRequestAbortContext(timeout: number): RequestAbortContext {
  const controller = new AbortController()
  const requestSignal = getPortalRequestSignal()
  let timedOut = false
  let cancelled = false

  const cancelFromRequest = () => {
    cancelled = true
    controller.abort()
  }

  if (requestSignal?.aborted) {
    cancelFromRequest()
  } else {
    requestSignal?.addEventListener('abort', cancelFromRequest, { once: true })
  }

  const timeoutId = setTimeout(() => {
    if (controller.signal.aborted) return
    timedOut = true
    controller.abort()
  }, timeout)

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    wasCancelled: () => cancelled,
    cleanup: () => {
      clearTimeout(timeoutId)
      requestSignal?.removeEventListener('abort', cancelFromRequest)
    },
  }
}

/**
 * Bound a multi-request operation with one wall-clock deadline while preserving
 * the distinction between an MCP client cancellation and an internal timeout.
 */
export async function runWithPortalRequestDeadline<T>(
  timeout: number,
  callback: () => Promise<T>,
  context?: Record<string, unknown>,
): Promise<T> {
  const outerDeadline = getPortalRequestDeadlineAt()
  const now = Date.now()
  const deadlineAt = Math.min(now + timeout, outerDeadline ?? Number.POSITIVE_INFINITY)
  const effectiveTimeout = Math.max(1, deadlineAt - now)
  const abortContext = createRequestAbortContext(effectiveTimeout)

  try {
    return await requestDeadlineStorage.run(deadlineAt, () => runWithPortalRequestSignal(abortContext.signal, callback))
  } catch (error) {
    if (abortContext.wasCancelled()) throw new RequestCancelledError()
    if (abortContext.didTimeout() && (abortContext.signal.aborted || isAbortLike(error))) {
      throw createTimeoutError(timeout, context)
    }
    throw error
  } finally {
    abortContext.cleanup()
  }
}

export function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return error.name === 'AbortError' || message.includes('abort')
}
