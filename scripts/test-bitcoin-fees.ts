#!/usr/bin/env tsx

/* Bitcoin fee truth gate. Offline: exact satoshi accounting on
   generated stream records, section coverage above, at, and below the fee
   scan cap, mismatched input and output block sets, and bucket sums that
   reconcile to the window total. Live: one bounded parity check of
   portal_bitcoin_get_analytics and the fees_btc time series against direct
   Portal rows for the same exact block range. Upstream overload is reported
   as a bounded outcome and never counted as a pass. */

import { btcToSats, computeBitcoinBlockFees, satsToBtcString, totalBitcoinFees } from '../src/helpers/bitcoin-fees.ts'
import { buildAnalysisCoverage, buildAnalysisSectionCoverage } from '../src/helpers/result-metadata.ts'
import { fetchPortalText } from './live-portal-probe.ts'
import { callToolWithRetry, closeTestClient, connectTestClient, isBoundedUpstreamToolError } from './test-helpers.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

type GeneratedTx = { inputs: string[]; outputs: string[] }

/* A block record shaped like Portal's combined inputs+outputs stream. The
   coinbase is transaction 0: no previous output value, outputs carry the
   reward plus every fee. */
function generatedBlock(number: number, timestamp: number, txs: GeneratedTx[], reward = '3.125') {
  const feeSats = txs.reduce((sum, tx) => {
    const inputs = tx.inputs.reduce((inner, value) => inner + btcToSats(value)!, 0n)
    const outputs = tx.outputs.reduce((inner, value) => inner + btcToSats(value)!, 0n)
    return sum + (inputs - outputs)
  }, 0n)
  const coinbaseOut = satsToBtcString(btcToSats(reward)! + feeSats)
  return {
    header: { number, timestamp },
    inputs: [
      { transactionIndex: 0, prevoutValue: null },
      ...txs.flatMap((tx, index) =>
        tx.inputs.map((value) => ({ transactionIndex: index + 1, prevoutValue: Number(value) })),
      ),
    ],
    outputs: [
      { transactionIndex: 0, value: Number(coinbaseOut) },
      ...txs.flatMap((tx, index) => tx.outputs.map((value) => ({ transactionIndex: index + 1, value: Number(value) }))),
    ],
    expectedFeeSats: feeSats,
  }
}

function generatedWindow(fromBlock: number, blocks: number) {
  return Array.from({ length: blocks }, (_, index) => {
    const number = fromBlock + index
    /* Fee sizes vary with the block so a wrong block set changes the total. */
    const txs: GeneratedTx[] = [
      { inputs: ['0.5', '0.25'], outputs: ['0.7', satsToBtcString(5_000_000n - BigInt(index) * 1_000n)] },
      { inputs: ['1.00000001'], outputs: ['0.99999000'] },
      { inputs: ['0.00012345', '0.00000001'], outputs: ['0.00012000'] },
    ]
    return generatedBlock(number, 1_700_000_000 + index * 600, txs)
  })
}

function assertOfflineInvariants() {
  const from = 900_000
  const window = generatedWindow(from, 25)
  const computed = computeBitcoinBlockFees({ inputRecords: window, outputRecords: window })
  assert(computed.excluded_blocks.length === 0, 'complete records must not exclude any block')
  assert(computed.blocks.length === 25, 'every generated block must be accounted for')
  computed.blocks.forEach((block, index) => {
    assert(block.block_number === from + index, 'blocks must come back in ascending order')
    assert(
      block.fee_sats === window[index].expectedFeeSats,
      `block ${block.block_number} fee must be exact in satoshis`,
    )
    assert(block.transaction_count === 3, 'the coinbase must not count as a fee-paying transaction')
  })
  const totals = totalBitcoinFees(computed.blocks)
  const expectedTotal = window.reduce((sum, block) => sum + block.expectedFeeSats, 0n)
  assert(totals.total_fee_sats === expectedTotal, 'window total must be the exact satoshi sum of block fees')
  assert(totals.transactions === 75, 'window transaction count must exclude every coinbase')
  assert(totals.avg_fee_per_tx_sats === expectedTotal / 75n, 'average fee must use the same block set as the total')
  assert(totals.fees_per_block_sats === expectedTotal / 25n, 'fees per block must use the same block set as the total')
  assert(
    satsToBtcString(totals.total_fee_sats) === (Number(totals.total_fee_sats) / 1e8).toFixed(8).replace(/0+$/, ''),
    'BTC display must be derived from exact satoshis',
  )
  /* Float arithmetic on the same BTC values drifts; the satoshi path does not. */
  assert(btcToSats('0.00012345')! + btcToSats('0.00000001')! === 12_346n, 'satoshi parsing must be exact')
  assert(btcToSats(1e-8) === 1n && btcToSats('1e-8') === 1n, 'exponent notation must parse to exact satoshis')

  /* Mismatched sets: inputs for 25 blocks, outputs for 20, and one block with
     an unknown previous output value. Only blocks present and complete in
     both sets count. */
  const outputsOnly = window.slice(0, 20)
  const damaged = structuredClone(window[3]) as (typeof window)[number]
  damaged.inputs[2] = { transactionIndex: 1, prevoutValue: null }
  const mismatched = computeBitcoinBlockFees({
    inputRecords: [...window.slice(0, 3), damaged, ...window.slice(4)],
    outputRecords: outputsOnly,
  })
  assert(mismatched.blocks.length === 19, 'blocks missing from one set or with unknown inputs must not count')
  assert(
    JSON.stringify(mismatched.excluded_blocks) ===
      JSON.stringify([from + 3, ...Array.from({ length: 5 }, (_, i) => from + 20 + i)]),
    `excluded blocks must be reported exactly: ${mismatched.excluded_blocks.join(', ')}`,
  )
  const mismatchedTotals = totalBitcoinFees(mismatched.blocks)
  const expectedMismatched = window
    .filter((_, index) => index < 20 && index !== 3)
    .reduce((sum, block) => sum + block.expectedFeeSats, 0n)
  assert(mismatchedTotals.total_fee_sats === expectedMismatched, 'totals must cover only the intersected block set')

  /* Section coverage above, at, and below the analytics fee cap (36 blocks),
     with inclusive block ranges: scanning n blocks that end at the window end
     starts at end - n + 1. */
  const cap = 36
  for (const [windowBlocks, expectSampled] of [
    [6, false],
    [36, false],
    [144, true],
  ] as const) {
    const windowTo = 1_000_000
    const windowFrom = windowTo - windowBlocks + 1
    const scanBlocks = Math.min(windowBlocks, cap)
    const scanFrom = windowTo - scanBlocks + 1
    const section = buildAnalysisSectionCoverage({
      windowFromBlock: windowFrom,
      windowToBlock: windowTo,
      analyzedFromBlock: scanFrom,
      analyzedToBlock: windowTo,
    })
    assert(
      section.analyzed_blocks === scanBlocks,
      `a ${scanBlocks}-block scan must report ${scanBlocks} blocks, not ${section.analyzed_blocks}`,
    )
    assert(section.window_blocks === windowBlocks, 'section coverage must name the analyzed window size')
    assert(section.sampled === expectSampled, `${windowBlocks}-block window sampled must be ${expectSampled}`)
    const coverage = buildAnalysisCoverage({
      windowFromBlock: windowFrom,
      windowToBlock: windowTo,
      analyzedFromBlock: windowFrom,
      analyzedToBlock: windowTo,
      sections: { fee_analysis: section },
    })
    assert(coverage.window_complete === true, 'block statistics still cover the whole window')
    assert(coverage.sampled === expectSampled, 'a sampled section must mark the whole result sampled')
    assert(coverage.sections?.fee_analysis === section, 'section coverage must be carried on the result')
  }
  const withExcluded = buildAnalysisSectionCoverage({
    windowFromBlock: 1,
    windowToBlock: 10,
    analyzedFromBlock: 1,
    analyzedToBlock: 10,
    excludedBlocks: [4],
  })
  assert(
    withExcluded.sampled === true && withExcluded.analyzed_blocks === 9,
    'an excluded block makes a full scan sampled',
  )

  /* Bucket sums reconcile to the window total for the same exact block set. */
  const intervalSeconds = 1_800
  const lastTimestamp = computed.blocks[computed.blocks.length - 1].timestamp
  const seriesStart = lastTimestamp - 6 * 3_600
  const bucketSats = new Map<number, bigint>()
  let bucketed = 0n
  for (const block of computed.blocks) {
    const bucketIndex = Math.floor((block.timestamp - seriesStart) / intervalSeconds)
    if (bucketIndex < 0) continue
    /* The newest block sits at the series end and belongs to the last bucket. */
    const clamped = Math.min(bucketIndex, 11)
    bucketSats.set(clamped, (bucketSats.get(clamped) ?? 0n) + block.fee_sats)
    bucketed += block.fee_sats
  }
  const inWindow = computed.blocks.filter(
    (block) => block.timestamp >= seriesStart && block.timestamp < lastTimestamp + 1,
  )
  assert(
    [...bucketSats.values()].reduce((sum, value) => sum + value, 0n) === bucketed &&
      bucketed === totalBitcoinFees(inWindow).total_fee_sats,
    'bucket sums must reconcile to the exact window total',
  )
  assert(
    [...bucketSats.values()].every((value) => value > 0n),
    'buckets with fee-paying blocks must be non-zero',
  )
  console.log(
    'PASS  offline Bitcoin fee invariants (exact satoshis, mismatched sets, cap coverage, bucket reconciliation)',
  )
}

type DirectBlock = {
  header: { number: number; timestamp: number }
  inputs: Array<{ transactionIndex: number; prevoutValue: number | null }>
  outputs: Array<{ transactionIndex: number; value: number }>
}

/* Independent float-free recomputation straight from Portal rows: integer
   satoshis per value via toFixed(8), so a drift in the helper would show. */
async function directStreamRequest(fromBlock: number, toBlock: number): Promise<string> {
  return fetchPortalText(
    `Bitcoin fee reference blocks ${fromBlock}-${toBlock}`,
    'https://portal.sqd.dev/datasets/bitcoin-mainnet/stream',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'bitcoin',
        fromBlock,
        toBlock,
        includeAllBlocks: true,
        fields: {
          block: { number: true, timestamp: true },
          input: { prevoutValue: true, transactionIndex: true },
          output: { value: true, transactionIndex: true },
        },
        inputs: [{}],
        outputs: [{}],
      }),
    },
  )
}

/*
 * The independent recomputation this whole gate rests on. Portal answers a
 * stream request with as much as it is willing to send in one response and
 * expects the caller to come back for the rest; a single request over twelve
 * Bitcoin blocks with every input and output returned one block. Reading only
 * that first response made the reference smaller than the answer it was
 * checking, which the gate then read as the tool over-counting.
 */
async function directFeeSats(
  fromBlock: number,
  toBlock: number,
): Promise<{ sats: bigint; blocks: number; transactions: number }> {
  let sats = 0n
  let transactions = 0
  const seen = new Set<number>()
  let nextBlock = fromBlock
  for (let request = 0; nextBlock <= toBlock; request += 1) {
    assert(request < 200, `direct Portal stream did not reach block ${toBlock} in 200 requests`)
    const text = await directStreamRequest(nextBlock, toBlock)
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    assert(lines.length > 0, `direct Portal stream returned nothing for blocks ${nextBlock}-${toBlock}`)
    let highest = nextBlock - 1
    for (const line of lines) {
      const block = JSON.parse(line) as DirectBlock
      seen.add(block.header.number)
      highest = Math.max(highest, block.header.number)
      const toSats = (value: number) => BigInt(value.toFixed(8).replace('.', ''))
      for (const input of block.inputs)
        if (input.transactionIndex !== 0 && input.prevoutValue !== null) sats += toSats(input.prevoutValue)
      for (const output of block.outputs) if (output.transactionIndex !== 0) sats -= toSats(output.value)
      transactions += new Set(block.outputs.map((output) => output.transactionIndex).filter((index) => index !== 0))
        .size
    }
    assert(highest >= nextBlock, `direct Portal stream made no progress past block ${nextBlock}`)
    nextBlock = highest + 1
  }
  return { sats, blocks: seen.size, transactions }
}

/* Mirrors the rule in helpers/format.ts: an estimated window boundary is what
   downgrades a complete window, and nothing else does here. */
function freshnessProvesExactWindow(freshness: any): boolean {
  if (!freshness || typeof freshness !== 'object') return true
  if (freshness.kind === 'timestamp_lookup') return freshness.resolution !== 'estimated'
  if (freshness.estimated_timeframe !== undefined) return false
  const bounds = freshness.timestamp_bounds
  if (!bounds || typeof bounds !== 'object') return true
  return ['from', 'to'].every((key) => {
    const boundary = bounds[key]
    return !boundary || typeof boundary !== 'object' || boundary.resolution !== 'estimated'
  })
}

async function assertLiveParity(): Promise<'pass' | 'bounded'> {
  const connected = await connectTestClient('bitcoin-fee-gate')
  try {
    const analytics = await callToolWithRetry(
      connected.client,
      'portal_bitcoin_get_analytics',
      { network: 'bitcoin-mainnet', timeframe: '1h', include_address_activity: false },
      { requestTimeoutMs: 120_000, totalBudgetMs: 240_000 },
    )
    if (analytics.isError && isBoundedUpstreamToolError(analytics)) {
      console.log(`BOUNDED  Bitcoin analytics could not run: upstream overload (${analytics.text.slice(0, 120)})`)
      return 'bounded'
    }
    assert(!analytics.isError, `live Bitcoin analytics must succeed: ${analytics.text.slice(0, 300)}`)
    const data = analytics.data
    const fees = data.fee_analysis
    const section = data._coverage?.sections?.fee_analysis
    assert(fees && section, 'fee analysis and its section coverage must be present')
    assert(
      fees.scope === 'window' && fees.sampled === false,
      `a 1h window must be fee-complete: ${JSON.stringify(fees).slice(0, 200)}`,
    )
    assert(
      data._coverage.sampled === false && section.sampled === false,
      'complete fee coverage must not be marked sampled',
    )
    assert(fees.block_range === `${fees.from_block}-${fees.to_block}`, 'fee block range must name its exact bounds')
    assert(
      fees.blocks_scanned === fees.to_block - fees.from_block + 1,
      'blocks scanned must equal the inclusive range size',
    )
    assert(section.analyzed_blocks === fees.blocks_scanned, 'section coverage must agree with the fee section')
    assert(fees.window_blocks === data._coverage.analyzed_blocks, 'fee window_blocks must equal the analyzed window')
    assert(
      typeof fees.total_fees_sats === 'string' && /^\d+$/.test(fees.total_fees_sats),
      'fee totals must be exact satoshi strings',
    )
    assert(
      !/fees from the latest|fees unavailable/.test(data.answer ?? ''),
      'a complete fee window must not be described as sampled',
    )
    const direct = await directFeeSats(fees.from_block, fees.to_block)
    assert(
      direct.blocks === fees.blocks_scanned,
      `direct Portal rows cover ${direct.blocks} blocks, tool scanned ${fees.blocks_scanned}`,
    )
    assert(
      direct.sats.toString() === fees.total_fees_sats,
      `tool total ${fees.total_fees_sats} sats must equal direct Portal recomputation ${direct.sats} sats for blocks ${fees.block_range}`,
    )
    assert(direct.transactions === fees.transactions, 'fee-paying transaction count must match direct Portal rows')
    assert(satsToBtcString(direct.sats) === fees.total_fees_btc, 'BTC total must be the exact satoshi conversion')
    console.log(
      `PASS  live analytics fees reconcile with direct Portal rows (${fees.block_range}: ${fees.total_fees_btc} BTC over ${fees.transactions} txs)`,
    )

    const sampled = await callToolWithRetry(
      connected.client,
      'portal_bitcoin_get_analytics',
      { network: 'bitcoin-mainnet', timeframe: '12h', include_address_activity: false, response_format: 'compact' },
      { requestTimeoutMs: 180_000, totalBudgetMs: 300_000 },
    )
    if (sampled.isError && isBoundedUpstreamToolError(sampled)) {
      console.log(`BOUNDED  sampled-window analytics could not run: upstream overload (${sampled.text.slice(0, 120)})`)
      return 'bounded'
    }
    assert(!sampled.isError, `live 12h Bitcoin analytics must succeed: ${sampled.text.slice(0, 300)}`)
    const sampledFees = sampled.data.fee_analysis
    const sampledCoverage = sampled.data._coverage
    assert(
      sampledFees.scope === 'sample' && sampledFees.sampled === true,
      'a 12h window must expose sample-scoped fees',
    )
    assert(
      sampledCoverage.sampled === true && sampledCoverage.sections.fee_analysis.sampled === true,
      'sampled fees must mark coverage sampled',
    )
    assert(
      sampledCoverage.analyzed_blocks === sampledCoverage.requested_blocks &&
        sampledCoverage.analyzed_from_block === sampledCoverage.window_from_block,
      'block statistics still cover the analyzed window',
    )
    const answer: string = sampled.data.answer ?? sampled.text
    assert(
      /fees from the latest \d+ of \d+ blocks/.test(answer),
      `the answer must say fees are sample-scoped: ${answer.slice(0, 200)}`,
    )
    const notices: string[] = sampled.data._notices ?? (sampled.data._notice ? [sampled.data._notice] : [])
    assert(
      notices.some((notice) => /Fee analysis covers/.test(notice)),
      'a notice must state the fee block set',
    )
    const notes: string[] = sampled.data._execution?.notes ?? []
    assert(
      notes.some((note) => /Fee analysis covers/.test(note)),
      'execution notes must state the fee block set',
    )
    const reasons: string[] = sampled.data._evidence?.result?.partial_reasons ?? []
    assert(
      reasons.includes('sampled_window') && sampled.data._evidence?.result?.completeness === 'partial',
      'the receipt must call sampled fees partial',
    )
    console.log(`PASS  sampled fee window is declared everywhere (answer, notices, coverage, execution, receipt)`)

    const series = await callToolWithRetry(
      connected.client,
      'portal_get_time_series',
      { network: 'bitcoin-mainnet', metric: 'fees_btc', interval: '15m', duration: '2h' },
      { requestTimeoutMs: 180_000, totalBudgetMs: 300_000 },
    )
    if (series.isError && isBoundedUpstreamToolError(series)) {
      console.log(`BOUNDED  fees_btc series could not run: upstream overload (${series.text.slice(0, 120)})`)
      return 'bounded'
    }
    assert(!series.isError, `live fees_btc series must succeed: ${series.text.slice(0, 300)}`)
    const rows: Record<string, any>[] = series.data.time_series
    const summary = series.data.summary
    /* At least 8, not exactly 8. The series is anchored to the latest block and
       spans the blocks that were actually scanned, because dropping a scanned
       block would take its fees out of the buckets while leaving them in the
       window total. Bitcoin block times are irregular, so a 2h request often
       resolves to a block range spanning a little longer than 2h. What must
       hold is that the series covers at least the duration asked for and that
       coverage describes the series it actually returned. */
    assert(rows.length >= 8, `2h in 15m buckets must cover at least 8 rows, got ${rows.length}`)
    const coverage = series.data._coverage
    assert(
      coverage.expected_buckets === rows.length && coverage.returned_buckets === rows.length,
      `coverage must describe the series it returned: expected ${coverage.expected_buckets}, returned ${coverage.returned_buckets}, rows ${rows.length}`,
    )
    const spanSeconds = rows[rows.length - 1].timestamp - rows[0].timestamp + 15 * 60
    assert(spanSeconds >= 2 * 60 * 60, `the series must span at least the 2h asked for, got ${spanSeconds}s`)
    assert(
      rows.some((row) => row.blocks_in_bucket > 0 && row.value > 0),
      'populated fee buckets must be non-zero',
    )
    assert(
      rows.every((row) => row.blocks_in_bucket === 0 || BigInt(row.value_sats) > 0n),
      'every bucket with blocks must carry fees',
    )
    const bucketSum = rows.reduce((sum, row) => sum + BigInt(row.value_sats), 0n)
    assert(
      bucketSum.toString() === summary.total_fees_sats,
      `bucket sum ${bucketSum} must equal the window total ${summary.total_fees_sats}`,
    )
    assert(
      rows.every((row) => satsToBtcString(BigInt(row.value_sats)) === row.value_btc),
      'bucket BTC strings must be exact conversions',
    )
    assert(
      summary.bucket_alignment === 'anchored_to_latest_block' && summary.window_anchor === 'latest_block',
      'the series must declare its bucket anchoring',
    )
    /* Not "must be complete". A Bitcoin duration window is resolved by
       estimating where 2h ago falls between irregular block times, and when
       that boundary is not verified the response says so by declaring the
       window incomplete. What must hold is that the two blocks answering that
       question agree, and that an incomplete window is explained rather than
       asserted. */
    const gaps = series.data.gap_diagnostics
    assert(
      coverage.window_complete === gaps.window_complete,
      `_coverage and gap_diagnostics must agree on window_complete: ${coverage.window_complete} vs ${gaps.window_complete}`,
    )
    if (coverage.window_complete === false) {
      assert(
        !freshnessProvesExactWindow(series.data._freshness),
        'an incomplete fee window must be explained by an estimated boundary in _freshness',
      )
    }
    const seriesDirect = await directFeeSats(summary.from_block, summary.to_block)
    const inWindowSats = rows.reduce((sum, row) => sum + BigInt(row.value_sats), 0n)
    assert(
      seriesDirect.sats >= inWindowSats,
      `direct rows for the scanned range must contain at least the bucketed fees (blocks before the series start are not bucketed): direct ${seriesDirect.sats} sats over ${seriesDirect.blocks} blocks ${summary.from_block}-${summary.to_block}, buckets ${inWindowSats} sats over ${rows.reduce((sum: number, row: Record<string, any>) => sum + Number(row.blocks_in_bucket), 0)} blocks, scanned_blocks ${summary.scanned_blocks}`,
    )
    console.log(
      `PASS  live fees_btc buckets reconcile to the exact window total (${summary.total_fees_btc} BTC over ${summary.scanned_blocks} blocks)`,
    )

    const ohlc = await callToolWithRetry(
      connected.client,
      'portal_hyperliquid_get_ohlc',
      { coin: 'BTC', interval: '1h', timeframe: '3h', limit: 5 },
      { requestTimeoutMs: 120_000, totalBudgetMs: 200_000 },
    )
    if (ohlc.isError && isBoundedUpstreamToolError(ohlc)) {
      console.log(`BOUNDED  Hyperliquid OHLC could not run: upstream overload (${ohlc.text.slice(0, 120)})`)
      return 'bounded'
    }
    assert(!ohlc.isError, `live Hyperliquid OHLC must succeed: ${ohlc.text.slice(0, 300)}`)
    assert(
      ohlc.data.summary?.bucket_alignment === 'interval_boundary',
      'OHLC candles must declare interval-boundary alignment',
    )
    assert(
      ohlc.data.summary.bucket_alignment !== summary.bucket_alignment,
      'generic series and OHLC candles declare different alignments so a consumer cannot silently join them bucket for bucket',
    )
    console.log('PASS  bucket anchoring is declared on generic series and OHLC candles')
    return 'pass'
  } finally {
    await closeTestClient(connected)
  }
}

async function main() {
  assertOfflineInvariants()
  const live = await assertLiveParity()
  if (live === 'bounded') {
    console.log(
      'BOUNDED  live Bitcoin fee parity was not proven this run because Portal was overloaded; the offline invariants passed',
    )
    return
  }
  console.log('PASS  Bitcoin fee truth gate')
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
})
