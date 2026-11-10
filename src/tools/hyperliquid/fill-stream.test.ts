import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'

import { ActionableError } from '../../helpers/errors.js'
import { visitHyperliquidFillBlocks } from './fill-stream.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

it('does not count delivered fills again when a large chunk is split', async () => {
  let calls = 0
  const deliveredBlocks: number[] = []
  let totalFills = 0
  globalThis.fetch = async () => {
    calls++
    if (calls !== 1) {
      return new Response('{"header":{"number":1},"fills":[{}]}\n')
    }
    let reads = 0
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (reads++ === 0) {
            controller.enqueue(new TextEncoder().encode('{"header":{"number":1},"fills":[{}]}\n'))
          } else if (reads === 2) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ padding: 'x'.repeat(100) })}\n`))
          } else controller.close()
        },
      }),
    )
  }

  await assert.rejects(
    visitHyperliquidFillBlocks({
      dataset: 'hyperliquid-fills',
      fromBlock: 1,
      toBlock: 2,
      initialChunkSize: 2,
      minChunkSize: 1,
      maxBytes: 80,
      fillFilter: {},
      fillFields: {},
      onBlock: (block) => {
        if (block.header) deliveredBlocks.push(block.header.number ?? 0)
        totalFills += block.fills?.length ?? 0
      },
    }),
    (error: unknown) => error instanceof ActionableError && error.code === 'incomplete_result',
  )
  assert.equal(calls, 1)
  assert.deepEqual(deliveredBlocks, [1])
  assert.equal(totalFills, 1)
})
