import {
  EXACT_DECIMAL_ZERO,
  type ExactDecimal,
  addExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
} from './exact-decimal.js'

export const HYPERLIQUID_FEE_NOTICE =
  'A USD fee total is unavailable for missing, invalid, non-USDC, or numerically unrepresentable fees. Amounts remain grouped by their reported fee tokens without exchange-rate conversion.'

type TokenFeeTotals = {
  amount: ExactDecimal
  invalidFees: number
}

export type HyperliquidFeeAccumulator = {
  byToken: Map<string, TokenFeeTotals>
  unknownTokenFills: number
  invalidFeeFills: number
}

export function createHyperliquidFeeAccumulator(): HyperliquidFeeAccumulator {
  return { byToken: new Map(), unknownTokenFills: 0, invalidFeeFills: 0 }
}

export function accumulateHyperliquidFee(totals: HyperliquidFeeAccumulator, fill: Record<string, unknown>): void {
  const token = typeof fill.feeToken === 'string' && fill.feeToken.trim() !== '' ? fill.feeToken : undefined
  const amount = parseExactDecimal(fill.fee)
  if (!amount) totals.invalidFeeFills += 1
  if (token === undefined) {
    totals.unknownTokenFills += 1
    return
  }

  let tokenTotals = totals.byToken.get(token)
  if (!tokenTotals) {
    tokenTotals = { amount: EXACT_DECIMAL_ZERO, invalidFees: 0 }
    totals.byToken.set(token, tokenTotals)
  }
  if (amount) tokenTotals.amount = addExactDecimals(tokenTotals.amount, amount)
  else tokenTotals.invalidFees += 1
}

export function summarizeHyperliquidFees(totals: HyperliquidFeeAccumulator) {
  const feesByToken = [...totals.byToken.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([feeToken, tokenTotals]) => ({
      fee_token: feeToken,
      total_fees: tokenTotals.invalidFees === 0 ? formatExactDecimal(tokenTotals.amount) : null,
    }))
  const usdc = totals.byToken.get('USDC')
  const usdcTotal =
    totals.unknownTokenFills === 0 && totals.invalidFeeFills === 0 && totals.byToken.size === 1 && usdc
      ? Number(formatExactDecimal(usdc.amount))
      : Number.NaN
  const usdTotal = Number.isFinite(usdcTotal) ? Number.parseFloat(usdcTotal.toFixed(2)) : null

  return {
    total_fees_usd: usdTotal,
    fees_status: usdTotal === null ? ('unavailable' as const) : ('available' as const),
    fees_by_token: feesByToken,
    unknown_fee_token_fills: totals.unknownTokenFills,
    invalid_fee_fills: totals.invalidFeeFills,
    ...(usdTotal === null ? { fee_notice: HYPERLIQUID_FEE_NOTICE } : {}),
  }
}
