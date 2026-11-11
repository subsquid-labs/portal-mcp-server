import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parsePortalError } from '../src/helpers/errors.js'
import { fetchPortalText, retryPortalProbe } from './live-portal-probe.js'

function testClock() {
  let now = Date.parse('2026-01-01T00:00:00Z')
  const delays: number[] = []
  return {
    delays,
    now: () => now,
    wait: async (delay: number) => {
      delays.push(delay)
      now += delay
    },
  }
}

test('timestamp boundary probes honor Portal overload delay before checking exact evidence', async () => {
  const clock = testClock()
  const overload = parsePortalError(529, 'service is overloaded')
  let calls = 0
  const timestamp = await retryPortalProbe(
    'Polkadot direct boundary',
    async () => {
      if (++calls === 1) throw overload
      return 1_760_000_000
    },
    { clock },
  )
  assert.deepEqual(clock.delays, [5_000])
  assert.equal(calls, 2)
  assert.equal(timestamp, 1_760_000_000)
})

test('rate limit exhaustion throws the original error within the attempt limit', async () => {
  const clock = testClock()
  const overload = parsePortalError(529, 'service is overloaded')
  let calls = 0
  await assert.rejects(
    retryPortalProbe(
      'overloaded boundary',
      async () => {
        calls += 1
        throw overload
      },
      { clock },
    ),
    (error) => error === overload,
  )
  assert.equal(calls, 4)
  assert.deepEqual(clock.delays, [5_000, 5_000, 6_000])
})

test('a retry hint beyond the budget fails without waiting or retrying early', async () => {
  const clock = testClock()
  const limited = Object.assign(new Error('wait'), {
    code: 'rate_limited',
    origin: 'upstream',
    retryable: true,
    retryAfterMs: 120_000,
  })
  let calls = 0
  await assert.rejects(
    retryPortalProbe(
      'long cooldown',
      async () => {
        calls += 1
        throw limited
      },
      { clock },
    ),
    (error) => error === limited,
  )
  assert.equal(calls, 1)
  assert.deepEqual(clock.delays, [])
})

test('assertions and explicitly nonretryable failures are never retried', async () => {
  for (const error of [
    new assert.AssertionError({ message: 'timestamp must match' }),
    Object.assign(new Error('rate limited text with invalid query'), {
      code: 'invalid_request',
      origin: 'upstream',
      retryable: false,
    }),
  ]) {
    const clock = testClock()
    let calls = 0
    await assert.rejects(
      retryPortalProbe(
        'invalid evidence',
        async () => {
          calls += 1
          throw error
        },
        { clock },
      ),
      (caught) => caught === error,
    )
    assert.equal(calls, 1)
    assert.deepEqual(clock.delays, [])
  }
})

test('HTTP parity probes honor numeric and date Retry-After and return the full reference body', async (t) => {
  for (const retryAfter of ['7', 'Thu, 01 Jan 2026 00:00:07 GMT']) {
    const clock = testClock()
    let calls = 0
    const requests: RequestInit[] = []
    const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init: RequestInit) => {
      requests.push(init)
      if (++calls === 1) return new Response('busy', { status: 429, headers: { 'Retry-After': retryAfter } })
      return new Response('{"header":{"number":42},"events":[{"id":"exact"}]}\n')
    })
    const init = { method: 'POST', body: '{"fromBlock":42,"toBlock":42}' }
    const text = await fetchPortalText('exact reference', 'https://portal.example/datasets/test/stream', init, {
      clock,
    })
    assert.deepEqual(clock.delays, [7_000])
    assert.equal(calls, 2)
    assert.deepEqual(
      requests.map((request) => request.body),
      [init.body, init.body],
    )
    assert.deepEqual(JSON.parse(text).events, [{ id: 'exact' }])
    fetchMock.mock.restore()
  }
})

test('successful transport does not hide a reference-data mismatch', async (t) => {
  const clock = testClock()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return new Response('busy', { status: 529 })
    return new Response('{"timestamp":12}')
  })
  const text = await fetchPortalText('boundary mismatch', 'https://portal.example/stream', {}, { clock })
  assert.throws(() => assert.equal(JSON.parse(text).timestamp, 13), assert.AssertionError)
  assert.equal(calls, 2)
  assert.deepEqual(clock.delays, [5_000])
})

test('HTTP validation errors fail immediately and retain the response diagnostic', async (t) => {
  const clock = testClock()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return new Response('invalid fields', { status: 400 })
  })
  await assert.rejects(
    fetchPortalText('bad query', 'https://portal.example/stream', {}, { clock }),
    /HTTP 400: invalid fields/,
  )
  assert.equal(calls, 1)
  assert.deepEqual(clock.delays, [])
})

test('a failed response body is discarded before retrying the independent reference', async (t) => {
  const clock = testClock()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls > 1) return new Response('{"id":"exact"}\n')
    let delivered = false
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (!delivered) {
            delivered = true
            controller.enqueue(new TextEncoder().encode('{"id":"partial"}\n'))
          } else {
            controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }))
          }
        },
      }),
    )
  })
  const text = await fetchPortalText('interrupted reference', 'https://portal.example/stream', {}, { clock })
  assert.deepEqual(
    text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [{ id: 'exact' }],
  )
  assert.equal(calls, 2)
  assert.deepEqual(clock.delays, [1_500])
})

test('persistent HTTP rate limits fail with the final status and response body', async (t) => {
  const clock = testClock()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return new Response('capacity exhausted', { status: 429, headers: { 'Retry-After': '5' } })
  })
  await assert.rejects(
    fetchPortalText('persistent limit', 'https://portal.example/stream', {}, { clock }),
    /HTTP 429: capacity exhausted/,
  )
  assert.equal(calls, 4)
  assert.deepEqual(clock.delays, [5_000, 5_000, 6_000])
})
