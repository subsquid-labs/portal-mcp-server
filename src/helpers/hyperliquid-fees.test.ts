import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  accumulateHyperliquidFee,
  createHyperliquidFeeAccumulator,
  summarizeHyperliquidFees,
} from './hyperliquid-fees.js'

const summarize = (fills: Record<string, unknown>[]) => {
  const totals = createHyperliquidFeeAccumulator()
  for (const fill of fills) accumulateHyperliquidFee(totals, fill)
  return summarizeHyperliquidFees(totals)
}

test('known USDC fees preserve signed rebates and exact token amounts', () => {
  const result = summarize([
    { fee: '0.1', feeToken: 'USDC' },
    { fee: '0.2', feeToken: 'USDC' },
    { fee: '-0.4', feeToken: 'USDC' },
  ])
  assert.equal(result.total_fees_usd, -0.1)
  assert.equal(result.fees_status, 'available')
  assert.deepEqual(result.fees_by_token, [{ fee_token: 'USDC', total_fees: '-0.1' }])
  assert.equal(result.unknown_fee_token_fills, 0)
  assert.equal(result.invalid_fee_fills, 0)
})

test('zero fees are available when the source explicitly reports zero USDC', () => {
  assert.equal(summarize([{ fee: '0', feeToken: 'USDC' }]).total_fees_usd, 0)
})

test('known token units remain separate even when their sum would be zero', () => {
  const result = summarize([
    { fee: '1', feeToken: 'USDC' },
    { fee: '-1', feeToken: 'HYPE' },
  ])
  assert.equal(result.total_fees_usd, null)
  assert.equal(result.fees_status, 'unavailable')
  assert.deepEqual(result.fees_by_token, [
    { fee_token: 'HYPE', total_fees: '-1' },
    { fee_token: 'USDC', total_fees: '1' },
  ])
})

test('an amount with no known unit cannot be added to the known USDC total', () => {
  const result = summarize([{ fee: '1', feeToken: 'USDC' }, { fee: '2' }])
  assert.equal(result.total_fees_usd, null)
  assert.equal(result.unknown_fee_token_fills, 1)
  assert.deepEqual(result.fees_by_token, [{ fee_token: 'USDC', total_fees: '1' }])
})

test('an invalid amount makes that token total unavailable instead of reporting a partial sum', () => {
  const result = summarize([
    { fee: '1', feeToken: 'USDC' },
    { fee: 'invalid', feeToken: 'USDC' },
    { fee: '-0.5', feeToken: 'HYPE' },
  ])
  assert.equal(result.total_fees_usd, null)
  assert.equal(result.invalid_fee_fills, 1)
  assert.deepEqual(result.fees_by_token, [
    { fee_token: 'HYPE', total_fees: '-0.5' },
    { fee_token: 'USDC', total_fees: null },
  ])
})

test('token spelling is preserved without assuming an alias is USDC', () => {
  const result = summarize([{ fee: '1', feeToken: 'usdc' }])
  assert.equal(result.total_fees_usd, null)
  assert.deepEqual(result.fees_by_token, [{ fee_token: 'usdc', total_fees: '1' }])
})

test('exact token totals survive numbers too large for the numeric USD field', () => {
  const result = summarize([{ fee: '1e400', feeToken: 'USDC' }])
  assert.equal(result.total_fees_usd, null)
  assert.deepEqual(result.fees_by_token, [{ fee_token: 'USDC', total_fees: `1${'0'.repeat(400)}` }])
})
