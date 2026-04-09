import { formatTimestamp } from './formatting.js'

type RecordLike = Record<string, unknown>

function withCommonAliases(
  item: RecordLike,
  aliases: {
    chain_kind: 'evm' | 'solana' | 'bitcoin'
    record_type: string
    primary_id?: string
    tx_hash?: string
    sender?: string
    recipient?: string
    block_number?: number
    slot_number?: number
    timestamp?: number
  },
): RecordLike {
  return {
    ...item,
    chain_kind: aliases.chain_kind,
    record_type: aliases.record_type,
    ...(aliases.primary_id ? { primary_id: aliases.primary_id } : {}),
    ...(aliases.tx_hash ? { tx_hash: aliases.tx_hash } : {}),
    ...(aliases.sender ? { sender: aliases.sender } : {}),
    ...(aliases.recipient ? { recipient: aliases.recipient } : {}),
    ...(aliases.block_number !== undefined ? { block_number: aliases.block_number } : {}),
    ...(aliases.slot_number !== undefined ? { slot_number: aliases.slot_number } : {}),
    ...(aliases.timestamp !== undefined
      ? {
          timestamp: aliases.timestamp,
          timestamp_human: formatTimestamp(aliases.timestamp),
        }
      : {}),
  }
}

export function normalizeEvmTransactionResult(item: RecordLike): RecordLike {
  const txHash = typeof item.hash === 'string' ? item.hash : undefined
  const sender = typeof item.from === 'string' ? item.from : undefined
  const recipient = typeof item.to === 'string' ? item.to : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined

  return withCommonAliases(item, {
    chain_kind: 'evm',
    record_type: 'transaction',
    primary_id: txHash,
    tx_hash: txHash,
    sender,
    recipient,
    block_number: blockNumber,
    timestamp,
  })
}

export function normalizeEvmLogResult(item: RecordLike): RecordLike {
  const txHash = typeof item.transactionHash === 'string'
    ? item.transactionHash
    : typeof item.tx_hash === 'string'
      ? item.tx_hash
      : undefined
  const logIndex = typeof item.logIndex === 'number'
    ? item.logIndex
    : typeof item.log_index === 'number'
      ? item.log_index
      : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const contractAddress = typeof item.address === 'string' ? item.address : undefined

  return withCommonAliases(
    {
      ...item,
      ...(contractAddress ? { contract_address: contractAddress } : {}),
    },
    {
      chain_kind: 'evm',
      record_type: 'log',
      primary_id: txHash && logIndex !== undefined ? `${txHash}:${logIndex}` : txHash,
      tx_hash: txHash,
      block_number: blockNumber,
      timestamp,
    },
  )
}

export function normalizeErc20TransferResult(item: RecordLike): RecordLike {
  const txHash = typeof item.transaction_hash === 'string' ? item.transaction_hash : undefined
  const sender = typeof item.from === 'string' ? item.from : undefined
  const recipient = typeof item.to === 'string' ? item.to : undefined
  const logIndex = typeof item.log_index === 'number' ? item.log_index : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined

  return withCommonAliases(item, {
    chain_kind: 'evm',
    record_type: 'erc20_transfer',
    primary_id: txHash && logIndex !== undefined ? `${txHash}:${logIndex}` : txHash,
    tx_hash: txHash,
    sender,
    recipient,
    block_number: blockNumber,
    timestamp,
  })
}

export function normalizeSolanaTransactionResult(item: RecordLike): RecordLike {
  const signatures = Array.isArray(item.signatures) ? item.signatures : undefined
  const txHash = typeof item.signature === 'string'
    ? item.signature
    : typeof signatures?.[0] === 'string'
      ? signatures[0]
      : undefined
  const sender = typeof item.feePayer === 'string' ? item.feePayer : undefined
  const slotNumber = typeof item.slot_number === 'number'
    ? item.slot_number
    : typeof item.block_number === 'number'
      ? item.block_number
      : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined

  return withCommonAliases(
    {
      ...item,
      ...(txHash ? { signature: txHash } : {}),
    },
    {
      chain_kind: 'solana',
      record_type: 'transaction',
      primary_id: txHash,
      tx_hash: txHash,
      sender,
      block_number: slotNumber,
      slot_number: slotNumber,
      timestamp,
    },
  )
}

export function normalizeSolanaInstructionResult(item: RecordLike): RecordLike {
  const txHash = typeof item.tx_hash === 'string' ? item.tx_hash : undefined
  const programId = typeof item.programId === 'string'
    ? item.programId
    : typeof item.program_id === 'string'
      ? item.program_id
      : undefined
  const instructionPath = Array.isArray(item.instructionAddress)
    ? item.instructionAddress.join('.')
    : typeof item.instructionAddress === 'string'
      ? item.instructionAddress
      : typeof item.instruction_address === 'string'
        ? item.instruction_address
        : undefined
  const slotNumber = typeof item.slot_number === 'number'
    ? item.slot_number
    : typeof item.block_number === 'number'
      ? item.block_number
      : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const primaryId = txHash
    ? instructionPath
      ? `${txHash}:${instructionPath}`
      : txHash
    : slotNumber !== undefined
      ? `${slotNumber}:${instructionPath ?? 'instruction'}`
      : undefined

  return withCommonAliases(
    {
      ...item,
      ...(programId ? { program_id: programId } : {}),
    },
    {
      chain_kind: 'solana',
      record_type: 'instruction',
      primary_id: primaryId,
      tx_hash: txHash,
      recipient: programId,
      block_number: slotNumber,
      slot_number: slotNumber,
      timestamp,
    },
  )
}

export function normalizeBitcoinTransactionResult(item: RecordLike): RecordLike {
  const txHash = typeof item.txid === 'string'
    ? item.txid
    : typeof item.hash === 'string'
      ? item.hash
      : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined

  return withCommonAliases(item, {
    chain_kind: 'bitcoin',
    record_type: 'transaction',
    primary_id: txHash,
    tx_hash: txHash,
    block_number: blockNumber,
    timestamp,
  })
}

export function normalizeBitcoinInputResult(item: RecordLike): RecordLike {
  const txHash = typeof item.txid === 'string' ? item.txid : undefined
  const inputIndex = typeof item.inputIndex === 'number'
    ? item.inputIndex
    : typeof item.input_index === 'number'
      ? item.input_index
      : undefined
  const sender = typeof item.prevoutScriptPubKeyAddress === 'string'
    ? item.prevoutScriptPubKeyAddress
    : typeof item.sender === 'string'
      ? item.sender
      : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const transactionIndex = typeof item.transactionIndex === 'number'
    ? item.transactionIndex
    : typeof item.transactionIndex === 'string'
      ? Number(item.transactionIndex)
      : undefined
  const fallbackPrimaryId = blockNumber !== undefined
    ? `${blockNumber}:${transactionIndex ?? 'tx'}:${inputIndex ?? 'input'}`
    : undefined

  return withCommonAliases(item, {
    chain_kind: 'bitcoin',
    record_type: 'input',
    primary_id: txHash && inputIndex !== undefined ? `${txHash}:${inputIndex}` : txHash ?? fallbackPrimaryId,
    tx_hash: txHash,
    sender,
    block_number: blockNumber,
    timestamp,
  })
}

export function normalizeBitcoinOutputResult(item: RecordLike): RecordLike {
  const txHash = typeof item.txid === 'string' ? item.txid : undefined
  const outputIndex = typeof item.outputIndex === 'number'
    ? item.outputIndex
    : typeof item.output_index === 'number'
      ? item.output_index
      : undefined
  const recipient = typeof item.scriptPubKeyAddress === 'string'
    ? item.scriptPubKeyAddress
    : typeof item.recipient === 'string'
      ? item.recipient
      : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const transactionIndex = typeof item.transactionIndex === 'number'
    ? item.transactionIndex
    : typeof item.transactionIndex === 'string'
      ? Number(item.transactionIndex)
      : undefined
  const fallbackPrimaryId = blockNumber !== undefined
    ? `${blockNumber}:${transactionIndex ?? 'tx'}:${outputIndex ?? 'output'}`
    : undefined

  return withCommonAliases(item, {
    chain_kind: 'bitcoin',
    record_type: 'output',
    primary_id: txHash && outputIndex !== undefined ? `${txHash}:${outputIndex}` : txHash ?? fallbackPrimaryId,
    tx_hash: txHash,
    recipient,
    block_number: blockNumber,
    timestamp,
  })
}
