/**
 * Formatting helpers for human-readable output
 * Converts raw blockchain data (hex, wei, unix timestamps) to readable format
 */

/**
 * Convert hex string to decimal number
 */
export function hexToNumber(hex: string): number {
  if (!hex || hex === '0x' || hex === '0x0') return 0
  return parseInt(hex, 16)
}

/**
 * Convert hex string to bigint (for large values like wei)
 */
export function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x' || hex === '0x0') return 0n
  return BigInt(hex)
}

/**
 * Convert wei (hex or string) to ETH with specified decimals
 */
export function weiToEth(wei: string | bigint, decimals: number = 18): string {
  const weiValue = typeof wei === 'string' ? hexToBigInt(wei) : wei
  const divisor = 10n ** BigInt(decimals)
  const ethValue = Number(weiValue) / Number(divisor)

  // Format based on magnitude
  if (ethValue === 0) return '0'
  if (ethValue < 0.000001) return ethValue.toExponential(4)
  if (ethValue < 0.01) return ethValue.toFixed(6)
  if (ethValue < 1) return ethValue.toFixed(4)
  if (ethValue < 1000) return ethValue.toFixed(2)
  return ethValue.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/**
 * Convert wei to Gwei (for gas prices)
 */
export function weiToGwei(wei: string | bigint): string {
  const weiValue = typeof wei === 'string' ? hexToBigInt(wei) : wei
  const gwei = Number(weiValue) / 1e9

  if (gwei === 0) return '0'
  if (gwei < 0.01) return gwei.toFixed(4)
  if (gwei < 100) return gwei.toFixed(2)
  return gwei.toFixed(1)
}

/**
 * Format token amount with decimals and symbol
 */
export function formatTokenAmount(value: string, decimals: number = 18, symbol?: string): string {
  const formatted = weiToEth(value, decimals)
  return symbol ? `${formatted} ${symbol}` : formatted
}

/**
 * Convert unix timestamp to human-readable date
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return date.toISOString().replace('T', ' ').split('.')[0] + ' UTC'
}

/**
 * Convert unix timestamp to relative time (e.g., "2 hours ago")
 */
export function formatTimestampRelative(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp

  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return formatTimestamp(timestamp)
}

/**
 * Format gas value (hex) to readable format
 */
export function formatGas(gasHex: string): {
  raw: string
  decimal: number
  formatted: string
} {
  const decimal = hexToNumber(gasHex)
  return {
    raw: gasHex,
    decimal,
    formatted: decimal.toLocaleString('en-US'),
  }
}

/**
 * Format gas price (hex) to Gwei
 */
export function formatGasPrice(gasPriceHex: string): {
  raw: string
  gwei: string
  formatted: string
} {
  const gwei = weiToGwei(gasPriceHex)
  return {
    raw: gasPriceHex,
    gwei,
    formatted: `${gwei} Gwei`,
  }
}

/**
 * Format transaction value (hex) to ETH
 */
export function formatValue(valueHex: string): {
  raw: string
  eth: string
  formatted: string
} {
  const eth = weiToEth(valueHex)
  return {
    raw: valueHex,
    eth,
    formatted: `${eth} ETH`,
  }
}

/**
 * Check if a string looks like a hex value (0x prefixed, all hex chars)
 */
function isHexValue(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) && value.length > 4
}

/**
 * Check if a value is any hex string (including short ones like 0x0)
 */
function isAnyHexValue(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}

/**
 * Convert hex fields in a transaction object to human-readable values.
 * Converts value/gas/gasPrice/etc inline so LLMs and users can read them.
 */
export function formatTransactionFields(tx: Record<string, unknown>): Record<string, unknown> {
  const result = { ...tx }

  // Convert value (wei → ETH) — use isAnyHexValue to catch 0x0 too
  if (isAnyHexValue(result.value)) {
    const ethValue = weiToEth(result.value as string)
    result.value_eth = ethValue
    delete result.value
  }

  // Convert gas prices (wei → Gwei)
  for (const field of ['gasPrice', 'effectiveGasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    if (isHexValue(result[field])) {
      result[`${field}_gwei`] = weiToGwei(result[field] as string)
      delete result[field]
    }
  }

  // Convert gas amounts (hex → decimal)
  for (const field of ['gas', 'gasUsed', 'cumulativeGasUsed']) {
    if (isHexValue(result[field])) {
      result[field] = hexToNumber(result[field] as string)
    }
  }

  // Convert nonce, transactionIndex, type, status (hex → decimal)
  for (const field of ['nonce', 'transactionIndex', 'type', 'status']) {
    if (isHexValue(result[field])) {
      result[field] = hexToNumber(result[field] as string)
    }
  }

  // Convert L2 fee fields
  if (isHexValue(result.l1Fee)) {
    result.l1Fee_eth = weiToEth(result.l1Fee as string)
    delete result.l1Fee
  }
  if (isHexValue(result.l1GasUsed)) {
    result.l1GasUsed = hexToNumber(result.l1GasUsed as string)
  }
  if (isHexValue(result.l1GasPrice)) {
    result.l1GasPrice_gwei = weiToGwei(result.l1GasPrice as string)
    delete result.l1GasPrice
  }

  // Remove noise fields that waste context
  for (const field of ['v', 'r', 's', 'yParity', 'logsBloom']) {
    delete result[field]
  }

  return result
}

/**
 * Shorten address for display (0x1234...5678)
 */
export function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/**
 * Format address with optional label
 */
export function formatAddress(address: string, label?: string): string {
  if (label) return `${label} (${shortenAddress(address)})`
  return address
}
