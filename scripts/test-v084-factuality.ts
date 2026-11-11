#!/usr/bin/env tsx

import { readFileSync } from 'node:fs'

import { assertUniqueNormalizedIds } from '../dist/helpers/format.js'
import {
  normalizeBitcoinInputResult,
  normalizeBitcoinOutputResult,
  normalizeHyperliquidFillResult,
  normalizeSolanaInstructionResult,
  normalizeSolanaTransactionResult,
  normalizeSubstrateCallResult,
} from '../dist/helpers/normalized-results.js'

/* The exact released version, so a release bump cannot silently drift from this gate. */
const npmVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

import {
  addExactDecimals,
  compareExactDecimals,
  formatExactDecimal,
  multiplyExactDecimals,
  parseExactDecimal,
} from '../dist/helpers/exact-decimal.js'
import { formatTokenValue, weiToEth } from '../dist/helpers/format.js'
import { buildLlmHints } from '../dist/helpers/llm-hints.js'
import { calculatePercentile } from '../dist/helpers/statistics.js'
import {
  isValidBitcoinAddress,
  isValidTronAddress,
  normalizeBitcoinAddressForPortal,
} from '../dist/helpers/validation.js'
import {
  applyWalletSummaryResponseFormat,
  bitcoinValueToSats,
  buildWalletCompleteness,
  formatDecimalAmountExact,
  formatSatsAsBtc,
} from '../dist/tools/convenience/wallet-summary.js'
import { formatTokenUnitsExact } from '../dist/tools/evm/ohlc.js'
import { compareHyperliquidOhlcFillOrder, sortHyperliquidFillsForOhlc } from '../dist/tools/hyperliquid/ohlc.js'
import { fetchPortalText } from './live-portal-probe.ts'
import { callToolWithRetry, closeTestClient, connectTestClient } from './test-helpers.js'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertIdentityRegressions() {
  const solanaA = normalizeSolanaInstructionResult({
    block_number: 442966262,
    transactionIndex: 397,
    instructionAddress: [7],
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  })
  const solanaB = normalizeSolanaInstructionResult({
    block_number: 442966262,
    transactionIndex: 410,
    instructionAddress: [7],
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  })
  assert(
    solanaA.primary_id !== solanaB.primary_id,
    'Solana instructions in different transactions must have different IDs',
  )

  const substrateA = normalizeSubstrateCallResult({
    block_number: 32784199,
    extrinsicIndex: 0,
    address: [],
    name: 'Timestamp.set',
  })
  const substrateB = normalizeSubstrateCallResult({
    block_number: 32784199,
    extrinsicIndex: 1,
    address: [],
    name: 'ParaInherent.enter',
  })
  assert(
    substrateA.primary_id !== substrateB.primary_id,
    'Root Substrate calls in different extrinsics must have different IDs',
  )

  const zeroHash = `0x${'0'.repeat(64)}`
  const fillA = normalizeHyperliquidFillResult({ hash: zeroHash, block_number: 100, fillIndex: 2, user: '0xa' })
  const fillB = normalizeHyperliquidFillResult({ hash: zeroHash, block_number: 101, fillIndex: 2, user: '0xb' })
  assert(
    fillA.primary_id !== fillB.primary_id,
    'Zero-hash Hyperliquid fills in different blocks must have different IDs',
  )
  assert(fillA.tx_hash === undefined, 'Placeholder Hyperliquid hashes must not be exposed as transaction hashes')

  const input = normalizeBitcoinInputResult({ txid: 'btc-tx', inputIndex: 0 })
  const output = normalizeBitcoinOutputResult({ txid: 'btc-tx', outputIndex: 0 })
  assert(input.primary_id !== output.primary_id, 'Bitcoin input and output IDs must occupy separate namespaces')

  const ids = [solanaA, solanaB, substrateA, substrateB, fillA, fillB, input, output].map((row) => row.primary_id)
  assert(
    ids.every((id) => typeof id === 'string' && id.length > 0),
    'Every normalized regression row needs an ID',
  )
  assert(new Set(ids).size === ids.length, 'Regression IDs must be unique')
}

function assertGeneratedIdentityProperties() {
  const solanaRows = Array.from({ length: 10_000 }, (_, index) =>
    normalizeSolanaInstructionResult({
      block_number: 500_000 + Math.floor(index / 250),
      transactionIndex: index % 250,
      instructionAddress: [index % 7, Math.floor(index / 1750)],
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    }),
  )
  const substrateRows = Array.from({ length: 10_000 }, (_, index) =>
    normalizeSubstrateCallResult({
      block_number: 30_000_000 + Math.floor(index / 100),
      extrinsicIndex: index % 100,
      address: [index % 5, Math.floor(index / 500)],
      name: `Module.call_${index % 17}`,
    }),
  )
  const hyperliquidRows = Array.from({ length: 10_000 }, (_, index) =>
    normalizeHyperliquidFillResult({
      hash: `0x${'0'.repeat(64)}`,
      block_number: 1_000_000 + Math.floor(index / 100),
      fillIndex: index % 100,
      user: `0x${index.toString(16).padStart(40, '0')}`,
    }),
  )
  const bitcoinRows = Array.from({ length: 10_000 }, (_, index) =>
    index % 2 === 0
      ? normalizeBitcoinInputResult({ txid: `btc-${Math.floor(index / 2)}`, inputIndex: index % 7 })
      : normalizeBitcoinOutputResult({ txid: `btc-${Math.floor(index / 2)}`, outputIndex: index % 11 }),
  )

  for (const [family, rows] of [
    ['Solana', solanaRows],
    ['Substrate', substrateRows],
    ['Hyperliquid', hyperliquidRows],
    ['Bitcoin', bitcoinRows],
  ] as const) {
    const ids = rows.map((row) => row.primary_id)
    assert(new Set(ids).size === rows.length, `${family}: 10,000 generated normalized rows must have unique IDs`)
    assertUniqueNormalizedIds(rows)
  }

  let duplicateRejected = false
  try {
    assertUniqueNormalizedIds([
      { chain_kind: 'bitcoin', record_type: 'input', primary_id: 'same' },
      { chain_kind: 'bitcoin', record_type: 'input', primary_id: 'same' },
    ])
  } catch {
    duplicateRejected = true
  }
  assert(duplicateRejected, 'runtime identity sentinel must reject duplicate IDs')

  let missingRejected = false
  try {
    assertUniqueNormalizedIds([
      { chain_kind: 'solana', record_type: 'instruction', primary_id: 'present' },
      { chain_kind: 'solana', record_type: 'instruction' },
    ])
  } catch {
    missingRejected = true
  }
  assert(missingRejected, 'runtime identity sentinel must reject normalized rows without IDs')
}

function assertExactAssetQuantities() {
  assert(
    formatTokenUnitsExact(43_841_943_497_649_594_000n) === '43841943497649594000',
    'large raw volume must stay exact',
  )
  assert(formatTokenUnitsExact(385_902n, 8) === '0.00385902', 'BTC quantity must convert exactly')
  assert(formatTokenUnitsExact(1_230_000n, 6) === '1.23', 'decimal output must trim only insignificant zeros')
  const btcSats = bitcoinValueToSats('0.10000001') + bitcoinValueToSats('0.20000002')
  assert(btcSats === 30_000_003n, 'Bitcoin wallet totals must sum in exact satoshis')
  assert(formatSatsAsBtc(btcSats) === '0.30000003', 'exact satoshis must round-trip to BTC without floating point')
  assert(
    formatDecimalAmountExact(9_000_000_000n, 18) === '0.000000009',
    'tiny token amounts must remain visibly non-zero',
  )
  assert(formatDecimalAmountExact(-9_000_000_000n, 18) === '-0.000000009', 'signed tiny token amounts must stay exact')
  assert(
    weiToEth('9000000000', 18) === '0.000000009',
    'shared token formatting must not round a non-zero amount to zero',
  )
  const maximum = (1n << 256n) - 1n
  assert(
    weiToEth(maximum, 18) === formatDecimalAmountExact(maximum, 18),
    'maximum-width token integers must never pass through a JavaScript number',
  )
  assert(
    formatTokenValue('0x218711a00', 18, 'USDC').formatted === '0.000000009 USDC',
    'formatted token values must keep exact tiny decimals and units',
  )

  const scientific = parseExactDecimal('9.0000e-9')
  const large = parseExactDecimal('43841943497649594000.000000000000000001')
  const negative = parseExactDecimal('-0.000000009')
  assert(scientific && formatExactDecimal(scientific) === '0.000000009', 'scientific notation must normalize exactly')
  assert(
    large && formatExactDecimal(large) === '43841943497649594000.000000000000000001',
    'large exact decimals must stay exact',
  )
  assert(negative && compareExactDecimals(negative, scientific!) < 0, 'signed exact decimal comparison must be factual')
  assert(
    parseExactDecimal('1e100000') === undefined,
    'hostile exponents must fail before allocating an unbounded decimal',
  )
  assert(
    parseExactDecimal('.1234567e-4090') === undefined,
    'hostile decimal scales must fail closed instead of throwing from normalization',
  )
  assert(parseExactDecimal(`1${'0'.repeat(5_000)}`) === undefined, 'hostile decimal lengths must fail closed')
  assert(
    formatExactDecimal(addExactDecimals(scientific!, scientific!)) === '0.000000018' &&
      formatExactDecimal(multiplyExactDecimals(scientific!, parseExactDecimal('2')!)) === '0.000000018',
    'exact decimal arithmetic must preserve tiny non-zero results',
  )

  const solana = normalizeSolanaTransactionResult({ fee: 5000, computeUnitsConsumed: 108877 })
  assert(
    solana.fee === '5000' && solana.fee_lamports === '5000' && solana.fee_unit === 'lamports',
    'Solana transaction fees must be exact strings with an explicit lamport unit',
  )
  const bitcoinInput = normalizeBitcoinInputResult({ txid: 'btc-input', inputIndex: 0, prevoutValue: 0.00012066 })
  const bitcoinOutput = normalizeBitcoinOutputResult({ txid: 'btc-output', outputIndex: 0, value: 0.00049994 })
  assert(
    bitcoinInput.prevoutValue === '0.00012066' &&
      bitcoinInput.prevout_value_unit === 'BTC' &&
      bitcoinOutput.value === '0.00049994' &&
      bitcoinOutput.value_unit === 'BTC',
    'Bitcoin input and output amounts must be exact strings with an explicit BTC unit',
  )
  const hyperliquid = normalizeHyperliquidFillResult({
    block_number: 1,
    fillIndex: 0,
    coin: 'BTC',
    feeToken: 'USDC',
    px: 78641,
    sz: 0.00042,
    fee: 0.000001,
  })
  assert(
    hyperliquid.px === '78641' &&
      hyperliquid.price_unit === 'USD per base asset' &&
      hyperliquid.sz === '0.00042' &&
      hyperliquid.size_unit === 'BTC' &&
      hyperliquid.fee === '0.000001' &&
      hyperliquid.fee_unit === 'USDC',
    'Hyperliquid prices, sizes, and fees must be exact strings with explicit units',
  )
  assert(
    calculatePercentile([84_000, 84_704], 95) === 84_668.8,
    'integer percentile interpolation must not expose a binary floating-point tail',
  )
}

function assertDeterministicHyperliquidOhlcOrdering() {
  const tiedRows = [
    { hash: '0xbbb', user: '0x2', coin: 'BTC', px: '102', sz: '1' },
    { hash: '0xaaa', user: '0x1', coin: 'BTC', px: '101', sz: '1' },
  ]
  const forward = sortHyperliquidFillsForOhlc(tiedRows)
  const reversed = sortHyperliquidFillsForOhlc(tiedRows.slice().reverse())
  assert(
    forward.map((fill) => fill.px).join(',') === reversed.map((fill) => fill.px).join(','),
    'Hyperliquid OHLC ordering must not inherit upstream row order when timestamps and fill indexes are missing',
  )

  const sharedTuple = {
    time_milliseconds: 0,
    fill_index: 0,
    block_number: 0,
    position_in_block: 0,
  }
  assert(
    compareHyperliquidOhlcFillOrder(
      { ...sharedTuple, stable_identity: 'fill:a' },
      { ...sharedTuple, stable_identity: 'fill:b' },
    ) < 0,
    'Hyperliquid OHLC ordering must break a fully colliding callback tuple deterministically',
  )
}

function assertWalletCompletenessContract() {
  const complete = buildWalletCompleteness({ hasMore: false, windowComplete: true })
  const cursorPage = buildWalletCompleteness({ hasMore: true, windowComplete: true })
  const partialWindow = buildWalletCompleteness({ hasMore: false, windowComplete: false })
  const sectionPartial = buildWalletCompleteness({
    hasMore: false,
    windowComplete: true,
    failedSections: ['token_transfers'],
  })
  assert(complete.state === 'complete' && complete.result_complete, 'complete wallet results must be explicit')
  assert(
    cursorPage.state === 'cursor_page' && cursorPage.page_complete && !cursorPage.result_complete,
    'cursor pages must distinguish page completeness from whole-result completeness',
  )
  assert(
    partialWindow.state === 'partial_window' && !partialWindow.window_complete && !partialWindow.result_complete,
    'bounded wallet scans must expose partial-window state',
  )
  assert(
    sectionPartial.state === 'section_partial' && !sectionPartial.sections_complete && !sectionPartial.result_complete,
    'failed wallet sections must never coexist with a complete result',
  )
  for (const state of [complete, cursorPage, partialWindow, sectionPartial]) {
    assert(
      state.result_complete ===
        (state.page_complete && state.window_complete && state.sections_complete && !state.has_more),
      `wallet completeness state ${state.state} must not contain contradictory booleans`,
    )
  }
}

function assertModelPreviewKeepsIdentifiersExact() {
  const hash = '0x4423dd34d8b0f11341c823b2fe9535b1c3fc9d049162ffda179b7e98393b8f7a'
  const hints = buildLlmHints(
    {
      activity: { items: [{ primary_id: hash, amount: '0.000000009 USDC' }] },
      tables: [
        {
          id: 'activity',
          kind: 'table',
          data_key: 'activity.items',
          row_count: 1,
          key_field: 'primary_id',
          columns: [
            { key: 'primary_id', label: 'Primary ID', kind: 'dimension', format: 'identifier' },
            { key: 'amount', label: 'Amount', kind: 'metric' },
          ],
        },
      ],
    },
    { primary_path: 'activity.items', primary_kind: 'records' },
  )
  const cells = hints.primary_preview?.rows?.[0]?.cells ?? []
  assert(cells[0]?.display_value === hash, 'model preview must keep a transaction hash byte-for-byte exact')
  assert(cells[1]?.display_value === '0.000000009 USDC', 'model preview must preserve an exact tiny amount string')
}

function assertChecksumValidation() {
  const validSegwitAddress = 'bc1qqmgu6nlmzf02444jtwer9uptrfn9tk6gahevs6'
  const uppercaseSegwitAddress = validSegwitAddress.toUpperCase()
  const mixedCaseSegwitAddress = `bC${validSegwitAddress.slice(2)}`
  const corruptSegwitChecksum = `${validSegwitAddress.slice(0, -1)}7`
  assert(
    isValidBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'),
    'known Bitcoin mainnet address must pass checksum validation',
  )
  assert(!isValidBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb'), 'corrupted Bitcoin checksum must fail')
  assert(
    !isValidBitcoinAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'),
    'Bitcoin testnet addresses must fail on the mainnet dataset',
  )
  assert(
    isValidBitcoinAddress(validSegwitAddress),
    'known lowercase Bitcoin SegWit address must pass checksum validation',
  )
  assert(
    isValidBitcoinAddress(uppercaseSegwitAddress),
    'valid uppercase Bitcoin SegWit address must pass checksum validation',
  )
  assert(
    !isValidBitcoinAddress(mixedCaseSegwitAddress),
    'mixed-case Bitcoin SegWit address must fail checksum validation',
  )
  assert(
    !isValidBitcoinAddress(corruptSegwitChecksum),
    'lowercase Bitcoin SegWit address with a corrupt checksum must fail',
  )
  assert(
    !isValidBitcoinAddress(corruptSegwitChecksum.toUpperCase()),
    'uppercase Bitcoin SegWit address with a corrupt checksum must fail',
  )
  assert(
    normalizeBitcoinAddressForPortal(uppercaseSegwitAddress) === validSegwitAddress,
    'uppercase bech32 addresses must be normalized before Portal filtering',
  )
  assert(isValidTronAddress('TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'), 'known Tron base58check address must pass')
  assert(!isValidTronAddress('TJRabPrwbZy45sbavfcjinPJC18kjpRTv9'), 'corrupted Tron checksum must fail')
}

function assertCompactWalletIsLossless() {
  const items = Array.from({ length: 20 }, (_, index) => ({ primary_id: `row-${index}` }))
  const compact = applyWalletSummaryResponseFormat({ activity: { count: items.length, items } }, 'compact') as {
    activity: { count: number; items: Array<{ primary_id: string }> }
  }
  assert(compact.activity.count === 20, 'compact wallet count must describe the page rows')
  assert(compact.activity.items.length === 20, 'compact wallet must not discard rows that the cursor skips')
}

function decimalToScaled(value: string, scale: number): bigint {
  const [integer, fraction = ''] = value.split('.')
  return BigInt(`${integer}${fraction.padEnd(scale, '0')}`)
}

function sumDecimalStrings(values: string[]): string {
  const scale = Math.max(0, ...values.map((value) => value.split('.')[1]?.length ?? 0))
  const total = values.reduce((sum, value) => sum + decimalToScaled(value, scale), 0n)
  return formatTokenUnitsExact(total, scale)
}

function assertNoUnsafeIntegers(value: unknown, path = '$'): void {
  if (typeof value === 'number' && Number.isInteger(value)) {
    assert(Number.isSafeInteger(value), `${path} must not expose an unsafe JSON integer`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUnsafeIntegers(entry, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object' && value !== null) {
    Object.entries(value).forEach(([key, entry]) => assertNoUnsafeIntegers(entry, `${path}.${key}`))
  }
}

async function assertLiveAggregateAndOhlcParity() {
  const connected = await connectTestClient('v084-factuality', { env: { MCP_APP_ENABLED: 'true' } })
  try {
    const invalidBitcoinFilter = await callToolWithRetry(
      connected.client,
      'portal_get_recent_activity',
      {
        network: 'bitcoin',
        timeframe: '10',
        from_addresses: ['0xZZinvalid!!'],
        limit: 5,
      },
      { retries: 0 },
    )
    assert(invalidBitcoinFilter.isError, 'Bitcoin sender filters must fail instead of becoming unfiltered queries')
    assert(
      invalidBitcoinFilter.structuredContent?.error?.code === 'invalid_request',
      'Bitcoin filter failure must be structured',
    )

    const invalidSolanaProgram = await callToolWithRetry(
      connected.client,
      'portal_solana_query_instructions',
      {
        network: 'solana',
        timeframe: '1m',
        program_id: ['notbase58!!!'],
        limit: 5,
      },
      { retries: 0 },
    )
    assert(invalidSolanaProgram.isError, 'invalid Solana program IDs must fail before a data query')
    assert(
      invalidSolanaProgram.structuredContent?.error?.code === 'invalid_request',
      'Solana filter failure must be structured',
    )

    const invalidWallet = await callToolWithRetry(
      connected.client,
      'portal_get_wallet_summary',
      {
        network: 'bitcoin',
        address: 'not-a-bitcoin-address',
        timeframe: '10',
      },
      { retries: 0 },
    )
    assert(invalidWallet.isError, 'invalid Bitcoin wallet addresses must fail')
    assert(
      invalidWallet.structuredContent?.error?.code === 'invalid_request',
      'wallet validation failure must be structured',
    )

    const compatibleWalletPage = await callToolWithRetry(
      connected.client,
      'portal_get_wallet_summary',
      {
        network: 'base',
        address: '0x0000000000000000000000000000000000000001',
        timeframe: '10',
        limit_per_type: 10,
      },
      { retries: 0 },
    )
    assert(!compatibleWalletPage.isError, 'retained wallet limits must remain callable by installed clients')
    assert(
      compatibleWalletPage.data?._server?.name === 'SQD' && compatibleWalletPage.data?._server?.version === npmVersion,
      'every tool response must make the exact SQD server version observable in-session',
    )
    assert(
      compatibleWalletPage.data?._pagination?.page_size === 4,
      'retained wallet limits must adapt to the verified safe page size',
    )
    const walletNotices = [
      ...(typeof compatibleWalletPage.data?._notice === 'string' ? [compatibleWalletPage.data._notice] : []),
      ...(Array.isArray(compatibleWalletPage.data?._notices) ? compatibleWalletPage.data._notices : []),
    ]
    assert(
      walletNotices.some((notice: string) => notice.includes('installed-client compatibility')),
      'adapted wallet pages must explain the compatibility clamp',
    )
    assert(
      compatibleWalletPage.data?.overview?.partial === undefined,
      'wallet overview must not expose the ambiguous partial boolean',
    )
    assert(
      compatibleWalletPage.data?.completeness?.kind === 'wallet_result' &&
        typeof compatibleWalletPage.data.completeness.result_complete === 'boolean' &&
        Array.isArray(compatibleWalletPage.data.completeness.failed_sections),
      'wallet summary must expose one explicit result, window, page, and section completeness contract',
    )

    const compatibleFillPage = await callToolWithRetry(
      connected.client,
      'portal_hyperliquid_query_fills',
      {
        network: 'hyperliquid-fills',
        timeframe: '1m',
        coin: ['BTC'],
        limit: 200,
      },
      { retries: 1 },
    )
    assert(!compatibleFillPage.isError, 'retained Hyperliquid fill limits must remain callable by installed clients')
    assert(
      compatibleFillPage.data?._pagination?.page_size === 25,
      'retained fill limits must adapt to the verified safe page size',
    )
    const fillNotices = [
      ...(typeof compatibleFillPage.data?._notice === 'string' ? [compatibleFillPage.data._notice] : []),
      ...(Array.isArray(compatibleFillPage.data?._notices) ? compatibleFillPage.data._notices : []),
    ]
    assert(
      fillNotices.some((notice: string) => notice.includes('installed-client compatibility')),
      'adapted fill pages must explain the compatibility clamp',
    )
    assert(
      (compatibleFillPage.data?.fills ?? []).every(
        (fill: any) =>
          typeof fill.px === 'string' &&
          fill.price_unit === 'USD per base asset' &&
          typeof fill.sz === 'string' &&
          typeof fill.size_unit === 'string',
      ),
      'live Hyperliquid fill evidence must expose exact decimal strings and units',
    )

    const recentActivity = await callToolWithRetry(
      connected.client,
      'portal_get_recent_activity',
      {
        network: 'base',
        timeframe: '10',
        limit: 3,
      },
      { retries: 1 },
    )
    assert(!recentActivity.isError, `recent activity App payload must succeed: ${recentActivity.text.slice(0, 240)}`)
    assert(
      recentActivity.data?._ui?.design_intent === 'activity_investigator' &&
        recentActivity.data?._app?.server_delivery_state === 'ready' &&
        recentActivity.data?._app?.host_render_state === 'not_observable_from_tool_result' &&
        recentActivity.data?._app?.required_host_extension === 'io.modelcontextprotocol/ui',
      'recent activity must deliver the same portable MCP App contract as every documented App-enabled experience',
    )

    const solanaHead = await callToolWithRetry(
      connected.client,
      'portal_get_head',
      { network: 'solana-mainnet' },
      { retries: 2 },
    )
    assert(!solanaHead.isError && typeof solanaHead.data?.number === 'number', 'Solana head fixture must resolve')
    const solanaFixture = await callToolWithRetry(
      connected.client,
      'portal_solana_query_transactions',
      {
        network: 'solana-mainnet',
        from_block: solanaHead.data.number - 20,
        to_block: solanaHead.data.number,
        limit: 1,
      },
      { retries: 2 },
    )
    assert(!solanaFixture.isError, `Solana wallet fixture must resolve: ${solanaFixture.text.slice(0, 240)}`)
    const solanaAddress = String(
      solanaFixture.data?.items?.[0]?.feePayer ?? solanaFixture.data?.items?.[0]?.sender ?? '',
    )
    assert(solanaAddress.length > 20, 'Solana wallet fixture must expose a fee payer')

    const solanaBalanceContext = await callToolWithRetry(
      connected.client,
      'portal_solana_query_transactions',
      {
        network: 'solana-mainnet',
        from_block: solanaHead.data.number - 2,
        to_block: solanaHead.data.number,
        include_balances: true,
        include_token_balances: true,
        limit: 2,
      },
      { retries: 2 },
    )
    assert(
      !solanaBalanceContext.isError,
      `Solana balance context must resolve: ${solanaBalanceContext.text.slice(0, 240)}`,
    )
    assert(
      (solanaBalanceContext.data?.items ?? []).every(
        (transaction: any) => Array.isArray(transaction.balances) && Array.isArray(transaction.token_balances),
      ),
      'requested Solana SOL and token balance context must be attached to every returned transaction',
    )
    assert(
      (solanaBalanceContext.data?.items ?? [])
        .flatMap((transaction: any) => transaction.balances)
        .every(
          (balance: any) =>
            balance.unit === 'lamports' &&
            (balance.pre_lamports === undefined || typeof balance.pre_lamports === 'string') &&
            (balance.post_lamports === undefined || typeof balance.post_lamports === 'string'),
        ),
      'Solana balance rows must label lamports and preserve exact integer strings',
    )

    const hyperliquidFixture = await callToolWithRetry(
      connected.client,
      'portal_hyperliquid_get_analytics',
      {
        network: 'hyperliquid-fills',
        timeframe: '1h',
        response_format: 'compact',
        section_limit: 10,
      },
      { retries: 3, totalBudgetMs: 90_000 },
    )
    assert(
      !hyperliquidFixture.isError,
      `Hyperliquid wallet fixture must resolve: ${hyperliquidFixture.text.slice(0, 240)}`,
    )
    const hyperliquidTrader = [...(hyperliquidFixture.data?.top_traders_by_volume ?? [])]
      .sort((left: any, right: any) => Number(right.fill_count ?? 0) - Number(left.fill_count ?? 0))
      .find((row: any) => Number(row.fill_count ?? 0) > 5)
    const hyperliquidAddress = String(hyperliquidTrader?.user ?? '')
    assert(
      hyperliquidAddress.startsWith('0x'),
      'Hyperliquid fixture must prove an active trader with more than one wallet page',
    )

    for (const [network, address, timeframe] of [
      ['solana-mainnet', solanaAddress, '1h'],
      ['hyperliquid-fills', hyperliquidAddress, '1h'],
    ] as const) {
      const first = await callToolWithRetry(
        connected.client,
        'portal_get_wallet_summary',
        {
          network,
          address,
          timeframe,
          limit_per_type: 5,
        },
        { retries: 3, totalBudgetMs: 90_000 },
      )
      assert(!first.isError, `${network} wallet page must succeed: ${first.text.slice(0, 240)}`)
      assert(Buffer.byteLength(first.text, 'utf8') <= 50_000, `${network} wallet page must fit the 50 KB contract`)
      assertNoUnsafeIntegers(first.data, `${network}.wallet`)
      const firstItems = first.data?.activity?.items ?? []
      const walletPageSize = Number(first.data?._pagination?.page_size)
      assert(walletPageSize === 4, `${network} wallet page must expose the verified safe page size`)
      assert(
        firstItems.length > 0 && firstItems.length <= walletPageSize,
        `${network} wallet page must honor the safe page size`,
      )
      assert(
        typeof first.data?.fund_flow?.ranking_definition === 'string',
        `${network} wallet movement ranking must state its comparison domain`,
      )
      assert(
        (first.data?.fund_flow?.largest_movements ?? []).every(
          (movement: any) => typeof movement.amount_decimal === 'string' && movement.amount_numeric === undefined,
        ),
        `${network} wallet movement amounts must remain exact decimal strings`,
      )
      if (network === 'solana-mainnet') {
        assert(
          firstItems.every((row: any) => typeof row.fee === 'string' && typeof row.fee_lamports === 'string'),
          'Solana wallet fees must remain exact lamport strings in primary evidence',
        )
        assert(
          typeof first.data?.solana?.fee_summary?.total_fees_lamports === 'string' &&
            typeof first.data?.solana?.fee_summary?.avg_fee_lamports === 'string',
          'Solana wallet fee totals and averages must remain exact decimal strings',
        )
      }
      if (network === 'hyperliquid-fills') {
        assert(
          (first.data?.fund_flow?.largest_movements ?? []).every(
            (movement: any) => movement.counterparty === undefined,
          ),
          'Hyperliquid fills must not invent the queried wallet as its own counterparty',
        )
      }
      const cursor = first.data?._pagination?.next_cursor
      if (network === 'hyperliquid-fills') {
        assert(typeof cursor === 'string', `${network} active wallet fixture must provide a continuation cursor`)
      }
      if (typeof cursor !== 'string') {
        assert(
          first.data?._pagination?.has_more === false,
          `${network} cursor absence must mean the result is exhausted`,
        )
        continue
      }
      assert(
        firstItems.length === walletPageSize,
        `${network} continued wallet page must fill the declared page before continuing`,
      )

      const second = await callToolWithRetry(
        connected.client,
        'portal_get_wallet_summary',
        { cursor },
        { retries: 3, totalBudgetMs: 90_000 },
      )
      assert(!second.isError, `${network} wallet continuation must succeed: ${second.text.slice(0, 240)}`)
      assert(
        Buffer.byteLength(second.text, 'utf8') <= 50_000,
        `${network} continued wallet page must fit the 50 KB contract`,
      )
      assert(
        second.data?._pagination?.page_size === walletPageSize &&
          second.data?.activity?.items?.length > 0 &&
          second.data?.activity?.items?.length <= walletPageSize,
        `${network} continued wallet page must preserve the safe page size`,
      )
      const firstIds = new Set(firstItems.map((row: any) => row.primary_id))
      assert(
        (second.data?.activity?.items ?? []).every((row: any) => !firstIds.has(row.primary_id)),
        `${network} wallet continuation must not duplicate prior rows`,
      )
    }

    const analytics = await callToolWithRetry(connected.client, 'portal_evm_get_analytics', {
      network: 'base',
      num_blocks: 2,
      limit: 10,
      mode: 'deep',
    })
    assert(!analytics.isError, `live EVM analytics must succeed: ${analytics.text.slice(0, 300)}`)
    const analyticsData = analytics.data as any
    const fromBlock = analyticsData.overview.from_block
    const toBlock = analyticsData.overview.to_block
    const directText = await fetchPortalText(
      'Base analytics parity',
      'https://portal.sqd.dev/datasets/base-mainnet/stream',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'evm',
          fromBlock,
          toBlock,
          fields: { block: { number: true }, transaction: { to: true, hash: true } },
          transactions: [{}],
        }),
      },
    )
    const directRows = directText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const directTransactions = directRows.flatMap((row) => row.transactions ?? [])
    assert(
      analyticsData.overview.total_transactions === directTransactions.length,
      `EVM analytics total ${analyticsData.overview.total_transactions} must equal direct Portal ${directTransactions.length}`,
    )

    const ohlcResult = await callToolWithRetry(
      connected.client,
      'portal_evm_get_ohlc',
      {
        network: 'base',
        pool_address: '0xd0b53d9277642d899df5c87a3966a349a798f224',
        source: 'uniswap_v3_swap',
        duration: '15m',
        interval: '5m',
        mode: 'deep',
        price_in: 'auto',
        include_recent_trades: true,
        recent_trades_limit: 5,
      },
      { retries: 1, totalBudgetMs: 60_000 },
    )
    assert(!ohlcResult.isError, `live EVM OHLC must succeed: ${ohlcResult.text.slice(0, 300)}`)
    const ohlcData = ohlcResult.data as any
    const candles = ohlcData.ohlc as Array<{ base_volume: string; quote_volume: string; sample_count: number }>
    assert(
      ohlcData.summary.total_samples === candles.reduce((sum, candle) => sum + candle.sample_count, 0),
      'OHLC summary sample count must equal returned candles',
    )
    assert(
      String(ohlcData.summary.total_base_volume) ===
        sumDecimalStrings(candles.map((candle) => String(candle.base_volume))),
      'OHLC base volume must equal returned candles exactly',
    )
    assert(
      String(ohlcData.summary.total_quote_volume) ===
        sumDecimalStrings(candles.map((candle) => String(candle.quote_volume))),
      'OHLC quote volume must equal returned candles exactly',
    )
    assert(
      ohlcData.summary.pair_label === 'WETH/USDC' && ohlcData.summary.price_unit === 'USDC/WETH',
      'Base WETH/USDC candles must resolve human token labels and quote units',
    )
    assert(
      ohlcData.summary.price_scale === 'adjusted' &&
        Number(ohlcData.summary.latest_close) > 100 &&
        Number(ohlcData.summary.latest_close) < 100_000,
      'Base WETH/USDC candles must apply token decimals instead of returning a raw scientific ratio',
    )
    assert(
      Math.floor(Date.parse(ohlcData.summary.window_end_exclusive_human) / 1000) ===
        ohlcData.summary.window_end_exclusive,
      'EVM OHLC exclusive-end human timestamp must describe the exact exclusive epoch',
    )
    assertNoUnsafeIntegers(ohlcData)

    const recentHyperliquid = await callToolWithRetry(
      connected.client,
      'portal_hyperliquid_get_ohlc',
      {
        network: 'hyperliquid-fills',
        coin: 'BTC',
        duration: '15m',
        interval: '5m',
      },
      { retries: 2, totalBudgetMs: 90_000 },
    )
    assert(!recentHyperliquid.isError, `live Hyperliquid OHLC must succeed: ${recentHyperliquid.text.slice(0, 300)}`)
    const recentSummary = recentHyperliquid.data?.summary
    const fixedHyperliquid = await callToolWithRetry(
      connected.client,
      'portal_hyperliquid_get_ohlc',
      {
        network: 'hyperliquid-fills',
        coin: 'BTC',
        interval: '5m',
        from_timestamp: recentSummary.requested_window_start_timestamp,
        to_timestamp: recentSummary.requested_window_end_exclusive - 1,
      },
      { retries: 2, totalBudgetMs: 90_000 },
    )
    assert(
      !fixedHyperliquid.isError,
      `fixed Hyperliquid OHLC replay must succeed: ${fixedHyperliquid.text.slice(0, 300)}`,
    )
    const fixedData = fixedHyperliquid.data as any
    const fixedCandles = fixedData.ohlc as Array<{ bucket_complete: boolean; fill_count: number }>
    const exactWindowSeconds =
      fixedData.summary.requested_window_end_exclusive - fixedData.summary.requested_window_start_timestamp
    assert(
      fixedData.summary.duration === `${exactWindowSeconds}s` &&
        fixedData.summary.duration_seconds === exactWindowSeconds &&
        fixedData._execution.duration === `${exactWindowSeconds}s` &&
        fixedData._execution.duration_seconds === exactWindowSeconds,
      'exact Hyperliquid windows must report their analyzed duration instead of an unrelated one-hour default',
    )
    assert(
      Math.floor(Date.parse(fixedData.summary.requested_window_end_exclusive_human) / 1000) ===
        fixedData.summary.requested_window_end_exclusive &&
        Math.floor(Date.parse(fixedData.summary.window_end_exclusive_human) / 1000) ===
          fixedData.summary.window_end_exclusive,
      'exclusive-end human timestamps must describe the exact exclusive epoch',
    )
    assert(
      fixedData._evidence?.request?.arguments?.duration === undefined && fixedData._evidence?.replay?.mode === 'exact',
      'exact Hyperliquid evidence must omit the duration default and remain replayable by absolute bounds',
    )
    assert(
      fixedCandles.every((candle) => typeof candle.bucket_complete === 'boolean'),
      'every Hyperliquid candle must declare whether it is closed',
    )
    assert(
      fixedData.summary.final_bucket_complete === fixedCandles.at(-1)?.bucket_complete,
      'Hyperliquid summary final candle state must match the last row',
    )
    assert(
      fixedData.summary.result_complete === fixedData._coverage.result_complete &&
        fixedData._coverage.final_bucket_complete === fixedData.summary.final_bucket_complete,
      'Hyperliquid summary and coverage completeness must agree',
    )
    if (!fixedData.summary.final_bucket_complete) {
      assert(
        fixedData._coverage.result_complete === false,
        'an open final Hyperliquid candle must make the result incomplete',
      )
    }

    const directHyperliquidText = await fetchPortalText(
      'Hyperliquid candle parity',
      'https://portal.sqd.dev/datasets/hyperliquid-fills/stream',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'hyperliquidFills',
          fromBlock: fixedData.summary.from_block,
          toBlock: fixedData.summary.to_block,
          fields: { block: { number: true, timestamp: true }, fill: { time: true, px: true, sz: true } },
          fills: [{ coin: ['BTC'] }],
        }),
      },
    )
    const directHyperliquidRows = directHyperliquidText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const directValidFills = directHyperliquidRows
      .flatMap((row) => row.fills ?? [])
      .filter((fill) => {
        const raw = Number(fill.time ?? 0)
        const timestamp = raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw)
        return (
          timestamp >= fixedData.summary.requested_window_start_timestamp &&
          timestamp < fixedData.summary.requested_window_end_exclusive &&
          Number(fill.px ?? 0) > 0 &&
          Number(fill.sz ?? 0) > 0
        )
      })
    const directFillCount = directValidFills.length
    const directNotional = directValidFills.reduce((sum, fill) => {
      const price = parseExactDecimal(fill.px)
      const size = parseExactDecimal(fill.sz)
      return price && size ? addExactDecimals(sum, multiplyExactDecimals(price, size)) : sum
    }, parseExactDecimal('0')!)
    assert(
      fixedData.summary.total_fills === directFillCount,
      `Hyperliquid candle fill total ${fixedData.summary.total_fills} must equal direct Portal ${directFillCount}`,
    )
    assert(
      fixedData.summary.total_volume === formatExactDecimal(directNotional),
      'Hyperliquid candle notional volume must equal the exact price-times-size sum from direct Portal rows',
    )
    assert(
      fixedData.summary.total_volume === sumDecimalStrings(fixedData.ohlc.map((candle: any) => String(candle.volume))),
      'Hyperliquid candle summary volume must reconcile exactly with every returned candle',
    )
    const nonMultipleWindow = await callToolWithRetry(
      connected.client,
      'portal_hyperliquid_get_ohlc',
      {
        network: 'hyperliquid-fills',
        coin: 'BTC',
        interval: '5m',
        from_timestamp: recentSummary.requested_window_start_timestamp + 17,
        to_timestamp: recentSummary.requested_window_end_exclusive - 1,
      },
      { retries: 2, totalBudgetMs: 90_000 },
    )
    assert(
      !nonMultipleWindow.isError,
      `non-multiple Hyperliquid OHLC window must succeed: ${nonMultipleWindow.text.slice(0, 300)}`,
    )
    const previousWindowCursor = nonMultipleWindow.data?._pagination?.next_cursor
    assert(
      typeof previousWindowCursor === 'string',
      'non-multiple Hyperliquid OHLC window must expose an older-window cursor',
    )
    const previousWindow = await callToolWithRetry(
      connected.client,
      'portal_hyperliquid_get_ohlc',
      {
        cursor: previousWindowCursor,
      },
      { retries: 2, totalBudgetMs: 90_000 },
    )
    assert(
      !previousWindow.isError,
      `non-multiple Hyperliquid OHLC continuation must succeed: ${previousWindow.text.slice(0, 300)}`,
    )
    assert(
      (previousWindow.data?.ohlc ?? []).every((candle: any) => candle.timestamp % 300 === 0),
      'Hyperliquid continuation candles must stay aligned to the requested interval grid',
    )
    assert(
      previousWindow.data?.summary?.total_fills > 0,
      'an active BTC continuation window must not become factually empty because its cursor is off-grid',
    )
    assert(
      previousWindow.data?.summary?.total_volume ===
        sumDecimalStrings((previousWindow.data?.ohlc ?? []).map((candle: any) => String(candle.volume))),
      'continued Hyperliquid OHLC volume must reconcile exactly with the returned candles',
    )
    const emptyHyperliquid = await callToolWithRetry(
      connected.client,
      'portal_hyperliquid_get_ohlc',
      {
        network: 'hyperliquid-fills',
        coin: 'SQD_NO_SUCH_MARKET',
        interval: '5m',
        from_timestamp: recentSummary.requested_window_end_exclusive - 300,
        to_timestamp: recentSummary.requested_window_end_exclusive - 1,
      },
      { retries: 1, totalBudgetMs: 90_000 },
    )
    assert(
      !emptyHyperliquid.isError,
      'a valid no-fill Hyperliquid interval must return empty candles rather than an error',
    )
    assert(
      emptyHyperliquid.data.summary.total_fills === 0 &&
        emptyHyperliquid.data.ohlc.every((candle: any) => candle.fill_count === 0 && candle.open === null),
      'no-fill Hyperliquid candles must remain explicit zero-activity evidence without invented prices',
    )

    const hyperliquidSeries = await callToolWithRetry(
      connected.client,
      'portal_get_time_series',
      {
        network: 'hyperliquid-fills',
        metric: 'volume',
        duration: '15m',
        interval: '5m',
      },
      { retries: 2, totalBudgetMs: 90_000 },
    )
    assert(!hyperliquidSeries.isError, `Hyperliquid time series must succeed: ${hyperliquidSeries.text.slice(0, 300)}`)
    const hyperliquidSeriesRows = hyperliquidSeries.data?.time_series ?? []
    assert(
      hyperliquidSeriesRows.length > 0 &&
        hyperliquidSeriesRows.every(
          (row: any) => typeof row.has_fills === 'boolean' && row.blocks_in_bucket === undefined,
        ),
      'Hyperliquid time-series rows must expose fill presence as a boolean rather than a fake block count',
    )
    assert(
      (hyperliquidSeries.data?.tables?.[0]?.columns ?? []).every((column: any) => column.key !== 'blocks_in_bucket'),
      'Hyperliquid time-series tables must not label fill presence as block or bucket counts',
    )
    assert(
      hyperliquidSeries.data?.metric_definition?.aggregation === 'sum_price_times_size_per_bucket' &&
        hyperliquidSeries.data.metric_definition.unit === 'USD',
      'Hyperliquid volume rows must declare their unit and exact aggregation',
    )
    const seriesSummary = hyperliquidSeries.data.summary
    const fixedSeries = await callToolWithRetry(
      connected.client,
      'portal_get_time_series',
      {
        network: 'hyperliquid-fills',
        metric: 'volume',
        interval: '5m',
        from_timestamp: seriesSummary.requested_window_start_timestamp,
        to_timestamp: seriesSummary.requested_window_end_exclusive - 1,
      },
      { retries: 2, totalBudgetMs: 90_000 },
    )
    assert(!fixedSeries.isError, `fixed Hyperliquid time series must succeed: ${fixedSeries.text.slice(0, 300)}`)
    assert(
      JSON.stringify(fixedSeries.data.time_series) === JSON.stringify(hyperliquidSeries.data.time_series),
      'replaying a fixed Hyperliquid time-series interval must return identical bucket boundaries and values',
    )
    assert(
      fixedSeries.data.summary.result_complete === fixedSeries.data._coverage.result_complete &&
        fixedSeries.data.summary.final_bucket_complete === fixedSeries.data._coverage.final_bucket_complete,
      'Hyperliquid time-series summary and coverage completeness must agree',
    )
  } finally {
    await closeTestClient(connected)
  }
}

async function main() {
  assertIdentityRegressions()
  assertGeneratedIdentityProperties()
  assertExactAssetQuantities()
  assertDeterministicHyperliquidOhlcOrdering()
  assertWalletCompletenessContract()
  assertModelPreviewKeepsIdentifiersExact()
  assertChecksumValidation()
  assertCompactWalletIsLossless()
  await assertLiveAggregateAndOhlcParity()
  console.log('PASS  v0.8.4 factuality invariants (40,000 generated records plus live Portal parity)')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
