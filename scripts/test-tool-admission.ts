#!/usr/bin/env tsx

import { RequestCancelledError } from '../src/helpers/errors.js'
import { ActionableError } from '../src/helpers/errors.ts'
import {
  getPortalRequestSignal,
  runAsSharedPortalWork,
  runWhilePortalBackoffSleep,
  runWithPortalRequestSignal,
  runWithToolAdmissionLease,
  waitForSharedPortalWork,
  withPortalFetchAdmissionTracking,
} from '../src/helpers/request-context.js'
import {
  DEFAULT_TOOL_WEIGHT_BUDGET,
  WeightedToolAdmissionController,
  getToolWorkProfile,
} from '../src/helpers/tool-admission.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const controller = new WeightedToolAdmissionController(24, 3, 80, false)
  const lookup = getToolWorkProfile('portal_get_head')
  const raw = getToolWorkProfile('portal_evm_query_transactions')
  const analytics = getToolWorkProfile('portal_hyperliquid_get_analytics')
  const wallet = getToolWorkProfile('portal_get_wallet_summary')
  assert(lookup.weight === 1 && raw.weight === 12 && analytics.weight === 16, 'tool cost classes should stay explicit')
  assert(wallet.class === 'summary' && wallet.weight === 16, 'wallet scans should admit at most two concurrent calls')
  assert(
    DEFAULT_TOOL_WEIGHT_BUDGET / wallet.weight === 2,
    'the default scheduler budget must cap concurrent complete wallet investigations at two',
  )
  assert(
    DEFAULT_TOOL_WEIGHT_BUDGET / analytics.weight === 2,
    'the default scheduler budget must cap concurrent analytics at the measured memory-safe level',
  )

  const first = await controller.acquire(raw, 'stdio')
  const second = await controller.acquire(raw, 'http')
  assert(controller.snapshot().activeWeight === 24, 'two raw calls should fill the test budget')

  const order: string[] = []
  const expensive = controller.acquire(analytics, 'http').then((lease) => {
    order.push('analytics')
    return lease
  })
  const cheap = controller.acquire(lookup, 'stdio').then((lease) => {
    order.push('lookup')
    return lease
  })
  await sleep(5)
  first.release()
  const cheapLease = await cheap
  assert(order[0] === 'lookup', 'a fitting lookup should bypass a temporarily blocked analytics call')
  cheapLease.release()
  second.release()
  const expensiveLease = await expensive
  assert(order[1] === 'analytics', 'the older analytics call should run as soon as enough weight is free')
  expensiveLease.release()
  assert(
    controller.snapshot().activeWeight === 0 && controller.snapshot().queuedCalls === 0,
    'all capacity should return to zero',
  )

  const blocker = await controller.acquire(raw, 'stdio')
  const secondBlocker = await controller.acquire(raw, 'http')
  const cancellation = new AbortController()
  const cancelled = controller.acquire(lookup, 'http', cancellation.signal).then(
    () => false,
    (error) => error instanceof Error && /cancel/i.test(error.message),
  )
  cancellation.abort()
  assert(await cancelled, 'queued cancellation should reject with a cancellation outcome')
  blocker.release()
  secondBlocker.release()
  assert(
    controller.snapshot().activeWeight === 0 && controller.snapshot().queuedCalls === 0,
    'cancelled work must not leak queue or weight',
  )

  const fullController = new WeightedToolAdmissionController(1, 1, 25, false)
  const fullLease = await fullController.acquire(lookup, 'stdio')
  const timeout = fullController.acquire(lookup, 'stdio').then(
    () => false,
    (error) => error instanceof Error && /busy|bounded wait/i.test(error.message),
  )
  await sleep(2)
  const queueFull = await fullController.acquire(lookup, 'http').then(
    () => false,
    (error) => error instanceof Error && /busy|bounded wait/i.test(error.message),
  )
  assert(queueFull, 'a full queue should fail quickly with the structured overload source error')
  assert(await timeout, 'a queued call should fail inside its bounded wait budget')
  fullLease.release()
  assert(
    fullController.snapshot().activeWeight === 0 && fullController.snapshot().queuedCalls === 0,
    'timeout recovery should restore scheduler state',
  )

  const firstCaller = new AbortController()
  const secondCaller = new AbortController()
  let resolveShared!: (value: string) => void
  let sharedSignal: AbortSignal | undefined
  const shared = runWithPortalRequestSignal(firstCaller.signal, () =>
    runAsSharedPortalWork(
      () =>
        new Promise<string>((resolve) => {
          sharedSignal = getPortalRequestSignal()
          assert(
            sharedSignal !== undefined && sharedSignal !== firstCaller.signal,
            'shared work should use an independent cancellation signal',
          )
          resolveShared = resolve
        }),
    ),
  )
  const firstWait = runWithPortalRequestSignal(firstCaller.signal, () => waitForSharedPortalWork(shared))
  const secondWait = runWithPortalRequestSignal(secondCaller.signal, () => waitForSharedPortalWork(shared))
  firstCaller.abort()
  const firstCancelled = await firstWait.then(
    () => false,
    (error) => error instanceof RequestCancelledError,
  )
  assert(sharedSignal?.aborted === false, 'shared work should continue while another caller is waiting')
  resolveShared('shared result')
  assert(firstCancelled, 'one cancelled caller should stop waiting for shared work')
  assert((await secondWait) === 'shared result', 'another caller should still receive the shared result')

  const finalCaller = new AbortController()
  let sharedAbortObserved = false
  const abandoned = runAsSharedPortalWork(
    () =>
      new Promise<string>((_resolve, reject) => {
        const signal = getPortalRequestSignal()
        assert(signal !== undefined, 'shared work should expose its cancellation signal upstream')
        signal.addEventListener(
          'abort',
          () => {
            sharedAbortObserved = true
            reject(new RequestCancelledError())
          },
          { once: true },
        )
      }),
  )
  const abandonedWait = waitForSharedPortalWork(abandoned, finalCaller.signal)
  finalCaller.abort()
  const finalCancelled = await abandonedWait.then(
    () => false,
    (error) => error instanceof RequestCancelledError,
  )
  assert(finalCancelled, 'the final cancelled caller should stop waiting for shared work')
  assert(sharedAbortObserved, 'shared upstream work should abort when its last caller leaves')

  /* Two callers: one floods raw queries, one keeps doing cheap lookups. The
     flooder is bounded to its share; the quiet caller never waits. */
  const fair = new WeightedToolAdmissionController(32, 16, 2_000, false, { clientWeightShare: 0.5, maxClientQueued: 2 })
  assert(fair.maxClientWeight === 16 && fair.maxClientQueued === 2, 'client share should derive from the global budget')
  const flooder = { key: 'openai:flood', family: 'openai' }
  const quiet = { key: 'claude:quiet', family: 'claude' }
  const floodFirst = await fair.acquire(raw, 'http', undefined, flooder)
  const floodSecond = fair.acquire(raw, 'http', undefined, flooder)
  const floodThird = fair.acquire(raw, 'http', undefined, flooder)
  await sleep(5)
  assert(
    fair.snapshot().activeWeight === 12 && fair.snapshot().queuedCalls === 2,
    'the flooder holds one raw call and queues two',
  )
  let shareRejection: unknown
  try {
    await fair.acquire(raw, 'http', undefined, flooder)
  } catch (error) {
    shareRejection = error
  }
  assert(
    shareRejection instanceof ActionableError &&
      shareRejection.code === 'overloaded' &&
      shareRejection.retryable &&
      (shareRejection.context as Record<string, unknown>)?.reason === 'client_share',
    'a caller over its queue share gets the structured overloaded result with reason client_share',
  )
  const quietStarted = Date.now()
  const quietLookup = await fair.acquire(lookup, 'http', undefined, quiet)
  const quietSummary = await fair.acquire(getToolWorkProfile('portal_get_recent_activity'), 'http', undefined, quiet)
  assert(
    Date.now() - quietStarted < 50 && quietLookup.waitMs < 50,
    'the quiet caller is admitted immediately while the flooder is queued',
  )
  assert(fair.snapshot().activeWeight === 21, 'global capacity serves both callers inside their shares')
  assert(
    fair.snapshot().activeCallsByFamily.openai === 1 && fair.snapshot().activeCallsByFamily.claude === 2,
    'active calls are tracked per bounded family',
  )
  floodFirst.release()
  const floodSecondLease = await floodSecond
  assert(fair.snapshot().queuedCalls === 1, 'releasing the flooder promotes its next call and keeps the third queued')
  floodSecondLease.release()
  const floodThirdLease = await floodThird
  floodThirdLease.release()
  quietLookup.release()
  quietSummary.release()
  assert(
    fair.snapshot().activeWeight === 0 &&
      fair.snapshot().queuedCalls === 0 &&
      Object.keys(fair.snapshot().activeCallsByFamily).length === 0,
    'fairness accounting returns to zero',
  )
  const solo = { key: 'unknown:stdio', family: 'unknown', exempt: true }
  const soloFirst = await fair.acquire(analytics, 'stdio', undefined, solo)
  const soloSecond = await fair.acquire(analytics, 'stdio', undefined, solo)
  assert(
    fair.snapshot().activeWeight === 32 && fair.snapshot().activeCallsByFamily.unknown === 2,
    'an exempt stdio caller may use the whole budget and is still counted',
  )
  soloFirst.release()
  soloSecond.release()
  const floored = new WeightedToolAdmissionController(32, 4, 100, false, { clientWeightShare: 0.1 })
  assert(
    floored.maxClientWeight === 16,
    'a share below the heaviest profile is floored so every tool stays schedulable',
  )

  /* When a caller's active call sleeps on upstream backoff, yielding its slot
     lets another call from the same HTTP caller run immediately instead of
     timing out with overloaded, then re-acquires cleanly on wakeup. */
  const yielder = new WeightedToolAdmissionController(32, 16, 150, false, { clientWeightShare: 0.5 })
  const httpCaller = { key: 'claude:backoff', family: 'claude' }
  const sleepingLease = await yielder.acquire(raw, 'http', undefined, httpCaller)
  let siblingRanDuringSleep = false
  let resumedBeforeSiblingDone = false
  const sleepingWork = runWithToolAdmissionLease(sleepingLease, () =>
    withPortalFetchAdmissionTracking(async () => {
      await runWhilePortalBackoffSleep(async () => {
        const siblingLease = await yielder.acquire(raw, 'http', undefined, httpCaller)
        siblingRanDuringSleep = true
        await sleep(30)
        siblingLease.release()
      })
      resumedBeforeSiblingDone = !siblingRanDuringSleep
    }),
  )
  await sleepingWork
  sleepingLease.release()
  assert(siblingRanDuringSleep, 'a sibling call from the same HTTP caller should run while the first call sleeps')
  assert(!resumedBeforeSiblingDone, 'resumed call should wait for capacity and run cleanly')
  assert(
    yielder.snapshot().activeWeight === 0 &&
      yielder.snapshot().activeCalls === 0 &&
      yielder.snapshot().queuedCalls === 0,
    'suspend/resume accounting should return to zero',
  )

  // Tools waiting on a shared lookup that enters backoff sleep must also yield
  // their admission slots so unrelated lookups do not starve with overloaded.
  let releaseSharedBackoff!: () => void
  const sharedBackoffGate = new Promise<void>((resolve) => {
    releaseSharedBackoff = resolve
  })
  const sharedLookup = runAsSharedPortalWork(async () =>
    withPortalFetchAdmissionTracking(async () => {
      await runWhilePortalBackoffSleep(() => sharedBackoffGate)
      return 'head-ok'
    }),
  )
  const waitingHeavy = await yielder.acquire(analytics, 'http', undefined, httpCaller)
  const waitingPromise = runWithToolAdmissionLease(waitingHeavy, () => waitForSharedPortalWork(sharedLookup))
  await sleep(10)
  assert(
    yielder.snapshot().activeWeight === 0,
    'a tool waiting on sleeping shared work should yield its weighted admission slot',
  )
  const unrelatedLookup = await yielder.acquire(lookup, 'http', undefined, httpCaller)
  assert(unrelatedLookup.waitMs < 50, 'unrelated lookups should run immediately while shared work sleeps')
  unrelatedLookup.release()
  releaseSharedBackoff()
  assert((await waitingPromise) === 'head-ok', 'waiting tool should resume and receive the shared lookup value')
  waitingHeavy.release()
  assert(
    yielder.snapshot().activeWeight === 0 &&
      yielder.snapshot().activeCalls === 0 &&
      yielder.snapshot().queuedCalls === 0,
    'shared-work backoff yield accounting should return to zero',
  )

  // Releasing a lease while suspended must not double-decrement active weight
  const releaseSuspended = await yielder.acquire(raw, 'http', undefined, httpCaller)
  releaseSuspended.suspend()
  releaseSuspended.release()
  assert(
    yielder.snapshot().activeWeight === 0 && yielder.snapshot().activeCalls === 0,
    'releasing a suspended lease must keep accounting exact',
  )

  console.log('PASS  weighted profiles preserve capacity for low-cost discovery')
  console.log('PASS  fair promotion avoids head-of-line blocking without starving analytics')
  console.log('PASS  queued cancellation, timeout, and overload release all scheduler state')
  console.log('PASS  shared analytics work stays live for active callers and aborts when abandoned')
  console.log(
    'PASS  a flooding caller is bounded to its share with reason client_share while a quiet caller never waits',
  )
  console.log('PASS  backoff sleeps yield tool admission slots so parallel HTTP calls do not starve')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
