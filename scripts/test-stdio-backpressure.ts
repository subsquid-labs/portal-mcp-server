#!/usr/bin/env tsx

import { Readable, Writable } from 'node:stream'

import { SerializedStdioServerTransport } from '../src/helpers/serialized-stdio-transport.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

class SlowWritable extends Writable {
  constructor() {
    super({ highWaterMark: 1 })
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    setTimeout(callback, 5)
  }
}

async function main() {
  const input = new Readable({ read() {} })
  const output = new SlowWritable()
  const transport = new SerializedStdioServerTransport(input, output)
  const errors: Error[] = []
  transport.onerror = (error) => errors.push(error)
  await transport.start()

  let maxErrorListeners = 0
  let maxDrainListeners = 0
  const sampler = setInterval(() => {
    maxErrorListeners = Math.max(maxErrorListeners, output.listenerCount('error'))
    maxDrainListeners = Math.max(maxDrainListeners, output.listenerCount('drain'))
  }, 1)

  try {
    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        transport.send({
          jsonrpc: '2.0',
          id: index,
          result: { payload: 'x'.repeat(16_384) },
        }),
      ),
    )
  } finally {
    clearInterval(sampler)
    await transport.close()
  }

  assert(maxErrorListeners <= 2, `serialized writes should keep error listeners bounded, observed ${maxErrorListeners}`)
  assert(maxDrainListeners <= 1, `serialized writes should keep drain listeners bounded, observed ${maxDrainListeners}`)
  assert(output.listenerCount('drain') === 0, 'completed writes should remove every drain listener')

  output.emit('error', new Error('late stdout write failure'))
  assert(errors.length === 0, 'a late stdout error should not reach a closed transport')
  const replacement = new SerializedStdioServerTransport(new Readable({ read() {} }), output)
  await replacement.start()
  try {
    assert(output.listenerCount('error') === 1, 'reusing stdout should leave only the active error listener')
  } finally {
    await replacement.close()
  }
  console.log('PASS  stdio writes stay serialized and listener-bounded through backpressure and shutdown')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
