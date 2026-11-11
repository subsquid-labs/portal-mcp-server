// Response format modes for context optimization
// Reduces token usage by 50-95% depending on mode

import {
  accumulateHyperliquidFee,
  createHyperliquidFeeAccumulator,
  summarizeHyperliquidFees,
} from './hyperliquid-fees.js'

export type ResponseFormat = 'full' | 'compact' | 'summary'

export function resolveDefaultResponseFormat(
  requested: ResponseFormat | undefined,
  options?: {
    preserveFullIf?: boolean
  },
): ResponseFormat {
  if (requested) return requested
  return options?.preserveFullIf ? 'full' : 'compact'
}

function getBlockNumber(item: any): number | undefined {
  return item.block_number ?? item.blockNumber ?? item.slot_number ?? item.block?.number
}

function getTimestamp(item: any): number | undefined {
  return item.timestamp ?? item.block?.timestamp
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Coerce a numeric field to a finite number for aggregation.
 *
 * Normalizers emit exact decimal amounts as text (`px`, `sz`, `fee`,
 * `closedPnl`, Bitcoin values), so `total += item.field || 0` silently turns an
 * accumulator into a string and the later `toFixed` call throws. Every summary
 * aggregate goes through this helper; unparseable or missing values count as 0
 * instead of poisoning the total with NaN.
 */
function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return 0
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
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
    ...(log.decoded_log !== undefined ? { decoded_log: log.decoded_log } : {}),
    ...(log.transaction && typeof log.transaction === 'object' && !Array.isArray(log.transaction)
      ? {
          transaction: compactTransactions([log.transaction])[0],
        }
      : {}),
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
    transactionIndex: tx.transactionIndex,
    type: tx.type,
    nonce: tx.nonce,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    value_eth: tx.value_eth,
    blockNumber: getBlockNumber(tx),
    timestamp: getTimestamp(tx),
    ...(Array.isArray(tx.logs) && tx.logs.length > 0
      ? {
          logs: compactLogs(tx.logs),
        }
      : {}),
    ...(Array.isArray(tx.traces) && tx.traces.length > 0
      ? {
          trace_count: tx.traces.length,
        }
      : {}),
    ...(Array.isArray(tx.state_diffs) && tx.state_diffs.length > 0
      ? {
          state_diff_count: tx.state_diffs.length,
        }
      : {}),
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
  let totalVolume = 0,
    totalPnl = 0
  const fees = createHyperliquidFeeAccumulator()

  const byCoin = new Map<string, number>()
  fills.forEach((fill) => {
    if (fill.user) traders.add(fill.user)
    if (fill.coin) coins.add(fill.coin)
    const notional = toFiniteNumber(fill.px) * toFiniteNumber(fill.sz)
    totalVolume += notional
    accumulateHyperliquidFee(fees, fill)
    totalPnl += toFiniteNumber(fill.closedPnl)
    const dir = fill.dir || 'Unknown'
    dirCounts[dir] = (dirCounts[dir] || 0) + 1
    const coin = fill.coin || 'unknown'
    byCoin.set(coin, (byCoin.get(coin) || 0) + notional)
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
    ...summarizeHyperliquidFees(fees),
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
  let totalFees = 0,
    totalComputeUnits = 0
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
    ...(Array.isArray(tx.instructions) && tx.instructions.length > 0
      ? {
          instruction_count: tx.instructions.length,
        }
      : {}),
    ...(Array.isArray(tx.logs) && tx.logs.length > 0
      ? {
          log_count: tx.logs.length,
        }
      : {}),
    ...(Array.isArray(tx.rewards) && tx.rewards.length > 0
      ? {
          reward_count: tx.rewards.length,
        }
      : {}),
  }))
}

function compactSubstrateExtrinsic(extrinsic: any): Record<string, unknown> | undefined {
  if (!extrinsic || typeof extrinsic !== 'object' || Array.isArray(extrinsic)) return undefined

  const compact = {
    index: extrinsic.index,
    hash: extrinsic.hash,
    version: extrinsic.version,
    success: extrinsic.success,
    fee: extrinsic.fee,
    signer: extrinsic.signer,
    call_name: extrinsic.call_name || extrinsic.name,
  }

  return Object.values(compact).some((value) => value !== undefined) ? compact : undefined
}

function compactSubstrateEventContext(event: any): Record<string, unknown> | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined

  const compact = {
    primary_id: event.primary_id,
    event_name: event.event_name || event.name,
    call_address: event.call_address,
    extrinsic_index: event.extrinsicIndex ?? event.extrinsic_index,
  }

  return Object.values(compact).some((value) => value !== undefined) ? compact : undefined
}

function compactSubstrateCallContext(call: any): Record<string, unknown> | undefined {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return undefined

  const compact = {
    primary_id: call.primary_id,
    call_name: call.call_name || call.name,
    call_address: call.call_address || (Array.isArray(call.address) ? call.address.join('.') : call.address),
    success: call.success,
    extrinsic_index: call.extrinsicIndex ?? call.extrinsic_index,
    block_number: getBlockNumber(call),
    timestamp: getTimestamp(call),
  }

  return Object.values(compact).some((value) => value !== undefined) ? compact : undefined
}

export function summarizeSubstrateEvents(events: any[]): any {
  if (events.length === 0) return { count: 0, summary: 'No events found' }

  const eventNames = new Map<string, number>()
  const blocks = events.map((event) => getBlockNumber(event)).filter(isNumber)

  events.forEach((event) => {
    const name = event.event_name || event.name || 'unknown'
    eventNames.set(name, (eventNames.get(name) || 0) + 1)
  })

  return {
    total_events: events.length,
    unique_event_names: eventNames.size,
    top_event_names: Array.from(eventNames.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    block_range: blocks.length > 0 ? { from: Math.min(...blocks), to: Math.max(...blocks) } : undefined,
  }
}

export function compactSubstrateEvents(events: any[]): any[] {
  return events.map((event) => ({
    ...pickCommonAliases(event),
    event_name: event.event_name || event.name,
    extrinsic_index: event.extrinsicIndex ?? event.extrinsic_index,
    phase: event.phase,
    call_address:
      event.call_address || (Array.isArray(event.callAddress) ? event.callAddress.join('.') : event.callAddress),
    blockNumber: getBlockNumber(event),
    timestamp: getTimestamp(event),
    ...(compactSubstrateExtrinsic(event.extrinsic) ? { extrinsic: compactSubstrateExtrinsic(event.extrinsic) } : {}),
    ...(compactSubstrateCallContext(event.call) ? { call: compactSubstrateCallContext(event.call) } : {}),
    ...(Array.isArray(event.call_stack) && event.call_stack.length > 0
      ? {
          call_stack: event.call_stack
            .map((entry: any) => compactSubstrateCallContext(entry))
            .filter((entry: Record<string, unknown> | undefined): entry is Record<string, unknown> => Boolean(entry)),
        }
      : {}),
  }))
}

export function summarizeSubstrateCalls(calls: any[]): any {
  if (calls.length === 0) return { count: 0, summary: 'No calls found' }

  const callNames = new Map<string, number>()
  const blocks = calls.map((call) => getBlockNumber(call)).filter(isNumber)
  let successCount = 0

  calls.forEach((call) => {
    const name = call.call_name || call.name || 'unknown'
    callNames.set(name, (callNames.get(name) || 0) + 1)
    if (call.success === true) successCount++
  })

  return {
    total_calls: calls.length,
    unique_call_names: callNames.size,
    success_rate: parseFloat(((successCount / calls.length) * 100).toFixed(1)),
    top_call_names: Array.from(callNames.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    block_range: blocks.length > 0 ? { from: Math.min(...blocks), to: Math.max(...blocks) } : undefined,
  }
}

export function compactSubstrateCalls(calls: any[]): any[] {
  return calls.map((call) => ({
    ...pickCommonAliases(call),
    call_name: call.call_name || call.name,
    success: call.success,
    extrinsic_index: call.extrinsicIndex ?? call.extrinsic_index,
    call_address: call.call_address || (Array.isArray(call.address) ? call.address.join('.') : call.address),
    blockNumber: getBlockNumber(call),
    timestamp: getTimestamp(call),
    ...(compactSubstrateExtrinsic(call.extrinsic) ? { extrinsic: compactSubstrateExtrinsic(call.extrinsic) } : {}),
    ...(Array.isArray(call.call_stack) && call.call_stack.length > 0
      ? {
          call_stack: call.call_stack
            .map((entry: any) => compactSubstrateCallContext(entry))
            .filter((entry: Record<string, unknown> | undefined): entry is Record<string, unknown> => Boolean(entry)),
        }
      : {}),
    ...(Array.isArray(call.subcalls) && call.subcalls.length > 0
      ? {
          subcalls: call.subcalls
            .map((entry: any) => compactSubstrateCallContext(entry))
            .filter((entry: Record<string, unknown> | undefined): entry is Record<string, unknown> => Boolean(entry)),
        }
      : {}),
    ...(Array.isArray(call.events) && call.events.length > 0
      ? {
          events: call.events
            .map((entry: any) => compactSubstrateEventContext(entry))
            .filter((entry: Record<string, unknown> | undefined): entry is Record<string, unknown> => Boolean(entry)),
        }
      : {}),
  }))
}

/**
 * Summarize Bitcoin transactions - reduces by ~90%
 */
export function summarizeBitcoinTransactions(txs: any[]): any {
  if (txs.length === 0) return { count: 0, summary: 'No transactions found' }

  let totalSize = 0,
    totalVsize = 0,
    totalWeight = 0
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
    ...(Array.isArray(tx.inputs) && tx.inputs.length > 0
      ? {
          inputs: compactBitcoinInputs(tx.inputs),
        }
      : {}),
    ...(Array.isArray(tx.outputs) && tx.outputs.length > 0
      ? {
          outputs: compactBitcoinOutputs(tx.outputs),
        }
      : {}),
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
    totalValue += toFiniteNumber(input.prevoutValue)
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
    totalValue += toFiniteNumber(output.value)
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
 * Summarize Tron transactions: contract types, success, TRX moved, callers.
 */
export function summarizeTronTransactions(txs: any[]): any {
  if (txs.length === 0) return { count: 0, summary: 'No transactions found' }

  const byType = new Map<string, number>()
  const bySender = new Map<string, number>()
  const byContract = new Map<string, number>()
  let successCount = 0
  let failedCount = 0
  let amountSun = 0n
  let feeSun = 0n
  txs.forEach((tx) => {
    const type = typeof tx.type === 'string' ? tx.type : 'unknown'
    byType.set(type, (byType.get(type) || 0) + 1)
    if (tx.success === true) successCount += 1
    if (tx.success === false) failedCount += 1
    if (typeof tx.sender === 'string') bySender.set(tx.sender, (bySender.get(tx.sender) || 0) + 1)
    if (typeof tx.contract_address === 'string')
      byContract.set(tx.contract_address, (byContract.get(tx.contract_address) || 0) + 1)
    if (typeof tx.amount_sun === 'string' && /^\d+$/.test(tx.amount_sun)) amountSun += BigInt(tx.amount_sun)
    if (typeof tx.fee === 'string' && /^\d+$/.test(tx.fee)) feeSun += BigInt(tx.fee)
  })
  const trx = (sun: bigint) => {
    const whole = sun / 1_000_000n
    const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
    return `${whole}${fraction ? `.${fraction}` : ''}`
  }
  const blocks = txs.map((t) => getBlockNumber(t)).filter(isNumber)
  const rank = (map: Map<string, number>, key: string) =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ [key]: value, transaction_count: count }))

  return {
    total_transactions: txs.length,
    type_breakdown: Object.fromEntries(byType),
    successful_transactions: successCount,
    failed_transactions: failedCount,
    // Only native TRX transfers carry amount_sun, so TRC-10 amounts no longer
    // inflate this total.
    total_trx_transferred: trx(amountSun),
    total_fees_trx: trx(feeSun),
    unique_senders: bySender.size,
    top_senders: rank(bySender, 'address'),
    top_contracts: rank(byContract, 'address'),
    block_range: blocks.length > 0 ? { from: Math.min(...blocks), to: Math.max(...blocks) } : undefined,
  }
}

export function compactTronTransactions(txs: any[]): any[] {
  return txs.map((tx) => ({
    ...pickCommonAliases(tx),
    hash: tx.hash,
    transactionIndex: tx.transactionIndex,
    type: tx.type,
    ...(tx.sender_base58 !== undefined ? { sender_base58: tx.sender_base58 } : {}),
    ...(tx.recipient_base58 !== undefined ? { recipient_base58: tx.recipient_base58 } : {}),
    ...(tx.contract_address !== undefined ? { contract_address: tx.contract_address } : {}),
    ...(tx.contract_base58 !== undefined ? { contract_base58: tx.contract_base58 } : {}),
    ...(tx.method_sighash !== undefined ? { method_sighash: tx.method_sighash } : {}),
    ...(tx.amount_trx !== undefined ? { amount_trx: tx.amount_trx, amount_sun: tx.amount_sun } : {}),
    ...(tx.asset_amount !== undefined
      ? { asset_amount: tx.asset_amount, asset_amount_unit: tx.asset_amount_unit }
      : {}),
    ...(tx.asset_name !== undefined ? { asset_name: tx.asset_name } : {}),
    ...(tx.success !== undefined ? { success: tx.success } : {}),
    ...(tx.result !== undefined && tx.result !== null ? { result: tx.result } : {}),
    ...(tx.fee_trx !== undefined ? { fee_trx: tx.fee_trx } : {}),
    ...(tx.energyUsageTotal !== undefined && tx.energyUsageTotal !== null
      ? { energy_usage_total: tx.energyUsageTotal }
      : {}),
    ...(Array.isArray(tx.logs) && tx.logs.length > 0 ? { logs: compactTronLogs(tx.logs) } : {}),
    ...(Array.isArray(tx.internal_transactions) && tx.internal_transactions.length > 0
      ? { internal_transaction_count: tx.internal_transactions.length }
      : {}),
  }))
}

export function summarizeTronLogs(logs: any[]): any {
  const summary = summarizeLogs(logs)
  if (logs.length === 0) return summary
  const byTransaction = new Set(logs.map((log) => log.tx_hash).filter((value) => typeof value === 'string'))
  return { ...summary, unique_transactions: byTransaction.size }
}

export function compactTronLogs(logs: any[]): any[] {
  return logs.map((log) => ({
    ...pickCommonAliases(log),
    logIndex: log.logIndex,
    transactionIndex: log.transactionIndex,
    address: log.address,
    contract_address: log.contract_address || log.address,
    ...(log.contract_base58 !== undefined ? { contract_base58: log.contract_base58 } : {}),
    topic0: log.topic0 || log.topics?.[0],
    topics: log.topics,
    data: log.data,
    ...(log.decoded_log !== undefined ? { decoded_log: log.decoded_log } : {}),
    ...(log.transaction && typeof log.transaction === 'object' && !Array.isArray(log.transaction)
      ? { transaction: compactTronTransactions([log.transaction])[0] }
      : {}),
  }))
}

/**
 * Summarize EVM traces: types, call kinds, failures, value moved, top callers and callees.
 */
export function summarizeTraces(traces: any[]): any {
  if (traces.length === 0) return { count: 0, summary: 'No traces found' }
  const byType = new Map<string, number>()
  const byCallType = new Map<string, number>()
  const byCaller = new Map<string, number>()
  const byCallee = new Map<string, number>()
  const bySighash = new Map<string, number>()
  const transactions = new Set<string>()
  let failed = 0
  let wei = 0n
  for (const trace of traces) {
    const type = typeof trace.type === 'string' ? trace.type : 'unknown'
    byType.set(type, (byType.get(type) || 0) + 1)
    if (typeof trace.call_type === 'string') byCallType.set(trace.call_type, (byCallType.get(trace.call_type) || 0) + 1)
    if (typeof trace.sender === 'string') byCaller.set(trace.sender, (byCaller.get(trace.sender) || 0) + 1)
    if (typeof trace.recipient === 'string') byCallee.set(trace.recipient, (byCallee.get(trace.recipient) || 0) + 1)
    if (typeof trace.call_sighash === 'string')
      bySighash.set(trace.call_sighash, (bySighash.get(trace.call_sighash) || 0) + 1)
    if (typeof trace.tx_hash === 'string') transactions.add(trace.tx_hash)
    if (trace.success === false) failed += 1
    const value = trace.call_value ?? trace.create_value ?? trace.reward_value ?? trace.suicide_balance
    if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) wei += BigInt(value)
  }
  const eth = (value: bigint) => {
    const whole = value / 1_000_000_000_000_000_000n
    const fraction = (value % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '')
    return `${whole}${fraction ? `.${fraction}` : ''}`
  }
  const rank = (map: Map<string, number>, key: string) =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ [key]: value, count }))
  const blocks = traces.map((t) => getBlockNumber(t)).filter(isNumber)
  return {
    total_traces: traces.length,
    unique_transactions: transactions.size,
    type_breakdown: Object.fromEntries(byType),
    call_type_breakdown: Object.fromEntries(byCallType),
    failed_traces: failed,
    total_value_eth: eth(wei),
    top_callers: rank(byCaller, 'address'),
    top_callees: rank(byCallee, 'address'),
    top_sighashes: rank(bySighash, 'sighash'),
    block_range: blocks.length > 0 ? { from: Math.min(...blocks), to: Math.max(...blocks) } : undefined,
  }
}

export function compactTraces(traces: any[]): any[] {
  return traces.map((trace) => ({
    ...pickCommonAliases(trace),
    type: trace.type,
    trace_address: trace.trace_address,
    transactionIndex: trace.transactionIndex,
    subtraces: trace.subtraces,
    ...(trace.call_type !== undefined ? { call_type: trace.call_type } : {}),
    ...(trace.call_sighash !== undefined ? { call_sighash: trace.call_sighash } : {}),
    ...(trace.value_eth !== undefined ? { value_eth: trace.value_eth } : {}),
    ...(trace.created_contract_address !== undefined
      ? { created_contract_address: trace.created_contract_address }
      : {}),
    ...(trace.suicide_address !== undefined
      ? { suicide_address: trace.suicide_address, refund_address: trace.refund_address }
      : {}),
    ...(trace.reward_type !== undefined ? { reward_type: trace.reward_type } : {}),
    ...(trace.gas_used !== undefined ? { gas_used: trace.gas_used } : {}),
    ...(trace.success !== undefined ? { success: trace.success } : {}),
    ...(trace.error ? { error: trace.error } : {}),
    ...(trace.transaction && typeof trace.transaction === 'object' && !Array.isArray(trace.transaction)
      ? { transaction: compactTransactions([trace.transaction])[0] }
      : {}),
  }))
}

/**
 * Apply response format to data
 */
export function applyResponseFormat(
  data: any,
  format: ResponseFormat,
  dataType:
    | 'logs'
    | 'transactions'
    | 'bitcoin_transactions'
    | 'bitcoin_inputs'
    | 'bitcoin_outputs'
    | 'hyperliquid_fills'
    | 'solana_transactions'
    | 'substrate_events'
    | 'substrate_calls'
    | 'tron_transactions'
    | 'tron_logs'
    | 'traces',
): any {
  if (format === 'full' || !Array.isArray(data)) {
    return data
  }

  if (format === 'summary') {
    switch (dataType) {
      case 'logs':
        return summarizeLogs(data)
      case 'transactions':
        return summarizeTransactions(data)
      case 'bitcoin_transactions':
        return summarizeBitcoinTransactions(data)
      case 'bitcoin_inputs':
        return summarizeBitcoinInputs(data)
      case 'bitcoin_outputs':
        return summarizeBitcoinOutputs(data)
      case 'hyperliquid_fills':
        return summarizeHyperliquidFills(data)
      case 'solana_transactions':
        return summarizeSolanaTransactions(data)
      case 'substrate_events':
        return summarizeSubstrateEvents(data)
      case 'substrate_calls':
        return summarizeSubstrateCalls(data)
      case 'tron_transactions':
        return summarizeTronTransactions(data)
      case 'tron_logs':
        return summarizeTronLogs(data)
      case 'traces':
        return summarizeTraces(data)
      default:
        return data
    }
  }

  if (format === 'compact') {
    switch (dataType) {
      case 'logs':
        return compactLogs(data)
      case 'transactions':
        return compactTransactions(data)
      case 'bitcoin_transactions':
        return compactBitcoinTransactions(data)
      case 'bitcoin_inputs':
        return compactBitcoinInputs(data)
      case 'bitcoin_outputs':
        return compactBitcoinOutputs(data)
      case 'hyperliquid_fills':
        return compactHyperliquidFills(data)
      case 'solana_transactions':
        return compactSolanaTransactions(data)
      case 'substrate_events':
        return compactSubstrateEvents(data)
      case 'substrate_calls':
        return compactSubstrateCalls(data)
      case 'tron_transactions':
        return compactTronTransactions(data)
      case 'tron_logs':
        return compactTronLogs(data)
      case 'traces':
        return compactTraces(data)
      default:
        return data
    }
  }

  return data
}
