import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { ActionableError } from './errors.js'
import { portalFetchStream, portalFetchStreamVisit } from './fetch.js'

const originalFetch = globalThis.fetch
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = originalFetch
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
