#!/usr/bin/env tsx

import { createServer } from 'node:http'
import type { Socket } from 'node:net'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { InMemoryTransport } from '@modelcontextprotocol/server'

import { createQueryCache } from '../src/cache/query-cache.js'
import { AdmissionController } from '../src/helpers/admission.js'
import { scanBoundedBlockRange } from '../src/helpers/bounded-search.js'
import { ActionableError, RequestCancelledError, parsePortalError } from '../src/helpers/errors.js'
import { fetchExternalJson, getCoinGeckoTokenListWithStatus } from '../src/helpers/external-apis.js'
import {
  computeRetryAttemptTimeoutMs,
  computeRetryDelayMs,
  portalFetch,
  portalFetchRecentRecords,
  portalFetchStream,
  portalFetchStreamVisit,
  sleep,
} from '../src/helpers/fetch.js'
import { formatResult } from '../src/helpers/format.js'
import { registerPortalTool } from '../src/helpers/mcp-registration.js'
import { runWithPortalRequestSignal } from '../src/helpers/request-context.js'
import { PortalStreamError } from '../src/helpers/stream-progress.js'
import { toolCallsTotal, toolErrorsTotal, toolOutcomesTotal } from '../src/metrics.js'
import { createPortalServer } from '../src/server.js'
import { fetchAdaptiveTransactionRange } from '../src/tools/evm/query-transactions.js'
import { type ToolCallResult, isBoundedUpstreamToolError } from './test-helpers.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

async function expectFastFailure(
  label: string,
  action: () => Promise<unknown>,
  validate: (error: unknown) => void,
  maxElapsedMs = 1_000,
) {
  const startedAt = Date.now()
  try {
    await action()
    throw new Error(`${label} unexpectedly succeeded`)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} unexpectedly succeeded`) throw error
    validate(error)
  }
  const elapsedMs = Date.now() - startedAt
  assert(elapsedMs < maxElapsedMs, `${label} should fail within ${maxElapsedMs}ms, took ${elapsedMs}ms`)
  console.log(`PASS  ${label} [${elapsedMs}ms]`)
}

async function main() {
  const boundedResult = (code: string, origin: string, retryable = true): ToolCallResult => ({
    result: {},
    text: JSON.stringify({ error: { code, origin, retryable } }),
    structuredContent: { error: { code, origin, retryable } },
    isError: true,
    elapsedMs: 1,
    attempts: 1,
  })
  for (const code of [
    'incomplete_result',
    'upstream_reorg',
    'rate_limited',
    'upstream_unavailable',
    'upstream_timeout',
    'upstream_error',
  ]) {
    assert(
      isBoundedUpstreamToolError(boundedResult(code, 'upstream')),
      `${code} should be recognized as a bounded upstream tool error`,
    )
  }
  assert(
    isBoundedUpstreamToolError(boundedResult('overloaded', 'server')),
    'server overload should be recognized as a bounded tool error',
  )
  assert(
    !isBoundedUpstreamToolError(boundedResult('upstream_unavailable', 'upstream', false)),
    'non-retryable upstream failures should not be treated as bounded transient errors',
  )
  for (const [code, origin] of [
    ['invalid_cursor', 'client_input'],
    ['internal_error', 'server'],
    ['upstream_timeout', 'upstream'],
  ]) {
    assert(
      !isBoundedUpstreamToolError({
        ...boundedResult(code, origin, false),
        text: 'Portal server error (529) while using a continuation cursor',
      }),
      `explicit non-retryable ${code} must take precedence over transient-looking error text`,
    )
  }
  assert(
    !isBoundedUpstreamToolError(boundedResult('internal_error', 'server')),
    'internal server errors should not be treated as bounded upstream errors',
  )
  console.log('PASS  structured retryable errors are classified without relying on display text')

  const portalOverload = parsePortalError(
    529,
    JSON.stringify({ error: { type: 'rate_limit_error', code: 'overloaded', message: 'service is overloaded' } }),
  )
  assert(
    portalOverload.code === 'rate_limited' &&
      portalOverload.origin === 'upstream' &&
      portalOverload.retryable &&
      portalOverload.retryAfterMs === 5_000,
    'Portal 529 overloads should expose bounded rate-limit retry guidance',
  )
  console.log('PASS  Portal 529 overloads expose structured retry guidance')

  const originalFetch = globalThis.fetch
  try {
    let retryCalls = 0
    globalThis.fetch = (async () => {
      retryCalls += 1
      if (retryCalls === 1) {
        throw new ActionableError('CoinGecko API timed out after 5000ms', [], undefined, {
          code: 'upstream_timeout',
          origin: 'upstream',
          retryable: true,
        })
      }
      return new Response(
        JSON.stringify({
          name: 'Base test tokens',
          tokens: [
            {
              chainId: 8453,
              address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
              name: 'USD Coin',
              symbol: 'USDC',
              decimals: 6,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    const recoveredTokenList = await getCoinGeckoTokenListWithStatus('base')
    assert(retryCalls === 2, `token-list cold start should retry once, observed ${retryCalls} calls`)
    assert(recoveredTokenList.tokens[0]?.symbol === 'USDC', 'token-list retry should return the recovered payload')

    let sharedRetryCalls = 0
    globalThis.fetch = (async () => {
      sharedRetryCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (sharedRetryCalls === 1) {
        throw new ActionableError('CoinGecko API timed out after 5000ms', [], undefined, {
          code: 'upstream_timeout',
          origin: 'upstream',
          retryable: true,
        })
      }
      return new Response(
        JSON.stringify({
          name: 'Polygon test tokens',
          tokens: [
            {
              chainId: 137,
              address: '0x0000000000000000000000000000000000001010',
              name: 'POL',
              symbol: 'POL',
              decimals: 18,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    const sharedTokenLists = await Promise.all(
      Array.from({ length: 8 }, () => getCoinGeckoTokenListWithStatus('polygon')),
    )
    assert(
      sharedRetryCalls === 2,
      `eight token-list callers should share one retry sequence, observed ${sharedRetryCalls} calls`,
    )
    assert(
      sharedTokenLists.every((result) => result.tokens[0]?.symbol === 'POL'),
      'all token-list waiters should receive the same recovered payload',
    )

    let cancelledCalls = 0
    globalThis.fetch = (async () => {
      cancelledCalls += 1
      throw new RequestCancelledError()
    }) as typeof fetch
    try {
      await getCoinGeckoTokenListWithStatus('arbitrum')
      throw new Error('cancelled token-list fetch unexpectedly succeeded')
    } catch (error) {
      assert(error instanceof RequestCancelledError, 'token-list cancellation should remain a cancellation')
    }
    assert(cancelledCalls === 1, `token-list cancellation must not retry, observed ${cancelledCalls} calls`)
    console.log('PASS  token-list cold starts share one retry sequence while cancellation stays immediate')
  } finally {
    globalThis.fetch = originalFetch
  }

  let activeScans = 0
  let maxActiveScans = 0
  const scanResult = await scanBoundedBlockRange({
    fromBlock: 1,
    toBlock: 50,
    chunkSize: 10,
    concurrency: 3,
    scanOrder: 'latest',
    fetchChunk: async () => {
      activeScans += 1
      maxActiveScans = Math.max(maxActiveScans, activeScans)
      await new Promise((resolve) => setTimeout(resolve, 20))
      activeScans -= 1
      return []
    },
  })
  assert(maxActiveScans === 3, `bounded reverse scan should use concurrency 3, observed ${maxActiveScans}`)
  assert(scanResult.scannedBlocks === 50 && scanResult.exhaustedWindow, 'bounded reverse scan should cover its window')
  console.log('PASS  bounded reverse scans preserve coverage while fetching ordered batches concurrently')

  const splitCalls: string[] = []
  const splitRows = await fetchAdaptiveTransactionRange(1, 4, async (fromBlock, toBlock) => {
    splitCalls.push(`${fromBlock}-${toBlock}`)
    if ((fromBlock === 1 && toBlock === 4) || (fromBlock === 1 && toBlock === 2)) {
      throw new Error('Response too large (>50MB). Add filters or reduce block range.')
    }
    return Array.from({ length: toBlock - fromBlock + 1 }, (_, index) => fromBlock + index)
  })
  assert(
    JSON.stringify(splitCalls) === JSON.stringify(['1-4', '1-2', '1-1', '2-2', '3-4']),
    `adaptive split should retry only bounded subranges, observed ${splitCalls.join(', ')}`,
  )
  assert(
    JSON.stringify(splitRows) === JSON.stringify([1, 2, 3, 4]),
    'adaptive split should preserve exact left-to-right membership without duplicates',
  )

  const terminalOversize = new Error('Response too large (>50MB). Add filters or reduce block range.')
  await expectFastFailure(
    'single-block transaction oversize fails closed',
    () => fetchAdaptiveTransactionRange(7, 7, async () => Promise.reject(terminalOversize)),
    (error) => assert(error === terminalOversize, 'single-block oversize should rethrow the original bounded failure'),
  )

  const splitCancellation = new AbortController()
  await expectFastFailure(
    'adaptive transaction split propagates cancellation',
    () =>
      fetchAdaptiveTransactionRange(1, 2, async (fromBlock, toBlock) => {
        if (fromBlock === 1 && toBlock === 2) {
          throw new Error('Response too large (>50MB). Add filters or reduce block range.')
        }
        if (fromBlock === 1) {
          splitCancellation.abort()
          return [1]
        }
        if (splitCancellation.signal.aborted) throw new RequestCancelledError()
        return [2]
      }),
    (error) => assert(error instanceof RequestCancelledError, 'adaptive split should preserve cancellation identity'),
  )
  console.log('PASS  adaptive transaction splitting is exact and fails closed')

  const admission = new AdmissionController(2, 1, 100)
  const releaseFirst = await admission.acquire()
  const releaseSecond = await admission.acquire()
  const queued = admission.acquire()
  await expectFastFailure(
    'full admission queue sheds excess work',
    () => admission.acquire(),
    (error) =>
      assert(
        error instanceof ActionableError && error.code === 'overloaded' && error.origin === 'server' && error.retryable,
        'full admission queue should return a retryable overload error',
      ),
  )
  releaseFirst()
  const releaseQueued = await queued
  releaseQueued()
  releaseSecond()
  assert(admission.snapshot().active === 0 && admission.snapshot().queued === 0, 'admission should return to zero')

  const cancellableAdmission = new AdmissionController(1, 1, 500)
  const releaseBlocking = await cancellableAdmission.acquire()
  const queuedCancellation = new AbortController()
  const cancelledAcquire = cancellableAdmission.acquire(queuedCancellation.signal)
  queuedCancellation.abort()
  await expectFastFailure(
    'queued admission observes MCP cancellation',
    () => cancelledAcquire,
    (error) => assert(error instanceof RequestCancelledError, 'queued admission should reject as cancellation'),
  )
  releaseBlocking()
  assert(
    cancellableAdmission.snapshot().active === 0 && cancellableAdmission.snapshot().queued === 0,
    'cancelled admission should release its queue entry',
  )

  const noHeaderDelays = Array.from({ length: 8 }, (_, index) => computeRetryDelayMs(2, undefined, () => index / 8))
  assert(new Set(noHeaderDelays).size === 8, 'retry jitter should de-correlate concurrent callers')
  const retryAfterDelays = Array.from({ length: 8 }, (_, index) => computeRetryDelayMs(0, '2', () => index / 8))
  assert(
    retryAfterDelays.every((delay) => delay >= 2_000),
    'retry jitter must not violate Retry-After',
  )
  assert(
    computeRetryAttemptTimeoutMs(30_000, 2, 1_000, 1_000) === 15_000,
    'retry-enabled requests should cap their first attempt to the total wall-clock budget',
  )
  assert(
    computeRetryAttemptTimeoutMs(30_000, 2, 1_000, 13_000) === 3_000,
    'later retry attempts should receive only the remaining wall-clock budget',
  )
  assert(
    computeRetryAttemptTimeoutMs(30_000, 2, 1_000, 16_000) === 0,
    'retry attempts should stop after the wall-clock budget is exhausted',
  )
  assert(
    computeRetryAttemptTimeoutMs(30_000, 0, 1_000, 16_000) === 30_000,
    'single-attempt callers should retain their explicit request timeout',
  )
  console.log('PASS  retry request attempts share one enforced 15-second wall-clock budget')

  try {
    formatResult(
      { items: Array.from({ length: 500 }, (_, index) => ({ index, value: 'x'.repeat(200) })) },
      'Oversized fixture',
      {
        toolName: 'portal_evm_query_transactions',
        pagination: { type: 'cursor', page_size: 500, returned: 500, has_more: false },
      },
    )
    throw new Error('oversized formatter fixture unexpectedly succeeded')
  } catch (error) {
    assert(
      error instanceof ActionableError &&
        error.code === 'response_too_large' &&
        error.retryable &&
        error.suggestions.some((suggestion) => suggestion.startsWith('Retry with limit: ')),
      'oversized formatter output should fail losslessly with exact limit guidance',
    )
  }

  const sockets = new Set<Socket>()
  let closedRequests = 0
  let activeRangeRequests = 0
  let maxActiveRangeRequests = 0
  let walletTokenRequests = 0
  const failureRequests = new Map<string, number>()
  const server = createServer((req, res) => {
    req.on('close', () => {
      closedRequests += 1
    })

    if (req.method === 'GET' && req.url?.startsWith('/datasets?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            dataset: 'base-mainnet',
            aliases: ['base'],
            metadata: { kind: 'evm', display_name: 'Base' },
            schema: { tables: {} },
          },
        ]),
      )
      return
    }

    if (req.method === 'GET' && req.url === '/datasets/base-mainnet/head') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ number: 1_000, hash: `0x${'1'.repeat(64)}` }))
      return
    }

    if (req.method === 'POST' && req.url === '/datasets/base-mainnet/stream') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const query = JSON.parse(body) as Record<string, unknown>
        if (Array.isArray(query.logs)) {
          walletTokenRequests += 1
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'temporary fixture failure' }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.end(
          `${JSON.stringify({
            header: { number: 1_000, timestamp: 1_775_000_000 },
            transactions: [
              {
                transactionIndex: 0,
                hash: `0x${'2'.repeat(64)}`,
                from: '0x1111111111111111111111111111111111111111',
                to: '0x2222222222222222222222222222222222222222',
                value: '0x0',
                status: 1,
              },
            ],
          })}\n`,
        )
      })
      return
    }

    if (req.url === '/range') {
      activeRangeRequests += 1
      maxActiveRangeRequests = Math.max(maxActiveRangeRequests, activeRangeRequests)
      setTimeout(() => {
        activeRangeRequests -= 1
        res.writeHead(204)
        res.end()
      }, 20)
      return
    }

    if (req.url === '/json-stall') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '2' })
      res.flushHeaders()
      return
    }

    if (req.url === '/truncated-stream') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.end('{"number":1}\n{"number":')
      return
    }

    if (req.url === '/early-eof') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Length': '200' })
      res.end('{"number":1}\n')
      return
    }

    if (req.url?.startsWith('/invalid-')) {
      failureRequests.set(req.url, (failureRequests.get(req.url) ?? 0) + 1)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid fixture request' }))
      return
    }

    if (req.url === '/rate-limit-final') {
      failureRequests.set(req.url, (failureRequests.get(req.url) ?? 0) + 1)
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '999' })
      res.end(JSON.stringify({ error: 'rate limited fixture' }))
      return
    }

    if (req.url === '/rate-limit-once') {
      const attempt = (failureRequests.get(req.url) ?? 0) + 1
      failureRequests.set(req.url, attempt)
      if (attempt === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' })
        res.end(JSON.stringify({ error: 'rate limited fixture' }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.flushHeaders()
    res.write('{"number":1}\n')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object', 'test server should expose a TCP address')
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const recentRecords = await portalFetchRecentRecords(
      `${baseUrl}/range`,
      { fromBlock: 1, toBlock: 50 },
      { itemKeys: ['logs'], limit: 1, chunkSize: 10, concurrency: 3, retries: 0 },
    )
    assert(recentRecords.length === 0, 'empty range fixtures should return no recent records')
    assert(
      maxActiveRangeRequests === 3,
      `recent record scanner should use concurrency 3, observed ${maxActiveRangeRequests}`,
    )
    console.log('PASS  recent record scans preserve reverse coverage with bounded concurrency')

    for (const [path, action] of [
      ['/invalid-json', () => portalFetch(`${baseUrl}/invalid-json`, { retries: 2 })],
      ['/invalid-stream', () => portalFetchStream(`${baseUrl}/invalid-stream`, {}, { retries: 2 })],
      [
        '/invalid-visit',
        () => portalFetchStreamVisit(`${baseUrl}/invalid-visit`, {}, { retries: 2, onRecord: () => undefined }),
      ],
    ] as const) {
      await expectFastFailure(
        `${path} fails without retry amplification`,
        action,
        (error) =>
          assert(
            error instanceof ActionableError &&
              error.code === 'invalid_request' &&
              error.origin === 'client_input' &&
              !error.retryable,
            `${path} should return a non-retryable client-input error`,
          ),
        500,
      )
      assert(failureRequests.get(path) === 1, `${path} should make exactly one upstream request`)
    }

    const rateLimitRecovery = await portalFetch<{ ok: boolean }>(`${baseUrl}/rate-limit-once`, { retries: 1 })
    assert(rateLimitRecovery.ok, 'rate-limited requests should recover within their retry budget')
    assert(failureRequests.get('/rate-limit-once') === 2, 'rate-limit recovery should use one bounded retry')
    await expectFastFailure(
      'final rate-limit attempt returns immediately with retry metadata',
      () => portalFetch(`${baseUrl}/rate-limit-final`, { retries: 0 }),
      (error) =>
        assert(
          error instanceof ActionableError &&
            error.code === 'rate_limited' &&
            error.origin === 'upstream' &&
            error.retryable &&
            error.retryAfterMs === 999_000,
          'final rate-limit failure should preserve bounded attribution and Retry-After guidance',
        ),
      500,
    )
    console.log('PASS  invalid requests fail once and retryable responses stay within the declared budget')

    await expectFastFailure(
      'regular fetch times out while reading a stalled body',
      () => portalFetch(`${baseUrl}/json-stall`, { timeout: 100, retries: 0 }),
      (error) =>
        assert(error instanceof Error && /Request timeout after 100ms/.test(error.message), 'expected timeout error'),
    )

    await expectFastFailure(
      'external enrichment times out while reading a stalled body',
      () => fetchExternalJson(`${baseUrl}/json-stall`, 'External test API', { timeout: 100 }),
      (error) =>
        assert(
          error instanceof Error && /External test API timed out after 100ms/.test(error.message),
          'expected external enrichment timeout error',
        ),
    )

    await expectFastFailure(
      'stream fetch times out while reading a stalled body',
      () => portalFetchStream(`${baseUrl}/stream-stall`, {}, { timeout: 100, retries: 0 }),
      (error) =>
        assert(error instanceof Error && /Request timeout after 100ms/.test(error.message), 'expected timeout error'),
    )

    let stalledVisitorRecords = 0
    await expectFastFailure(
      'stream visitor preserves a timeout after delivery without allowing replay',
      () =>
        portalFetchStreamVisit(
          `${baseUrl}/visit-stall`,
          {},
          {
            timeout: 100,
            retries: 0,
            onRecord: () => {
              stalledVisitorRecords++
            },
          },
        ),
      (error) => {
        assert(error instanceof PortalStreamError, 'expected a typed partial-delivery error')
        assert(error.code === 'incomplete_result' && !error.retryable, 'partial delivery must not retry the same range')
        assert(error.reason === 'upstream_timeout' && error.origin === 'upstream', 'timeout attribution should survive')
        assert(
          error.deliveredRecords === 1 && error.lastDeliveredBlock === 1,
          'completed block checkpoint should survive',
        )
        assert(
          error.cause instanceof ActionableError && error.cause.code === 'upstream_timeout',
          'original timeout cause should survive',
        )
      },
    )
    assert(stalledVisitorRecords === 1, 'stalled visitor must receive its record exactly once')

    for (const path of ['/truncated-stream', '/early-eof']) {
      await expectFastFailure(
        `${path} never becomes a complete result`,
        () => portalFetchStream(`${baseUrl}${path}`, {}, { timeout: 500, retries: 0 }),
        (error) =>
          assert(
            error instanceof ActionableError &&
              (error.code === 'upstream_error' || error.code === 'upstream_timeout') &&
              error.origin === 'upstream' &&
              error.retryable,
            `${path} should return a typed incomplete upstream error, got ${error instanceof Error ? error.message : String(error)}`,
          ),
      )
    }

    const cancellation = new AbortController()
    setTimeout(() => cancellation.abort(), 50)
    await expectFastFailure(
      'MCP cancellation aborts the active Portal stream',
      () =>
        runWithPortalRequestSignal(cancellation.signal, () =>
          portalFetchStream(`${baseUrl}/cancel-stall`, {}, { timeout: 5_000, retries: 0 }),
        ),
      (error) => assert(error instanceof RequestCancelledError, 'expected RequestCancelledError'),
      750,
    )

    const retryCancellation = new AbortController()
    setTimeout(() => retryCancellation.abort(), 50)
    await expectFastFailure(
      'MCP cancellation interrupts retry backoff',
      () => runWithPortalRequestSignal(retryCancellation.signal, () => sleep(5_000)),
      (error) => assert(error instanceof RequestCancelledError, 'expected RequestCancelledError'),
      750,
    )

    const queryCache = createQueryCache<string>({ ttl: 1_000 })
    const firstCacheRequest = new AbortController()
    const firstLoad = runWithPortalRequestSignal(firstCacheRequest.signal, () =>
      queryCache.getOrLoad('shared-key', async () => {
        await portalFetch(`${baseUrl}/json-stall`, { timeout: 5_000, retries: 0 })
        return 'first'
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const secondCacheRequest = new AbortController()
    const secondLoad = runWithPortalRequestSignal(secondCacheRequest.signal, () =>
      queryCache.getOrLoad('shared-key', async () => 'second'),
    )
    firstCacheRequest.abort()
    const firstCacheError = await firstLoad.catch((error) => error)
    const secondCacheResult = await secondLoad
    assert(firstCacheError instanceof RequestCancelledError, 'cancelled cache loader should fail its own request')
    assert(
      secondCacheResult.value === 'second',
      'unrelated request should not inherit another cache loader cancellation',
    )
    console.log('PASS  in-flight query cache cancellation is isolated between MCP requests')

    await new Promise((resolve) => setTimeout(resolve, 50))
    assert(closedRequests >= 5, `all stalled upstream requests should close, observed ${closedRequests}`)
    console.log('PASS  timed-out and cancelled upstream requests release their connections')

    const walletTransport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: { ...getDefaultEnvironment(), PORTAL_URL: baseUrl },
    })
    const walletClient = new Client({ name: 'wallet-partial-reliability-test', version: '1.0.0' })
    await walletClient.connect(walletTransport)
    try {
      const startedAt = Date.now()
      const result = await walletClient.callTool(
        {
          name: 'portal_get_wallet_summary',
          arguments: {
            network: 'base-mainnet',
            address: '0x1111111111111111111111111111111111111111',
            timeframe: '100',
            include_tokens: true,
            include_nfts: false,
            limit_per_type: 3,
          },
        },
        { timeout: 5_000 },
      )
      const elapsedMs = Date.now() - startedAt
      const data = result.structuredContent as Record<string, any> | undefined
      assert(!result.isError, 'wallet summary should return a partial success when one section fails')
      assert(data?.section_status?.transactions === 'available', 'transaction section should remain available')
      assert(
        data?.section_status?.token_transfers === 'unavailable',
        'failed token section should be marked unavailable',
      )
      assert(data?._coverage?.window_complete === false, 'partial wallet summary should mark its window incomplete')
      assert(
        walletTokenRequests === 1,
        `wallet section should not amplify retries, observed ${walletTokenRequests} calls`,
      )
      assert(elapsedMs < 3_000, `partial wallet response should stay interactive, took ${elapsedMs}ms`)
      console.log(
        `PASS  wallet section failures return bounded partial results without retry amplification [${elapsedMs}ms]`,
      )
    } finally {
      await walletClient.close()
    }

    const mcpServer = createPortalServer()
    registerPortalTool(mcpServer, '__test_cancel_portal_fetch', 'Cancellation propagation test.', {}, async () => {
      await portalFetchStream(`${baseUrl}/mcp-cancel-stall`, {}, { timeout: 5_000, retries: 0 })
      return { content: [{ type: 'text' as const, text: 'unexpected success' }] }
    })
    registerPortalTool(
      mcpServer,
      '__test_cancel_no_args',
      'No-argument cancellation propagation test.',
      {},
      async () => {
        await portalFetchStream(`${baseUrl}/mcp-no-args-cancel-stall`, {}, { timeout: 5_000, retries: 0 })
        return { content: [{ type: 'text' as const, text: 'unexpected success' }] }
      },
    )
    registerPortalTool(mcpServer, '__test_success_outcome', 'Complete outcome metric test.', {}, async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ value: 1 }) }],
      structuredContent: { value: 1 },
    }))
    registerPortalTool(mcpServer, '__test_partial_outcome', 'Partial outcome metric test.', {}, async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ value: 1, _coverage: { window_complete: false } }),
        },
      ],
      structuredContent: { value: 1, _coverage: { window_complete: false } },
    }))
    registerPortalTool(mcpServer, '__test_empty_outcome', 'Empty outcome metric test.', {}, async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ items: [] }) }],
      structuredContent: { items: [] },
    }))
    registerPortalTool(mcpServer, '__test_tool_error_outcome', 'Returned tool error metric test.', {}, async () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'Fixture tool error' }],
    }))
    registerPortalTool(mcpServer, '__test_request_error_outcome', 'Thrown request error metric test.', {}, async () => {
      throw new Error('Fixture request failure')
    })
    registerPortalTool(mcpServer, '__test_actionable_error_outcome', 'Actionable error metric test.', {}, async () => {
      throw new ActionableError('Fixture input is invalid.', ['Correct the fixture input.'])
    })
    registerPortalTool(
      mcpServer,
      '__test_deadline_outcome',
      'Tool deadline reliability test.',
      {},
      async () => {
        await portalFetchStream(`${baseUrl}/mcp-deadline-stall`, {}, { timeout: 5_000, retries: 0 })
        return { content: [{ type: 'text' as const, text: 'unexpected success' }] }
      },
      { deadlineMs: 100 },
    )
    registerPortalTool(mcpServer, '__test_oversized_result', 'Lossless response-size guard test.', {}, async () =>
      formatResult(
        { items: Array.from({ length: 500 }, (_, index) => ({ index, value: 'x'.repeat(200) })) },
        'Oversized fixture',
        {
          toolName: '__test_oversized_result',
          pagination: { type: 'cursor', page_size: 500, returned: 500, has_more: false },
        },
      ),
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'fetch-reliability-test', version: '1.0.0' })
    await mcpServer.connect(serverTransport)
    await client.connect(clientTransport)
    const mcpCancellation = new AbortController()
    const closedBeforeMcpCancellation = closedRequests
    setTimeout(() => mcpCancellation.abort(), 50)

    try {
      await expectFastFailure(
        'MCP handler propagates client cancellation to Portal fetches',
        () =>
          client.callTool(
            { name: '__test_cancel_portal_fetch', arguments: {} },
            {
              signal: mcpCancellation.signal,
              timeout: 2_000,
            },
          ),
        (error) =>
          assert(
            error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message)),
            `expected client cancellation error, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          ),
        750,
      )

      const successResult = await client.callTool({ name: '__test_success_outcome', arguments: {} })
      assert(!successResult.isError, 'complete fixture should return a successful MCP result')
      const partialResult = await client.callTool({ name: '__test_partial_outcome', arguments: {} })
      assert(!partialResult.isError, 'partial fixture should remain a usable MCP result')
      const emptyResult = await client.callTool({ name: '__test_empty_outcome', arguments: {} })
      assert(!emptyResult.isError, 'empty fixture should remain a successful MCP result')
      const toolErrorResult = await client.callTool({ name: '__test_tool_error_outcome', arguments: {} })
      assert(toolErrorResult.isError, 'tool-error fixture should return isError=true')
      const thrownErrorResult = await client.callTool({ name: '__test_request_error_outcome', arguments: {} })
      assert(thrownErrorResult.isError, 'thrown handler failures should become tool errors')
      const thrownErrorPayload = thrownErrorResult.structuredContent as Record<string, any> | undefined
      assert(
        thrownErrorPayload?.error?.code === 'internal_error',
        'unexpected handler failures should use internal_error',
      )
      assert(
        thrownErrorPayload?.error?.origin === 'server',
        'unexpected handler failures should be attributed to server',
      )
      assert(
        !JSON.stringify(thrownErrorResult).includes('Fixture request failure'),
        'unexpected handler details should not be exposed to clients',
      )
      const actionableErrorResult = await client.callTool({ name: '__test_actionable_error_outcome', arguments: {} })
      assert(actionableErrorResult.isError, 'actionable handler failures should become tool errors')
      const actionablePayload = actionableErrorResult.structuredContent as Record<string, any> | undefined
      assert(actionablePayload?.error?.code === 'invalid_request', 'actionable input failures need a stable code')
      assert(actionablePayload?.error?.origin === 'client_input', 'actionable input failures need a stable origin')
      const deadlineStartedAt = Date.now()
      const deadlineResult = await client.callTool({ name: '__test_deadline_outcome', arguments: {} })
      const deadlineElapsedMs = Date.now() - deadlineStartedAt
      const deadlinePayload = deadlineResult.structuredContent as Record<string, any> | undefined
      assert(deadlineResult.isError, 'tool deadline should return a structured tool error')
      assert(deadlinePayload?.error?.code === 'upstream_timeout', 'tool deadline should retain timeout attribution')
      assert(deadlinePayload?.error?.origin === 'upstream', 'tool deadline should be attributed to the upstream stage')
      assert(deadlinePayload?.error?.retryable === true, 'tool deadline should remain retryable')
      assert(deadlineElapsedMs < 750, `tool deadline should abort nested work promptly, took ${deadlineElapsedMs}ms`)
      const oversizedResult = await client.callTool({ name: '__test_oversized_result', arguments: {} })
      const oversizedPayload = oversizedResult.structuredContent as Record<string, any> | undefined
      assert(oversizedResult.isError, 'oversized results should return a structured tool error')
      assert(oversizedPayload?.error?.code === 'response_too_large', 'oversized results need a stable code')
      assert(oversizedPayload?.error?.retryable === true, 'oversized results should be correctable')
      assert(oversizedPayload?._coverage?.result_complete === false, 'oversized results must never look complete')

      const cancellationDeadline = Date.now() + 750
      while (closedRequests <= closedBeforeMcpCancellation && Date.now() < cancellationDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert(closedRequests > closedBeforeMcpCancellation, 'MCP cancellation should close the upstream request')

      const noArgsCancellation = new AbortController()
      setTimeout(() => noArgsCancellation.abort(), 50)
      await expectFastFailure(
        'no-argument MCP tools also propagate client cancellation',
        () =>
          client.callTool(
            { name: '__test_cancel_no_args', arguments: {} },
            {
              signal: noArgsCancellation.signal,
              timeout: 2_000,
            },
          ),
        (error) =>
          assert(
            error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message)),
            'expected no-argument tool cancellation error',
          ),
        750,
      )

      const toolMetrics = await toolCallsTotal.get()
      assert(
        toolMetrics.values.some(
          (value) =>
            value.labels.tool === '__test_cancel_portal_fetch' &&
            value.labels.status === 'cancelled' &&
            value.value === 1,
        ),
        'MCP cancellation should be counted separately from tool errors',
      )
      const errorMetrics = await toolErrorsTotal.get()
      assert(
        !errorMetrics.values.some((value) => String(value.labels.tool).startsWith('__test_cancel')),
        'MCP cancellations should not increment tool error counters',
      )
      const expectedOutcomes = new Map([
        ['__test_success_outcome', 'success'],
        ['__test_partial_outcome', 'partial'],
        ['__test_empty_outcome', 'success'],
        ['__test_tool_error_outcome', 'tool_error'],
        ['__test_request_error_outcome', 'tool_error'],
        ['__test_actionable_error_outcome', 'tool_error'],
        ['__test_deadline_outcome', 'tool_error'],
        ['__test_cancel_portal_fetch', 'cancelled'],
        ['__test_cancel_no_args', 'cancelled'],
      ])
      for (const [tool, expectedStatus] of expectedOutcomes) {
        const values = toolMetrics.values.filter((value) => value.labels.tool === tool)
        const terminalCount = values.reduce((total, value) => total + value.value, 0)
        assert(terminalCount === 1, `${tool} should have exactly one terminal outcome, observed ${terminalCount}`)
        assert(
          values.some((value) => value.labels.status === expectedStatus && value.value === 1),
          `${tool} should be classified as ${expectedStatus}`,
        )
      }
      for (const tool of [
        '__test_tool_error_outcome',
        '__test_request_error_outcome',
        '__test_actionable_error_outcome',
        '__test_deadline_outcome',
      ]) {
        assert(
          errorMetrics.values.some((value) => value.labels.tool === tool && value.value === 1),
          `${tool} should increment the tool error counter once`,
        )
      }
      assert(
        !errorMetrics.values.some((value) => value.labels.tool === '__test_partial_outcome'),
        'partial results should not increment tool error counters',
      )
      const detailedOutcomes = await toolOutcomesTotal.get()
      const expectedDetails = [
        ['__test_success_outcome', 'data', 'none', 'none'],
        ['__test_empty_outcome', 'empty', 'none', 'none'],
        ['__test_partial_outcome', 'partial', 'none', 'none'],
        ['__test_request_error_outcome', 'error', 'server', 'internal_error'],
        ['__test_actionable_error_outcome', 'error', 'client_input', 'invalid_request'],
        ['__test_deadline_outcome', 'error', 'upstream', 'upstream_timeout'],
        ['__test_cancel_portal_fetch', 'cancelled', 'transport', 'cancelled'],
      ]
      for (const [tool, resultState, errorOrigin, errorCode] of expectedDetails) {
        assert(
          detailedOutcomes.values.some(
            (value) =>
              value.labels.tool === tool &&
              value.labels.result_state === resultState &&
              value.labels.error_origin === errorOrigin &&
              value.labels.error_code === errorCode &&
              value.value === 1,
          ),
          `${tool} should expose ${resultState}/${errorOrigin}/${errorCode} outcome details`,
        )
      }
      console.log('PASS  every MCP invocation records one attributable terminal outcome')
    } finally {
      await client.close()
      await mcpServer.close()
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

main().catch((error) => {
  console.error(`Fetch reliability QA failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
