// Response format modes for context optimization
// Reduces token usage by 50-95% depending on mode

export type ResponseFormat = 'full' | 'compact' | 'summary'

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
  const blocks = logs.map((l) => l.blockNumber || l.block?.number).filter(Boolean)
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
  const blocks = txs.map((t) => t.blockNumber || t.block?.number).filter(Boolean)
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
    address: log.address,
    topic0: log.topic0 || log.topics?.[0],
    topics: log.topics,
    // Exclude: data (large hex string), transactionHash, logIndex, etc.
    blockNumber: log.blockNumber || log.block?.number,
    timestamp: log.timestamp || log.block?.timestamp,
  }))
}

/**
 * Compact transactions - strip verbose fields
 * Reduces by ~50-60%
 */
export function compactTransactions(txs: any[]): any[] {
  return txs.map((tx) => ({
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    // Exclude: input (large hex), nonce, gasPrice details, etc.
    blockNumber: tx.blockNumber || tx.block?.number,
    timestamp: tx.timestamp || tx.block?.timestamp,
  }))
}

/**
 * Apply response format to data
 */
export function applyResponseFormat(data: any, format: ResponseFormat, dataType: 'logs' | 'transactions'): any {
  if (format === 'full' || !Array.isArray(data)) {
    return data
  }

  if (format === 'summary') {
    if (dataType === 'logs') {
      return summarizeLogs(data)
    } else if (dataType === 'transactions') {
      return summarizeTransactions(data)
    }
  }

  if (format === 'compact') {
    if (dataType === 'logs') {
      return compactLogs(data)
    } else if (dataType === 'transactions') {
      return compactTransactions(data)
    }
  }

  return data
}
