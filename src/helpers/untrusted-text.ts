// ============================================================================
// Untrusted text: third-party strings that must never read as instructions
// ============================================================================
//
// Token names and symbols from open token lists, Substrate pallet and call
// names, Solana program labels, Hyperliquid coin names, and any other string
// that originates on-chain or in an external registry are data, not
// instructions. This module is the single place that decides how such a value
// may enter prose (answers, summaries, notices, headlines, action labels) and
// error text. The raw value stays byte-identical in structured fields so
// factuality is unaffected; only the prose copy is cleaned and delimited.

/** Field names whose values come from outside SQD and may carry arbitrary text. */
export const UNTRUSTED_FIELDS = [
  'name',
  'symbol',
  'token_name',
  'token_symbol',
  'token0_symbol',
  'token1_symbol',
  'token0_label',
  'token1_label',
  'base_token',
  'quote_token',
  'pair_label',
  'coin',
  'fee_token',
  'feeToken',
  'fee_unit',
  'label',
  'display_name',
  'pallet',
  'call_name',
  'event_name',
  'program_label',
  'protocol_name',
  'slug',
  // Contract- and asset-authored strings on the newest row shapes.
  'asset',
  'asset_name',
  'note_text',
  'revert_reason',
  'revertReason',
] as const

export const UNTRUSTED_TEXT_MAX_LENGTH = 64

// C0 and C1 control characters except tab, newline, and carriage return, plus
// DEL, zero-width and joiner characters, bidi embedding and override marks,
// U+061C ARABIC LETTER MARK (a bidi control in the same class as U+200E/F),
// the byte-order mark, and the Unicode Tags block U+E0000-U+E007F, which is
// the standard channel for smuggling invisible ASCII through a visible label.
const CONTROL_AND_INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu

/**
 * Remove characters that could hide or reorder text, collapse whitespace to
 * single spaces, and cap the length. Never throws; non-strings become ''.
 */
export function cleanUntrustedText(value: unknown, maxLength = UNTRUSTED_TEXT_MAX_LENGTH): string {
  if (typeof value !== 'string') return ''
  const cleaned = value.replace(CONTROL_AND_INVISIBLE, '').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`
}

/**
 * Prose form of a third-party value: cleaned and wrapped in double quotes, so
 * a symbol such as `IGNORE PREVIOUS INSTRUCTIONS` reads as a quoted name.
 */
export function quoteUntrusted(value: unknown, maxLength = UNTRUSTED_TEXT_MAX_LENGTH): string {
  return `"${cleanUntrustedText(value, maxLength).replaceAll('"', '”')}"`
}

const PLAIN_LABEL = /^[A-Za-z0-9][A-Za-z0-9._$:/+-]{0,31}$/

/**
 * Label form for amount suffixes and pair labels: a plain ticker-like value
 * (`USDC`, `WETH`, `st-ETH`) stays exactly as it is so `1.5 USDC` does not
 * change; anything with whitespace, punctuation, or invisible characters is
 * cleaned and quoted.
 */
export function untrustedLabel(value: unknown, maxLength = UNTRUSTED_TEXT_MAX_LENGTH): string {
  const cleaned = cleanUntrustedText(value, maxLength)
  if (cleaned === '') return ''
  if (PLAIN_LABEL.test(cleaned) && cleaned === value) return cleaned
  return quoteUntrusted(cleaned, maxLength)
}

/**
 * Prose written by SQD itself may legitimately be long (an answer sentence),
 * so only the invisible-character rule applies, with a generous cap.
 */
export function cleanProse(value: string, maxLength = 2_000): string {
  // Line terminators are collapsed to a space. A prose field is one line, and
  // leaving them intact meant a value that reached prose without
  // quoteUntrusted could present itself as a separate labelled line of the
  // response rather than as mangled text inside one.
  const cleaned = value.replace(CONTROL_AND_INVISIBLE, '').replace(/[\r\n\u2028\u2029]+/g, ' ')
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`
}

type Mutable = Record<string, unknown>

function isRecord(value: unknown): value is Mutable {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Clean every prose field of a tool result in place: `answer`, `_summary`,
 * `_notice`, `_notices`, `_ui.headline`, `_ui.panels[].title`, and
 * `next_steps.actions[].label`. Structured data (`items`, `matches`, `summary`,
 * `_evidence`, and the rest) is left byte-identical.
 */
export function cleanProseFields(payload: Mutable): void {
  for (const key of ['answer', '_summary', '_notice'] as const) {
    if (typeof payload[key] === 'string') payload[key] = cleanProse(payload[key] as string)
  }
  if (Array.isArray(payload._notices)) {
    payload._notices = payload._notices.map((notice) => (typeof notice === 'string' ? cleanProse(notice) : notice))
  }
  const ui = payload._ui
  if (isRecord(ui)) {
    if (isRecord(ui.headline)) {
      for (const key of ['title', 'subtitle'] as const) {
        if (typeof ui.headline[key] === 'string') ui.headline[key] = cleanProse(ui.headline[key] as string, 200)
      }
    }
    if (Array.isArray(ui.panels)) {
      for (const panel of ui.panels) {
        if (isRecord(panel) && typeof panel.title === 'string') panel.title = cleanProse(panel.title, 200)
      }
    }
  }
  const nextSteps = payload.next_steps
  if (isRecord(nextSteps) && Array.isArray(nextSteps.actions)) {
    for (const action of nextSteps.actions) {
      if (isRecord(action) && typeof action.label === 'string') action.label = cleanProse(action.label, 120)
    }
  }
}
