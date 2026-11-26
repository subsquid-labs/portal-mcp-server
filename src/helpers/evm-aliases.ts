import { EVENT_SIGNATURES } from '../constants/index.js'
import { ActionableError } from './errors.js'

const METHOD_ALIASES: Record<string, string[]> = {
  approve: ['0x095ea7b3'],
  approval: ['0x095ea7b3'],
  transfer: ['0xa9059cbb'],
  transferfrom: ['0x23b872dd'],
  transfer_from: ['0x23b872dd'],
  safe_transfer_from: ['0x42842e0e', '0xb88d4fde'],
  safetransferfrom: ['0x42842e0e', '0xb88d4fde'],
  deposit: ['0xd0e30db0'],
  withdraw: ['0x2e1a7d4d'],
  swap: [
    '0x414bf389', // Uniswap V3 exactInputSingle
    '0x04e45aaf', // Uniswap SwapRouter02 exactInputSingle
    '0xc04b8d59', // Uniswap V3 exactInput
    '0x3593564c', // Uniswap Universal Router execute
    '0x38ed1739', // Uniswap V2 swapExactTokensForTokens
    '0x7ff36ab5', // Uniswap V2 swapExactETHForTokens
    '0x18cbafe5', // Uniswap V2 swapExactTokensForETH
  ],
  execute: ['0x3593564c'],
  multicall: ['0xac9650d8', '0x5ae401dc'],
  exact_input_single: ['0x414bf389', '0x04e45aaf'],
  exactinputsingle: ['0x414bf389', '0x04e45aaf'],
  exact_input: ['0xc04b8d59'],
  exactinput: ['0xc04b8d59'],
  swap_exact_tokens_for_tokens: ['0x38ed1739'],
  swapexacttokensfortokens: ['0x38ed1739'],
  swap_exact_eth_for_tokens: ['0x7ff36ab5'],
  swapexactethfortokens: ['0x7ff36ab5'],
  swap_exact_tokens_for_eth: ['0x18cbafe5'],
  swapexacttokensforeth: ['0x18cbafe5'],
}

const EVENT_ALIASES: Record<string, string[]> = {
  transfer: [EVENT_SIGNATURES.TRANSFER_ERC20],
  approval: [EVENT_SIGNATURES.APPROVAL_ERC20],
  approve: [EVENT_SIGNATURES.APPROVAL_ERC20],
  approval_for_all: [EVENT_SIGNATURES.APPROVAL_FOR_ALL],
  approvalforall: [EVENT_SIGNATURES.APPROVAL_FOR_ALL],
  transfer_single: [EVENT_SIGNATURES.TRANSFER_SINGLE],
  transfersingle: [EVENT_SIGNATURES.TRANSFER_SINGLE],
  transfer_batch: [EVENT_SIGNATURES.TRANSFER_BATCH],
  transferbatch: [EVENT_SIGNATURES.TRANSFER_BATCH],
  swap: [EVENT_SIGNATURES.UNISWAP_V2_SWAP, EVENT_SIGNATURES.UNISWAP_V3_SWAP, EVENT_SIGNATURES.UNISWAP_V4_SWAP],
  uniswap_v2_swap: [EVENT_SIGNATURES.UNISWAP_V2_SWAP],
  uniswap_v3_swap: [EVENT_SIGNATURES.UNISWAP_V3_SWAP],
  uniswap_v4_swap: [EVENT_SIGNATURES.UNISWAP_V4_SWAP],
  sync: [EVENT_SIGNATURES.SYNC],
  deposit: [EVENT_SIGNATURES.DEPOSIT],
  withdrawal: [EVENT_SIGNATURES.WITHDRAWAL],
  withdraw: [EVENT_SIGNATURES.WITHDRAWAL],
  mint: [EVENT_SIGNATURES.MINT],
  burn: [EVENT_SIGNATURES.BURN],
  authorization_used: [EVENT_SIGNATURES.AUTHORIZATION_USED],
  authorizationused: [EVENT_SIGNATURES.AUTHORIZATION_USED],
  increase_liquidity: [EVENT_SIGNATURES.INCREASE_LIQUIDITY],
  increaseliquidity: [EVENT_SIGNATURES.INCREASE_LIQUIDITY],
  decrease_liquidity: [EVENT_SIGNATURES.DECREASE_LIQUIDITY],
  decreaseliquidity: [EVENT_SIGNATURES.DECREASE_LIQUIDITY],
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

function normalizeHex4(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!/^0x[0-9a-f]{8}$/.test(trimmed)) {
    throw new ActionableError(
      `Invalid method sighash: ${value}. Use a 4-byte hex string like 0xa9059cbb or a known method alias.`,
      [`Available method aliases: ${listMethodAliases().join(', ')}.`],
      { method: value, available_aliases: listMethodAliases() },
      { code: 'invalid_request', origin: 'client_input', retryable: false },
    )
  }
  return trimmed
}

function normalizeTopic0(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(trimmed)) {
    throw new ActionableError(
      `Invalid event topic0: ${value}. Use a 32-byte topic hash or a known event alias.`,
      [`Available event aliases: ${listEventAliases().join(', ')}.`],
      { event: value, available_aliases: listEventAliases() },
      { code: 'invalid_request', origin: 'client_input', retryable: false },
    )
  }
  return trimmed
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

export function resolveMethodSighashes(method: string | string[] | undefined): string[] {
  return unique(
    asArray(method).flatMap((entry) => {
      const alias = normalizeAlias(entry)
      if (METHOD_ALIASES[alias]) return METHOD_ALIASES[alias]
      return [normalizeHex4(entry)]
    }),
  )
}

export function resolveEventTopic0(event: string | string[] | undefined): string[] {
  return unique(
    asArray(event).flatMap((entry) => {
      const alias = normalizeAlias(entry)
      if (EVENT_ALIASES[alias]) return EVENT_ALIASES[alias]
      return [normalizeTopic0(entry)]
    }),
  )
}

export function listMethodAliases(): string[] {
  return Object.keys(METHOD_ALIASES).sort()
}

export function listEventAliases(): string[] {
  return Object.keys(EVENT_ALIASES).sort()
}
