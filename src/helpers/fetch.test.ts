import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { portalRetriesTotal } from '../metrics.js'
import { ActionableError, RequestCancelledError, parsePortalError, wrapError } from './errors.js'
import {
  MAX_RETRY_DELAY_MS,
  MAX_RETRY_WALL_CLOCK_MS,
  MAX_SHARED_COOLDOWN_MS,
  computeRetryAttemptTimeoutMs,
  computeRetryDelayMs,
  getOriginCooldownRemainingMs,
  parseRetryAfterMs,
  portalFetch,
  portalFetchStream,
  portalFetchStreamRangeVisit,
  portalFetchStreamVisit,
  rateLimitBucketKey,
  resetPortalRateLimitState,
} from './fetch.js'
import { runWithPortalRequestDeadline, runWithPortalRequestSignal } from './request-context.js'
import { PortalStreamError, StreamRecoveryBudget, getStreamRangeRecovery } from './stream-progress.js'

const originalFetch = globalThis.fetch
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = originalFetch
  resetPortalRateLimitState()
})

function interruptedResponse(): Response {
  let reads = 0
  return new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (reads++ === 0) controller.enqueue(encoder.encode('{"number":1}\n'))
          else controller.error(new Error('terminated'))
        },
      },
      { highWaterMark: 0 },
    ),
  )
}

describe('Portal stream integrity', () => {
  it('does not replay visitor side effects after an interrupted stream', async () => {
    let calls = 0
    const visited: unknown[] = []
    globalThis.fetch = async () => {
      calls++
      return calls === 1 ? interruptedResponse() : new Response('{"number":1}\n{"number":2}\n')
    }

    await assert.rejects(
      portalFetchStreamVisit(
        'https://portal.example/stream',
        {},
        {
          retries: 1,
          onRecord: (record) => {
            visited.push(record)
          },
        },
      ),
      (error: unknown) => error instanceof ActionableError && error.code === 'incomplete_result',
    )
    assert.equal(calls, 1)
    assert.deepEqual(visited, [{ number: 1 }])
  })

  it('keeps retries before a visitor has received a record', async () => {
    let calls = 0
    const visited: unknown[] = []
    globalThis.fetch = async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response('{"number":1}\n')
    }
    const count = await portalFetchStreamVisit(
      'https://portal.example/stream',
      {},
      {
        retries: 1,
        onRecord: (record) => {
          visited.push(record)
        },
      },
    )
    assert.equal(calls, 2)
    assert.equal(count, 1)
    assert.deepEqual(visited, [{ number: 1 }])
  })

  it('refuses oversized response chunks before an early row limit can return success', async () => {
    const payload = '{"number":1}\n{"padding":"xxxxxxxxxxxxxxxxxxxx"}\n'
    globalThis.fetch = async () => new Response(payload)
    await assert.rejects(
      portalFetchStream('https://portal.example/stream', {}, { maxBytes: 20, maxBlocks: 1, retries: 0 }),
      (error: unknown) => error instanceof ActionableError && error.code === 'response_too_large',
    )
    const visited: unknown[] = []
    await assert.rejects(
      portalFetchStreamVisit(
        'https://portal.example/stream',
        {},
        {
          maxBytes: 20,
          maxBlocks: 1,
          retries: 0,
          onRecord: (record) => {
            visited.push(record)
          },
        },
      ),
      (error: unknown) => error instanceof ActionableError && error.code === 'response_too_large',
    )
    assert.deepEqual(visited, [])
  })

  it('enforces the byte limit when the response has no readable stream', async () => {
    globalThis.fetch = async () => {
      const response = new Response('{"number":1}\n{"padding":"xxxxxxxxxxxxxxxxxxxx"}\n')
      Object.defineProperty(response, 'body', { value: null })
      return response
    }
    await assert.rejects(
      portalFetchStream('https://portal.example/stream', {}, { maxBytes: 20, retries: 0 }),
      (error: unknown) => error instanceof ActionableError && error.code === 'response_too_large',
    )
    const visited: unknown[] = []
    await assert.rejects(
      portalFetchStreamVisit(
        'https://portal.example/stream',
        {},
        {
          maxBytes: 20,
          retries: 0,
          onRecord: (record) => {
            visited.push(record)
          },
        },
      ),
      (error: unknown) => error instanceof ActionableError && error.code === 'response_too_large',
    )
    assert.deepEqual(visited, [])
  })

  it('cancels a readable response when parsing fails', async () => {
    let cancelled = 0
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('invalid-json\n'))
          },
          cancel() {
            cancelled++
          },
        }),
      )
    await assert.rejects(portalFetchStream('https://portal.example/stream', {}, { retries: 0 }))
    await assert.rejects(
      portalFetchStreamVisit(
        'https://portal.example/stream',
        {},
        {
          retries: 0,
          onRecord: () => undefined,
        },
      ),
    )
    assert.equal(cancelled, 2)
  })

  it('marks a size failure after delivered records as incomplete instead of retrying smaller chunks', async () => {
    let reads = 0
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(encoder.encode('{"number":1}\n'))
            else if (reads === 2) controller.enqueue(encoder.encode('{"padding":"xxxxxxxxxxxxxxxxxxxx"}\n'))
            else controller.close()
          },
        }),
      )
    const visited: unknown[] = []
    await assert.rejects(
      portalFetchStreamVisit(
        'https://portal.example/stream',
        {},
        {
          maxBytes: 20,
          retries: 0,
          onRecord: (record) => {
            visited.push(record)
          },
        },
      ),
      (error: unknown) =>
        error instanceof ActionableError &&
        error.code === 'incomplete_result' &&
        !error.retryable &&
        !error.message.includes('Response too large'),
    )
    assert.deepEqual(visited, [{ number: 1 }])
  })
})

describe('Portal visitor failure checkpoints', () => {
  it('keeps a timeout after delivery non-retryable and preserves its cause', async () => {
    const visited: unknown[] = []
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('{"number":1}\n'))
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
          },
        }),
      )
    }
    await assert.rejects(
      portalFetchStreamVisit(
        'https://portal.example/stream',
        {},
        {
          timeout: 30,
          retries: 0,
          onRecord: (record) => {
            visited.push(record)
          },
        },
      ),
      (error: unknown) => {
        assert(error instanceof PortalStreamError)
        assert.equal(error.code, 'incomplete_result')
        assert.equal(error.retryable, false)
        assert.equal(error.reason, 'upstream_timeout')
        assert.equal(error.deliveredRecords, 1)
        assert.equal(error.lastDeliveredBlock, 1)
        assert(error.cause instanceof ActionableError)
        assert.equal(error.cause.code, 'upstream_timeout')
        return true
      },
    )
    assert.equal(calls, 1)
    assert.deepEqual(visited, [{ number: 1 }])
  })

  it('preserves a throwing visitor and never offers its block as a resume checkpoint', async () => {
    const failure = new Error('visitor calculation failed')
    globalThis.fetch = async () => new Response('{"number":1}\n{"number":2}\n')
    await assert.rejects(
      portalFetchStreamVisit(
        'https://portal.example/stream',
        {},
        {
          retries: 1,
          onRecord: () => {
            throw failure
          },
        },
      ),
      (error: unknown) => {
        assert(error instanceof PortalStreamError)
        assert.equal(error.cause, failure)
        assert.equal(error.reason, 'visitor_error')
        assert.equal(error.origin, 'server')
        assert.equal(error.deliveredRecords, 1)
        assert.equal(error.lastDeliveredBlock, undefined)
        return true
      },
    )
  })

  it('carries prior delivery across a failed range continuation', async () => {
    const visited: unknown[] = []
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return calls === 1 ? new Response('{"number":1}\n') : new Response('{"padding":"xxxxxxxxxxxxxxxxxxxxxxxx"}\n')
    }
    await assert.rejects(
      portalFetchStreamRangeVisit(
        'https://portal.example/stream',
        { fromBlock: 1, toBlock: 3 },
        {
          maxBytes: 20,
          retries: 0,
          onRecord: (record) => {
            visited.push(record)
          },
        },
      ),
      (error: unknown) => {
        assert(error instanceof PortalStreamError)
        assert.equal(error.code, 'incomplete_result')
        assert.equal(error.reason, 'response_too_large')
        assert.equal(error.deliveredRecords, 1)
        assert.equal(error.lastDeliveredBlock, 1)
        return true
      },
    )
    assert.equal(calls, 2)
    assert.deepEqual(visited, [{ number: 1 }])
  })
})

it('refuses recovery when delivered blocks lack a trustworthy ordered checkpoint', async () => {
  for (const records of [
    [{ number: 1 }, { number: 1 }],
    [{ value: 1 }],
    [{ number: 2 }, { number: 1 }],
    [{ number: 4 }],
  ]) {
    let reads = 0
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (reads++ === 0)
                controller.enqueue(encoder.encode(records.map((record) => JSON.stringify(record)).join('\n') + '\n'))
              else controller.enqueue(encoder.encode('x'.repeat(100)))
            },
          },
          { highWaterMark: 0 },
        ),
      )
    await assert.rejects(
      portalFetchStreamRangeVisit(
        'https://portal.example/stream',
        { fromBlock: 1, toBlock: 3 },
        {
          maxBytes: 80,
          retries: 0,
          onRecord: () => undefined,
        },
      ),
      (error: unknown) => {
        assert.equal(getStreamRangeRecovery(error, 1, 3, { budget: new StreamRecoveryBudget() }), undefined)
        return true
      },
    )
  }
})

it('limits the elapsed recovery period across subranges', (t) => {
  let now = 1_000
  t.mock.method(Date, 'now', () => now)
  const budget = new StreamRecoveryBudget()
  const error = new ActionableError('Request timeout', [], undefined, { code: 'upstream_timeout' })
  assert.deepEqual(getStreamRangeRecovery(error, 1, 10, { budget, allowTimeout: true }), {
    fromBlock: 1,
    deliveredRecords: 0,
  })
  now += 30_000
  assert.equal(getStreamRangeRecovery(error, 5, 10, { budget, allowTimeout: true }), undefined)
})

describe('Portal exponential retry and rate-limit handling', () => {
  it('parses numeric and HTTP-date Retry-After headers', () => {
    const now = Date.parse('Wed, 25 Nov 2026 14:20:00 GMT')
    assert.equal(parseRetryAfterMs(undefined, now), undefined)
    assert.equal(parseRetryAfterMs('   ', now), undefined)
    assert.equal(parseRetryAfterMs('invalid-header', now), undefined)
    assert.equal(parseRetryAfterMs('-5', now), undefined)
    assert.equal(parseRetryAfterMs('0', now), 0)
    assert.equal(parseRetryAfterMs('2.5', now), 2_500)
    assert.equal(parseRetryAfterMs('Wed, 25 Nov 2026 14:20:04 GMT', now), 4_000)
    assert.equal(parseRetryAfterMs('Wed, 25 Nov 2026 14:19:50 GMT', now), 0)
  })

  it('uses equal-jitter exponential backoff and honors Retry-After hints', () => {
    const now = Date.parse('Wed, 25 Nov 2026 14:20:00 GMT')

    // Equal jitter spans [cap/2, cap] across attempts up to MAX_RETRY_DELAY_MS
    assert.equal(
      computeRetryDelayMs(0, undefined, () => 0),
      500,
    )
    assert.equal(
      computeRetryDelayMs(0, undefined, () => 0.999_999),
      1_000,
    )
    assert.equal(
      computeRetryDelayMs(1, undefined, () => 0),
      1_000,
    )
    assert.equal(
      computeRetryDelayMs(1, undefined, () => 0.999_999),
      2_000,
    )
    assert.equal(
      computeRetryDelayMs(2, undefined, () => 0),
      2_000,
    )
    assert.equal(
      computeRetryDelayMs(2, undefined, () => 0.999_999),
      4_000,
    )
    assert.equal(
      computeRetryDelayMs(3, undefined, () => 0),
      4_000,
    )
    assert.equal(
      computeRetryDelayMs(3, undefined, () => 0.999_999),
      8_000,
    )
    assert.equal(
      computeRetryDelayMs(4, undefined, () => 0),
      MAX_RETRY_DELAY_MS / 2,
    )
    assert.equal(
      computeRetryDelayMs(4, undefined, () => 0.999_999),
      MAX_RETRY_DELAY_MS,
    )

    // Explicit Retry-After seconds, HTTP-date, and numeric ms hints keep jitter >= hint
    assert.equal(
      computeRetryDelayMs(0, '3', () => 0, now),
      3_000,
    )
    assert.equal(
      computeRetryDelayMs(0, 'Wed, 25 Nov 2026 14:20:03 GMT', () => 0.5, now),
      3_500,
    )
    assert.equal(
      computeRetryDelayMs(0, 5_000, () => 0.25, now),
      5_250,
    )

    // Repeated attempts with a tiny Retry-After still back off exponentially
    assert.equal(
      computeRetryDelayMs(2, '0', () => 0, now),
      2_000,
    )
    assert.equal(
      computeRetryDelayMs(3, '1', () => 0, now),
      4_000,
    )
  })

  it('caps retry attempt timeouts to the shared wall-clock budget', () => {
    assert.equal(computeRetryAttemptTimeoutMs(60_000, 5, 1_000, 1_000), MAX_RETRY_WALL_CLOCK_MS)
    assert.equal(computeRetryAttemptTimeoutMs(60_000, 5, 1_000, 1_000 + MAX_RETRY_WALL_CLOCK_MS - 3_000), 3_000)
    assert.equal(computeRetryAttemptTimeoutMs(60_000, 5, 1_000, 1_000 + MAX_RETRY_WALL_CLOCK_MS + 1_000), 0)
    assert.equal(computeRetryAttemptTimeoutMs(60_000, 0, 1_000, 1_000 + MAX_RETRY_WALL_CLOCK_MS + 1_000), 60_000)
  })

  it('recovers across multiple 429, 529, 5xx, 408, and transient socket errors within the exponential retry budget', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const scenarios: Array<{
      name: string
      failures: Array<() => Response | Promise<Response>>
    }> = [
      {
        name: 'repeated 429 without Retry-After',
        failures: Array.from({ length: 4 }, () => () => new Response('too many requests', { status: 429 })),
      },
      {
        name: '429 with HTTP-date Retry-After',
        failures: [
          () =>
            new Response('busy', {
              status: 429,
              headers: { 'Retry-After': new Date(Date.now() + 2_000).toUTCString() },
            }),
        ],
      },
      {
        name: '529 overload followed by 502 and 503 with Retry-After',
        failures: [
          () => new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 529 }),
          () => new Response('bad gateway', { status: 502 }),
          () => new Response('worker rotating', { status: 503, headers: { 'Retry-After': '1' } }),
        ],
      },
      {
        name: '408 timeout and ECONNRESET socket failure',
        failures: [
          () => new Response('request timeout', { status: 408 }),
          async () => {
            throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
          },
        ],
      },
    ]

    for (const scenario of scenarios) {
      resetPortalRateLimitState()
      let calls = 0
      globalThis.fetch = async () => {
        const failure = scenario.failures[calls++]
        if (failure) return await failure()
        return Response.json({ recovered: scenario.name })
      }

      const pending = portalFetch<{ recovered: string }>('https://portal.example/datasets/eth/head', { retries: 5 })
      let settled = false
      pending.finally(() => {
        settled = true
      })
      for (let step = 0; step < 40 && !settled; step++) {
        await Promise.resolve()
        await new Promise((resolve) => setImmediate(resolve))
        if (!settled) t.mock.timers.tick(1_000)
      }

      const result = await pending
      assert.equal(result.recovered, scenario.name)
      assert.equal(calls, scenario.failures.length + 1)
    }

    const retryMetric = await portalRetriesTotal.get()
    assert.ok(retryMetric.values.some((entry) => entry.labels.reason === 'rate_limited' && entry.value > 0))
    assert.ok(retryMetric.values.some((entry) => entry.labels.reason === 'server_error' && entry.value > 0))
  })

  it('recovers portalFetchStream and portalFetchStreamVisit from 429 and 5xx before delivery', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    let streamCalls = 0
    globalThis.fetch = async () => {
      streamCalls++
      if (streamCalls === 1) return new Response('rate limited', { status: 429 })
      if (streamCalls === 2) return new Response('gateway error', { status: 502 })
      return new Response('{"number":42}\n')
    }

    const streamPending = portalFetchStream('https://portal.example/datasets/base-mainnet/stream', {}, { retries: 4 })
    let streamDone = false
    streamPending.finally(() => {
      streamDone = true
    })
    for (let step = 0; step < 20 && !streamDone; step++) {
      await new Promise((resolve) => setImmediate(resolve))
      if (!streamDone) t.mock.timers.tick(1_000)
    }
    assert.deepEqual(await streamPending, [{ number: 42 }])
    assert.equal(streamCalls, 3)

    let visitCalls = 0
    const visited: unknown[] = []
    globalThis.fetch = async () => {
      visitCalls++
      if (visitCalls === 1) return new Response('overloaded', { status: 529 })
      if (visitCalls === 2) return new Response('temporarily unavailable', { status: 503 })
      return new Response('{"number":7}\n')
    }

    const visitPending = portalFetchStreamVisit(
      'https://portal.example/datasets/base-mainnet/stream',
      {},
      {
        retries: 4,
        onRecord: (record) => {
          visited.push(record)
        },
      },
    )
    let visitDone = false
    visitPending.finally(() => {
      visitDone = true
    })
    for (let step = 0; step < 20 && !visitDone; step++) {
      await new Promise((resolve) => setImmediate(resolve))
      if (!visitDone) t.mock.timers.tick(1_000)
    }
    assert.equal(await visitPending, 1)
    assert.deepEqual(visited, [{ number: 7 }])
    assert.equal(visitCalls, 3)
  })

  it('fails immediately without sleeping when Retry-After exceeds the retry wall-clock budget', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response('too many requests', { status: 429, headers: { 'Retry-After': '120' } })
    }

    const startedAt = Date.now()
    await assert.rejects(
      portalFetch('https://portal.example/datasets/base-mainnet/head', { retries: 5 }),
      (error: unknown) =>
        error instanceof ActionableError &&
        error.code === 'rate_limited' &&
        error.retryable &&
        error.retryAfterMs === 120_000,
    )
    assert.equal(calls, 1)
    assert.ok(Date.now() - startedAt < 500)
    // Shared cooldown is clamped to MAX_SHARED_COOLDOWN_MS rather than freezing for 120s.
    assert.ok(
      getOriginCooldownRemainingMs('https://portal.example/datasets/base-mainnet/head') <= MAX_SHARED_COOLDOWN_MS,
    )
  })

  it('paces subsequent retryable callers behind a shared origin rate-limit cooldown and lets retries:0 probe immediately', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const requestTimestamps: number[] = []
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      requestTimestamps.push(Date.now())
      if (calls === 1) {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } })
      }
      return Response.json({ ok: true, call: calls })
    }

    // Trigger cooldown on origin via a single-attempt request
    await assert.rejects(
      portalFetch('https://cooldown.example/datasets/eth/head', { retries: 0 }),
      (error: unknown) => error instanceof ActionableError && error.code === 'rate_limited',
    )
    assert.ok(getOriginCooldownRemainingMs('https://cooldown.example/datasets/eth/head') >= 1_900)

    // A retries:0 probe still runs immediately without waiting for the cooldown
    const probe = await portalFetch<{ ok: boolean; call: number }>('https://cooldown.example/datasets/eth/head', {
      retries: 0,
    })
    assert.equal(probe.ok, true)
    assert.equal(requestTimestamps[1] - requestTimestamps[0], 0)

    // Trigger another 2s cooldown, then verify a retryable caller waits behind it
    calls = 0
    requestTimestamps.length = 0
    await assert.rejects(
      portalFetch('https://cooldown.example/datasets/eth/head', { retries: 0 }),
      (error: unknown) => error instanceof ActionableError && error.code === 'rate_limited',
    )

    const queued = portalFetch<{ ok: boolean; call: number }>('https://cooldown.example/datasets/eth/head', {
      retries: 2,
    })
    let done = false
    queued.finally(() => {
      done = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requestTimestamps.length, 1, 'second caller should wait for cooldown before fetching')

    for (let step = 0; step < 5 && !done; step++) {
      t.mock.timers.tick(1_000)
      await new Promise((resolve) => setImmediate(resolve))
    }
    const result = await queued
    assert.equal(result.ok, true)
    assert.ok(requestTimestamps[1] - requestTimestamps[0] >= 2_000)
    assert.equal(getOriginCooldownRemainingMs('https://cooldown.example/datasets/eth/head'), 0)
  })

  it('aborts immediately when cancelled during a shared origin rate-limit cooldown', async () => {
    globalThis.fetch = async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '5' } })
    await assert.rejects(portalFetch('https://cancel-cooldown.example/datasets/eth/head', { retries: 0 }))

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    const startedAt = Date.now()
    await assert.rejects(
      runWithPortalRequestSignal(controller.signal, () =>
        portalFetch('https://cancel-cooldown.example/datasets/eth/head', { retries: 2 }),
      ),
      RequestCancelledError,
    )
    assert.ok(Date.now() - startedAt < 500)
  })

  it('throws upstream_timeout immediately in portalFetchStreamVisit when timing out before delivery', async () => {
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
          },
        }),
      )
    }

    await assert.rejects(
      portalFetchStreamVisit(
        'https://portal.example/stream',
        {},
        {
          timeout: 30,
          retries: 3,
          onRecord: () => undefined,
        },
      ),
      (error: unknown) => error instanceof ActionableError && error.code === 'upstream_timeout',
    )
    assert.equal(calls, 1)
  })

  it('scopes shared 429 cooldowns by dataset and endpoint class and keeps 529 per-request', async () => {
    assert.equal(
      rateLimitBucketKey('https://portal.example/datasets/base-mainnet/stream'),
      'https://portal.example/datasets/base-mainnet/stream',
    )
    assert.equal(
      rateLimitBucketKey('https://portal.example/datasets/base-mainnet/head'),
      'https://portal.example/datasets/base-mainnet/meta',
    )
    assert.equal(
      rateLimitBucketKey('https://portal.example/datasets/base-mainnet/timestamps/1700/block'),
      'https://portal.example/datasets/base-mainnet/timestamps',
    )
    assert.equal(
      rateLimitBucketKey('https://portal.example/datasets?expand[]=metadata'),
      'https://portal.example/datasets',
    )

    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/base-mainnet/stream')) {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '10' } })
      }
      return Response.json({ ok: true })
    }

    await assert.rejects(
      portalFetchStream('https://portal.example/datasets/base-mainnet/stream', {}, { retries: 0 }),
      (error: unknown) => error instanceof ActionableError && error.code === 'rate_limited',
    )
    assert.ok(getOriginCooldownRemainingMs('https://portal.example/datasets/base-mainnet/stream') >= 9_000)
    assert.equal(getOriginCooldownRemainingMs('https://portal.example/datasets/base-mainnet/head'), 0)
    assert.equal(getOriginCooldownRemainingMs('https://portal.example/datasets/solana-mainnet/stream'), 0)

    const startedAt = Date.now()
    const head = await portalFetch<{ ok: boolean }>('https://portal.example/datasets/base-mainnet/head', { retries: 2 })
    assert.equal(head.ok, true)
    assert.ok(Date.now() - startedAt < 500, 'head lookup must not stall on a stream cooldown')

    // A 529 overload honors Retry-After per request without stalling sibling
    // requests on the same dataset behind a 10s shared cooldown.
    resetPortalRateLimitState()
    let streamCalls = 0
    globalThis.fetch = async () => {
      streamCalls++
      if (streamCalls === 1) {
        return new Response('overloaded', { status: 529, headers: { 'Retry-After': '10' } })
      }
      return new Response('{"number":1}\n')
    }
    await assert.rejects(
      portalFetchStream('https://portal.example/datasets/base-mainnet/stream', {}, { retries: 0 }),
      (error: unknown) =>
        error instanceof ActionableError && error.code === 'rate_limited' && error.retryAfterMs === 10_000,
    )
    assert.equal(getOriginCooldownRemainingMs('https://portal.example/datasets/base-mainnet/stream'), 0)
    const siblingStartedAt = Date.now()
    const sibling = await portalFetchStream('https://portal.example/datasets/base-mainnet/stream', {}, { retries: 2 })
    assert.deepEqual(sibling, [{ number: 1 }])
    assert.ok(Date.now() - siblingStartedAt < 500, 'sibling stream request must not stall behind a 529')
  })

  it('stops retrying immediately with rate_limited instead of sleeping into an enclosing tool deadline', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response('overloaded', { status: 529, headers: { 'Retry-After': '10' } })
    }

    const startedAt = Date.now()
    await assert.rejects(
      runWithPortalRequestDeadline(3_000, () =>
        portalFetch('https://deadline.example/datasets/base-mainnet/stream', { retries: 4 }),
      ),
      (error: unknown) =>
        error instanceof ActionableError && error.code === 'rate_limited' && error.retryAfterMs === 10_000,
    )
    assert.equal(calls, 1)
    assert.ok(Date.now() - startedAt < 500)
  })

  it('does not retry 501, 505, or permanent undici DNS/unreachable errors and preserves malformed-stream guidance on terminated reads', async () => {
    assert.equal(parsePortalError(501, 'not implemented').retryable, false)
    assert.equal(parsePortalError(505, 'unsupported version').retryable, false)

    for (const code of ['ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH']) {
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error(`network failure ${code}`), { code }),
        })
      }
      await assert.rejects(
        portalFetch('https://portal.invalid/datasets/eth/head', { retries: 5 }),
        (error: unknown) => error instanceof ActionableError && !error.retryable,
      )
      assert.equal(calls, 1, `${code} must fail immediately without retries`)
    }

    const terminated = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })
    const wrappedTerminated = wrapError(terminated, { url: 'https://portal.example/stream' })
    assert.ok(wrappedTerminated instanceof ActionableError)
    assert.match(wrappedTerminated.summary, /incomplete or malformed data stream/i)
    assert.ok(wrappedTerminated.suggestions.some((suggestion) => /Do not treat any rows/i.test(suggestion)))
  })

  it('cancels oversized non-OK error response bodies after reading the bounded preview', async () => {
    let chunksPulled = 0
    let cancelled = false
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            chunksPulled++
            controller.enqueue(encoder.encode('x'.repeat(2_048)))
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 400 },
      )

    await assert.rejects(
      portalFetch('https://portal.example/datasets/eth/head', { retries: 0 }),
      (error: unknown) => error instanceof ActionableError && error.code === 'invalid_request',
    )
    assert.equal(cancelled, true)
    assert.ok(chunksPulled <= 3, `should stop pulling chunks once error preview cap is reached, pulled ${chunksPulled}`)
  })
})
