import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { RequestCancelledError } from '../helpers/errors.js'
import { resetPortalRateLimitState } from '../helpers/fetch.js'
import { runWithPortalRequestSignal } from '../helpers/request-context.js'
import { clearDatasetCaches, getBlockHead, getDatasetMetadata, getDatasets, pickDataset } from './datasets.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  clearDatasetCaches()
  resetPortalRateLimitState()
})

/*
 * Resolve exact network names and aliases without substring substitutions.
 * In particular, `opbnb` must not resolve to Optimism through the alias `op`.
 */
const DATASETS = [
  'ethereum-mainnet',
  'ethereum-sepolia',
  'optimism-mainnet',
  'opbnb-mainnet',
  'base-mainnet',
  'base-sepolia',
  'bitcoin-mainnet',
  'solana-mainnet',
  'binance-mainnet',
  'arbitrum-one',
  'moonbeam-substrate',
  'worldchain-mainnet',
  'hyperliquid-mainnet',
  'polkadot',
].map((dataset) => ({ dataset, aliases: [] as string[] }))

const pick = (name: string) => pickDataset(name, DATASETS)

describe('a name never resolves to a different chain', () => {
  it('sends opbnb to opBNB, not to Optimism', () => {
    assert.equal(pick('opbnb'), 'opbnb-mainnet')
    assert.equal(pick('opbnb-mainnet'), 'opbnb-mainnet')
    assert.equal(pick('op'), 'optimism-mainnet')
  })

  it('refuses a testnet it does not have instead of answering with mainnet', () => {
    for (const name of ['ethereum-holesky', 'btc-testnet', 'solana-devnet', 'bitcoin-testnet']) {
      assert.equal(pick(name), undefined, `${name} must not resolve to a mainnet`)
    }
  })

  it('refuses an empty or blank name, which used to match every alias', () => {
    assert.equal(pick(''), undefined)
    assert.equal(pick('   '), undefined)
  })

  it('does not let one chain name swallow another that contains it', () => {
    assert.equal(pick('binance'), 'binance-mainnet')
    assert.equal(pick('bnb'), 'binance-mainnet')
    assert.equal(pick('world'), 'worldchain-mainnet')
    assert.equal(pick('hyper'), 'hyperliquid-mainnet')
  })
})

describe('the names people do use still work', () => {
  it('takes exact dataset names', () => {
    assert.equal(pick('base-mainnet'), 'base-mainnet')
    assert.equal(pick('BASE-MAINNET'), 'base-mainnet')
    assert.equal(pick('polkadot'), 'polkadot')
  })

  it('takes the short nicknames', () => {
    assert.equal(pick('eth'), 'ethereum-mainnet')
    assert.equal(pick('ethereum'), 'ethereum-mainnet')
    assert.equal(pick('btc'), 'bitcoin-mainnet')
    assert.equal(pick('sol'), 'solana-mainnet')
    assert.equal(pick('arb'), 'arbitrum-one')
  })

  it('completes a bare chain name to its mainnet', () => {
    assert.equal(pick('base'), 'base-mainnet')
    assert.equal(pick('worldchain'), 'worldchain-mainnet')
  })

  it('still finds a real testnet the Portal actually carries', () => {
    assert.equal(pick('ethereum-sepolia'), 'ethereum-sepolia')
    assert.equal(pick('base-sepolia'), 'base-sepolia')
  })

  it('prefers a declared alias over any guess', () => {
    const withAlias = [{ dataset: 'some-chain-mainnet', aliases: ['nickname'] }]
    assert.equal(pickDataset('nickname', withAlias), 'some-chain-mainnet')
  })

  it('prefers mainnet when a suffix match is ambiguous', () => {
    assert.equal(pick('substrate'), 'moonbeam-substrate')
    assert.equal(pick('sepolia'), 'ethereum-sepolia')
  })
})

describe('dataset cache deduplication and resilience', () => {
  it('shares an in-flight head request across distinct MCP request signals without cross-cancelling', async () => {
    let headCalls = 0
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/head')) {
        headCalls++
        await new Promise((resolve) => setTimeout(resolve, 30))
        return Response.json({ number: 500, hash: '0xabc' })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }

    const first = new AbortController()
    const second = new AbortController()
    const firstPromise = runWithPortalRequestSignal(first.signal, () => getBlockHead('base-mainnet'))
    const secondPromise = runWithPortalRequestSignal(second.signal, () => getBlockHead('base-mainnet'))
    first.abort()

    await assert.rejects(firstPromise, RequestCancelledError)
    const head = await secondPromise
    assert.deepEqual(head, { number: 500, hash: '0xabc' })
    assert.equal(headCalls, 1)
  })

  it('skips finalized-head unless requested and caches start_block across head refreshes', async () => {
    const requestedUrls: string[] = []
    globalThis.fetch = async (input) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.endsWith('/metadata')) return Response.json({ start_block: 10 })
      if (url.endsWith('/head')) return Response.json({ number: 1_000, hash: '0x1' })
      if (url.endsWith('/finalized-head')) return Response.json({ number: 990, hash: '0x2' })
      throw new Error(`Unexpected URL: ${url}`)
    }

    const basic = await getDatasetMetadata('ethereum-mainnet')
    assert.equal(basic.start_block, 10)
    assert.equal(basic.head.number, 1_000)
    assert.equal(basic.finalized_head, undefined)
    assert.equal(
      requestedUrls.some((url) => url.endsWith('/finalized-head')),
      false,
    )

    const withFinalized = await getDatasetMetadata('ethereum-mainnet', { includeFinalized: true })
    assert.equal(withFinalized.finalized_head?.number, 990)
    assert.equal(requestedUrls.filter((url) => url.endsWith('/metadata')).length, 1)
    assert.equal(requestedUrls.filter((url) => url.endsWith('/finalized-head')).length, 1)
  })

  it('serves the stale dataset catalog when a refresh hits a transient upstream failure', async (t) => {
    let now = 1_000_000
    t.mock.method(Date, 'now', () => now)
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      if (calls === 1) {
        return Response.json([
          { dataset: 'base-mainnet', aliases: ['base'], real_time: true, metadata: { kind: 'evm' } },
        ])
      }
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } })
    }

    const fresh = await getDatasets()
    assert.equal(fresh.length, 1)
    assert.equal(calls, 1)

    // Advance past the 5-minute catalog TTL; refresh fails with oversized Retry-After -> stale fallback.
    now += 6 * 60 * 1_000
    const stale = await getDatasets()
    assert.equal(stale[0]?.dataset, 'base-mainnet')
    assert.equal(calls, 2)

    // Within the refresh cooldown, subsequent callers reuse the stale catalog without hitting Portal.
    const duringCooldown = await getDatasets()
    assert.equal(duringCooldown[0]?.dataset, 'base-mainnet')
    assert.equal(calls, 2)
  })

  it('fetches live head when fresh:true is requested while keeping start_block cached and preserving finalized_head', async () => {
    let headNumber = 1_000
    let metadataCalls = 0
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/metadata')) {
        metadataCalls++
        return Response.json({ start_block: 0 })
      }
      if (url.endsWith('/head')) return Response.json({ number: headNumber, hash: `0x${headNumber}` })
      if (url.endsWith('/finalized-head')) return Response.json({ number: headNumber - 10, hash: '0xf' })
      throw new Error(`Unexpected URL: ${url}`)
    }

    const first = await getDatasetMetadata('base-mainnet', { includeFinalized: true, fresh: true })
    assert.equal(first.head.number, 1_000)
    assert.equal(first.finalized_head?.number, 990)

    headNumber = 1_050
    const second = await getDatasetMetadata('base-mainnet', { includeFinalized: true, fresh: true })
    assert.equal(second.head.number, 1_050)
    assert.equal(second.finalized_head?.number, 1_040)
    assert.equal(metadataCalls, 1, 'start_block should stay cached across fresh head reads')
  })

  it('starts fresh work instead of inheriting cancellation when an earlier sole waiter already aborted', async () => {
    let calls = 0
    let firstFetchStarted!: () => void
    const firstFetchReady = new Promise<void>((resolve) => {
      firstFetchStarted = resolve
    })
    globalThis.fetch = async (_input, init) => {
      calls++
      if (calls === 1) {
        firstFetchStarted()
        return await new Promise<Response>((_resolve, reject) => {
          const onAbort = () => setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 20)
          if (init?.signal?.aborted) onAbort()
          else init?.signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      return Response.json({ number: 777, hash: '0xfresh' })
    }

    const first = new AbortController()
    const firstPromise = runWithPortalRequestSignal(first.signal, () => getBlockHead('arbitrum-one'))
    await firstFetchReady
    first.abort()
    await assert.rejects(firstPromise, RequestCancelledError)

    // Immediately start a second caller before the aborted promise settles
    const head = await getBlockHead('arbitrum-one')
    assert.deepEqual(head, { number: 777, hash: '0xfresh' })
    assert.equal(calls, 2)
  })
})
