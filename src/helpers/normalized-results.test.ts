import assert from 'node:assert/strict'
import { it } from 'node:test'

import { normalizeHyperliquidFillResult } from './normalized-results.js'

it('keeps Hyperliquid PnL in the quote asset when the fee uses another token', () => {
  const fill = normalizeHyperliquidFillResult({ fee: '-0.25', feeToken: 'HYPE', closedPnl: '-0.0949' })
  assert.equal(fill.fee_unit, 'HYPE')
  assert.equal(fill.closedPnl, '-0.0949')
  assert.equal(fill.closed_pnl_unit, 'quote asset')
})
