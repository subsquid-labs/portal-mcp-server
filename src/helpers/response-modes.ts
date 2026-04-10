// Response format modes for context optimization
// Reduces token usage by 50-95% depending on mode

export type ResponseFormat = 'full' | 'compact' | 'summary'

function getBlockNumber(item: any): number | undefined {
  return item.block_number ?? item.blockNumber ?? item.slot_number ?? item.block?.number
}

function getTimestamp(item: any): number | undefined {
  return item.timestamp ?? item.block?.timestamp
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function pickCommonAliases(item: any): Record<string, unknown> {
  const aliases: Record<string, unknown> = {}

  for (const key of [
    'chain_kind',
    'record_type',
    'primary_id',
    'tx_hash',
    'sender',
    'recipient',
    'block_number',
    'slot_number',
    'timestamp',
    'timestamp_human',
  ]) {
    if (item?.[key] !== undefined) {
      aliases[key] = item[key]
    }
  }

  return aliases
}

/**
 * Summarize log data - reduces by ~95%
 * Example: 100 logs → "73 Transfer events, 16 Swap events, 11 other"
 */
export function summarizeLogs(logs: any[]): any {
  if (logs.length === 0) {
    return { count: 0, summary: 'No logs found' }
  }

  // Group by address
  const byAddress = new Map<string, number>()
  const byTopic0 = new Map<string, number>()

  logs.forEach((log) => {
    const addr = log.address || 'unknown'
    const topic0 = log.topic0 || log.topics?.[0] || 'unknown'

    byAddress.set(addr, (byAddress.get(addr) || 0) + 1)
    byTopic0.set(topic0, (byTopic0.get(topic0) || 0) + 1)
  })

  // Get top contracts and event types
  const topAddresses = Array.from(byAddress.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([addr, count]) => ({ address: addr, count }))

  const topEvents = Array.from(byTopic0.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic0: topic, count }))

  // Block range
  const blocks = logs.map((l) => getBlockNumber(l)).filter(isNumber)
  const blockRange =
    blocks.length > 0
      ? {
          from: Math.min(...blocks),
          to: Math.max(...blocks),
        }
      : undefined

  return {
    total_logs: logs.length,
    unique_contracts: byAddress.size,
    unique_event_types: byTopic0.size,
    top_contracts: topAddresses,
    top_event_types: topEvents,
    block_range: blockRange,
  }
}

/**
 * Summarize transaction data - reduces by ~90%
 */
export function summarizeTransactions(txs: any[]): any {
  if (txs.length === 0) {
    return { count: 0, summary: 'No transactions found' }
  }

  // Count unique addresses
  const fromAddresses = new Set<string>()
  const toAddresses = new Set<string>()
  let totalValue = BigInt(0)
  let totalGas = BigInt(0)

  txs.forEach((tx) => {
    if (tx.from) fromAddresses.add(tx.from)
    if (tx.to) toAddresses.add(tx.to)
    if (tx.value) {
      try {
        totalValue += BigInt(tx.value)
      } catch {}
    }
    if (tx.gas) {
      try {
        totalGas += BigInt(tx.gas)
      } catch {}
    }
  })

  // Block range
  const blocks = txs.map((t) => getBlockNumber(t)).filter(isNumber)
  const blockRange =
    blocks.length > 0
      ? {
          from: Math.min(...blocks),
          to: Math.max(...blocks),
        }
      : undefined

  // Top senders/receivers
  const fromCounts = new Map<string, number>()
  const toCounts = new Map<string, number>()

  txs.forEach((tx) => {
    if (tx.from) fromCounts.set(tx.from, (fromCounts.get(tx.from) || 0) + 1)
    if (tx.to) toCounts.set(tx.to, (toCounts.get(tx.to) || 0) + 1)
  })

  const topSenders = Array.from(fromCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([addr, count]) => ({ address: addr, transaction_count: count }))

  const topReceivers = Array.from(toCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([addr, count]) => ({ address: addr, transaction_count: count }))

  return {
    total_transactions: txs.length,
    unique_senders: fromAddresses.size,
    unique_receivers: toAddresses.size,
    total_value_wei: totalValue.toString(),
    total_gas: totalGas.toString(),
    top_senders: topSenders,
    top_receivers: topReceivers,
    block_range: blockRange,
  }
}

/**
 * Compact logs - strip verbose fields, keep essentials
 * Reduces by ~60-70%
 */
export function compactLogs(logs: any[]): any[] {
  return logs.map((log) => ({
    ...pickCommonAliases(log),
    address: log.address,
    contract_address: log.contract_address || log.address,
    topic0: log.topic0 || log.topics?.[0],
    topics: log.topics,
    blockNumber: getBlockNumber(log),
    timestamp: getTimestamp(log),
  }))
}

/**
 * Compact transactions - strip verbose fields
 * Reduces by ~50-60%
 */
export function compactTransactions(txs: any[]): any[] {
  return txs.map((tx) => ({
    ...pickCommonAliases(tx),
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    blockNumber: getBlockNumber(tx),
    timestamp: getTimestamp(tx),
  }))
}

/**
 * Summarize Hyperliquid fills - reduces by ~90%
 */
export function summarizeHyperliquidFills(fills: any[]): any {
  if (fills.length === 0) return { count: 0, summary: 'No fills found' }

  const traders = new Set<string>()
  const coins = new Set<string>()
  const dirCounts: Record<string, number> = {}
  let totalVolume = 0, totalFees = 0, totalPnl = 0

  fills.forEach((fill) => {
    if (fill.user) traders.add(fill.user)
    if (fill.coin) coins.add(fill.coin)
    totalVolume += (fill.px || 0) * (fill.sz || 0)
    totalFees += Math.abs(fill.fee || 0)
    totalPnl += fill.closedPnl || 0
    const dir = fill.dir || 'Unknown'
    dirCounts[dir] = (dirCounts[dir] || 0) + 1
  })

  const byCoin = new Map<string, number>()
  fills.forEach((f) => {
    const c = f.coin || 'unknown'
    byCoin.set(c, (byCoin.get(c) || 0) + (f.px || 0) * (f.sz || 0))
  })
  const topCoins = Array.from(byCoin.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([coin, volume]) => ({ coin, volume_usd: parseFloat(volume.toFixed(2)) }))

  return {
    total_fills: fills.length,
    unique_traders: traders.size,
    unique_coins: coins.size,
    total_volume_usd: parseFloat(totalVolume.toFixed(2)),
    total_fees_usd: parseFloat(totalFees.toFixed(2)),
    total_realized_pnl: parseFloat(totalPnl.toFixed(2)),
    direction_breakdown: dirCounts,
    top_coins_by_volume: topCoins,
  }
}

/**
 * Compact Hyperliquid fills - strip noise, keep trading essentials
 */
export function compactHyperliquidFills(fills: any[]): any[] {
  return fills.map((fill) => ({
    ...pickCommonAliases(fill),
    user: fill.user,
    coin: fill.coin,
    px: fill.px,
    sz: fill.sz,
    side: fill.side,
    dir: fill.dir,
    fee: fill.fee,
    closedPnl: fill.closedPnl,
    timestamp: fill.block_timestamp || fill.time,
  }))
}

/**
 * Summarize Solana transactions - reduces by ~90%
 */
export function summarizeSolanaTransactions(txs: any[]): any {
  if (txs.length === 0) return { count: 0, summary: 'No transactions found' }

  const feePayers = new Set<string>()
  let totalFees = 0, totalComputeUnits = 0
  let errorCount = 0

  txs.forEach((tx) => {
    if (tx.feePayer) feePayers.add(tx.feePayer)
    totalFees += parseInt(tx.fee || '0') || 0
    totalComputeUnits += parseInt(tx.computeUnitsConsumed || '0') || 0
    if (tx.err) errorCount++
  })

  const topFeePayers = new Map<string, number>()
  txs.forEach((tx) => {
    if (tx.feePayer) topFeePayers.set(tx.feePayer, (topFeePayers.get(tx.feePayer) || 0) + 1)
  })

  return {
    total_transactions: txs.length,
    unique_fee_payers: feePayers.size,
    total_fees_lamports: totalFees,
    total_compute_units: totalComputeUnits,
    avg_fee: Math.round(totalFees / txs.length),
    avg_compute_units: Math.round(totalComputeUnits / txs.length),
    error_count: errorCount,
    success_rate: parseFloat(((1 - errorCount / txs.length) * 100).toFixed(1)),
    top_fee_payers: Array.from(topFeePayers.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([address, count]) => ({ address, transaction_count: count })),
  }
}

/**
 * Compact Solana transactions
 */
export function compactSolanaTransactions(txs: any[]): any[] {
  return txs.map((tx) => ({
    ...pickCommonAliases(tx),
    signature: tx.signature || tx.tx_hash,
    feePayer: tx.feePayer,
    fee: tx.fee,
    computeUnits: tx.computeUnitsConsumed,
    error: tx.err || null,
  }))
}

/**
 * Summarize Bitcoin transactions - reduces by ~90%
 */
export function summarizeBitcoinTransactions(txs: any[]): any {
  if (txs.length === 0) return { count: 0, summary: 'No transactions found' }

  let totalSize = 0, totalVsize = 0, totalWeight = 0
  const versions = new Map<number, number>()

  txs.forEach((tx) => {
    totalSize += tx.size || 0
    totalVsize += tx.vsize || 0
    totalWeight += tx.weight || 0
    const v = tx.version || 0
    versions.set(v, (versions.get(v) || 0) + 1)
  })

  const blocks = txs.map((t) => getBlockNumber(t)).filter(isNumber)
  const blockRange = blocks.length > 0 ? { from: Math.min(...blocks), to: Math.max(...blocks) } : undefined

  return {
    total_transactions: txs.length,
    avg_size: Math.round(totalSize / txs.length),
    avg_vsize: Math.round(totalVsize / txs.length),
    avg_weight: Math.round(totalWeight / txs.length),
    total_size: totalSize,
    total_weight: totalWeight,
    version_breakdown: Object.fromEntries(versions),
    block_range: blockRange,
  }
}

/**
 * Compact Bitcoin transactions - keep essentials only
 */
export function compactBitcoinTransactions(txs: any[]): any[] {
  return txs.map((tx) => ({
    ...pickCommonAliases(tx),
    hash: tx.hash,
    txid: tx.txid,
    size: tx.size,
    vsize: tx.vsize,
    weight: tx.weight,
  }))
}

/**
 * Summarize Bitcoin inputs
 */
export function summarizeBitcoinInputs(inputs: any[]): any {
  if (inputs.length === 0) return { count: 0, summary: 'No inputs found' }

  const addresses = new Set<string>()
  const scriptTypes = new Map<string, number>()
  const types = new Map<string, number>()
  let totalValue = 0

  inputs.forEach((input) => {
    if (input.prevoutScriptPubKeyAddress) addresses.add(input.prevoutScriptPubKeyAddress)
    const sType = input.prevoutScriptPubKeyType || 'unknown'
    scriptTypes.set(sType, (scriptTypes.get(sType) || 0) + 1)
    const iType = input.type || 'tx'
    types.set(iType, (types.get(iType) || 0) + 1)
    totalValue += input.prevoutValue || 0
  })

  return {
    total_inputs: inputs.length,
    unique_addresses: addresses.size,
    total_value_btc: parseFloat(totalValue.toFixed(8)),
    script_type_breakdown: Object.fromEntries(scriptTypes),
    input_type_breakdown: Object.fromEntries(types),
    top_addresses: Array.from(addresses).slice(0, 10),
  }
}

/**
 * Compact Bitcoin inputs
 */
export function compactBitcoinInputs(inputs: any[]): any[] {
  return inputs.map((input) => ({
    ...pickCommonAliases(input),
    txid: input.txid,
    input_index: input.inputIndex ?? input.input_index,
    vout: input.vout,
    address: input.prevoutScriptPubKeyAddress,
    value: input.prevoutValue,
    type: input.type,
  }))
}

/**
 * Summarize Bitcoin outputs
 */
export function summarizeBitcoinOutputs(outputs: any[]): any {
  if (outputs.length === 0) return { count: 0, summary: 'No outputs found' }

  const addresses = new Set<string>()
  const scriptTypes = new Map<string, number>()
  let totalValue = 0

  outputs.forEach((output) => {
    if (output.scriptPubKeyAddress) addresses.add(output.scriptPubKeyAddress)
    const sType = output.scriptPubKeyType || 'unknown'
    scriptTypes.set(sType, (scriptTypes.get(sType) || 0) + 1)
    totalValue += output.value || 0
  })

  return {
    total_outputs: outputs.length,
    unique_addresses: addresses.size,
    total_value_btc: parseFloat(totalValue.toFixed(8)),
    script_type_breakdown: Object.fromEntries(scriptTypes),
    top_addresses: Array.from(addresses).slice(0, 10),
  }
}

/**
 * Compact Bitcoin outputs
 */
export function compactBitcoinOutputs(outputs: any[]): any[] {
  return outputs.map((output) => ({
    ...pickCommonAliases(output),
    index: output.outputIndex,
    address: output.scriptPubKeyAddress,
    value: output.value,
    type: output.scriptPubKeyType,
  }))
}

/**
 * Apply response format to data
 */
export function applyResponseFormat(
  data: any,
  format: ResponseFormat,
  dataType: 'logs' | 'transactions' | 'bitcoin_transactions' | 'bitcoin_inputs' | 'bitcoin_outputs' | 'hyperliquid_fills' | 'solana_transactions',
): any {
  if (format === 'full' || !Array.isArray(data)) {
    return data
  }

  if (format === 'summary') {
    switch (dataType) {
      case 'logs': return summarizeLogs(data)
      case 'transactions': return summarizeTransactions(data)
      case 'bitcoin_transactions': return summarizeBitcoinTransactions(data)
      case 'bitcoin_inputs': return summarizeBitcoinInputs(data)
      case 'bitcoin_outputs': return summarizeBitcoinOutputs(data)
      case 'hyperliquid_fills': return summarizeHyperliquidFills(data)
      case 'solana_transactions': return summarizeSolanaTransactions(data)
      default: return data
    }
  }

  if (format === 'compact') {
    switch (dataType) {
      case 'logs': return compactLogs(data)
      case 'transactions': return compactTransactions(data)
      case 'bitcoin_transactions': return compactBitcoinTransactions(data)
      case 'bitcoin_inputs': return compactBitcoinInputs(data)
      case 'bitcoin_outputs': return compactBitcoinOutputs(data)
      case 'hyperliquid_fills': return compactHyperliquidFills(data)
      case 'solana_transactions': return compactSolanaTransactions(data)
      default: return data
    }
  }

  return data
}
