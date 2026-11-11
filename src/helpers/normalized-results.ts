import { formatExactDecimal, parseExactDecimal } from './exact-decimal.js'
import { formatTimestamp, normalizeUnixTimestamp } from './format.js'
import { decodeTronHexText, describeTronAddress, sunToTrx, tronMillisToSeconds } from './tron.js'

type RecordLike = Record<string, unknown>

function exactDecimalText(value: unknown): string | undefined {
  const parsed = parseExactDecimal(value)
  return parsed ? formatExactDecimal(parsed) : undefined
}

function usableHash(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (/^0x0+$/i.test(value)) return undefined
  return value
}

function withCommonAliases(
  item: RecordLike,
  aliases: {
    chain_kind: 'evm' | 'solana' | 'bitcoin' | 'substrate' | 'hyperliquid' | 'tron'
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
  const txHash =
    typeof item.transactionHash === 'string'
      ? item.transactionHash
      : typeof item.tx_hash === 'string'
        ? item.tx_hash
        : undefined
  const logIndex =
    typeof item.logIndex === 'number' ? item.logIndex : typeof item.log_index === 'number' ? item.log_index : undefined
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
  const txHash =
    typeof item.signature === 'string'
      ? item.signature
      : typeof signatures?.[0] === 'string'
        ? signatures[0]
        : undefined
  const sender = typeof item.feePayer === 'string' ? item.feePayer : undefined
  const slotNumber =
    typeof item.slot_number === 'number'
      ? item.slot_number
      : typeof item.block_number === 'number'
        ? item.block_number
        : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const feeLamports = exactDecimalText(item.fee)
  const computeUnits = exactDecimalText(item.computeUnitsConsumed)

  return withCommonAliases(
    {
      ...item,
      ...(txHash ? { signature: txHash } : {}),
      ...(feeLamports ? { fee: feeLamports, fee_lamports: feeLamports, fee_unit: 'lamports' } : {}),
      ...(computeUnits
        ? {
            computeUnitsConsumed: computeUnits,
            compute_units_consumed: computeUnits,
            compute_units_unit: 'compute units',
          }
        : {}),
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
  const programId =
    typeof item.programId === 'string'
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
  const slotNumber =
    typeof item.slot_number === 'number'
      ? item.slot_number
      : typeof item.block_number === 'number'
        ? item.block_number
        : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const transactionIndex =
    typeof item.transactionIndex === 'number'
      ? item.transactionIndex
      : typeof item.transaction_index === 'number'
        ? item.transaction_index
        : undefined
  const primaryId = txHash
    ? instructionPath
      ? `${txHash}:${instructionPath}`
      : txHash
    : slotNumber !== undefined
      ? `${slotNumber}:tx:${transactionIndex ?? 'unknown'}:instruction:${instructionPath ?? 'unknown'}`
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
  const txHash = typeof item.txid === 'string' ? item.txid : typeof item.hash === 'string' ? item.hash : undefined
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
  const inputIndex =
    typeof item.inputIndex === 'number'
      ? item.inputIndex
      : typeof item.input_index === 'number'
        ? item.input_index
        : undefined
  const sender =
    typeof item.prevoutScriptPubKeyAddress === 'string'
      ? item.prevoutScriptPubKeyAddress
      : typeof item.sender === 'string'
        ? item.sender
        : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const transactionIndex =
    typeof item.transactionIndex === 'number'
      ? item.transactionIndex
      : typeof item.transactionIndex === 'string'
        ? Number(item.transactionIndex)
        : undefined
  const fallbackPrimaryId =
    blockNumber !== undefined ? `${blockNumber}:${transactionIndex ?? 'tx'}:${inputIndex ?? 'input'}` : undefined
  const prevoutValueBtc = exactDecimalText(item.prevoutValue)

  return withCommonAliases(
    {
      ...item,
      ...(prevoutValueBtc
        ? {
            prevoutValue: prevoutValueBtc,
            prevout_value_btc: prevoutValueBtc,
            prevout_value_unit: 'BTC',
          }
        : {}),
    },
    {
      chain_kind: 'bitcoin',
      record_type: 'input',
      primary_id:
        txHash && inputIndex !== undefined
          ? `${txHash}:input:${inputIndex}`
          : txHash
            ? `${txHash}:input`
            : fallbackPrimaryId
              ? `bitcoin:input:${fallbackPrimaryId}`
              : undefined,
      tx_hash: txHash,
      sender,
      block_number: blockNumber,
      timestamp,
    },
  )
}

export function normalizeBitcoinOutputResult(item: RecordLike): RecordLike {
  const txHash = typeof item.txid === 'string' ? item.txid : undefined
  const outputIndex =
    typeof item.outputIndex === 'number'
      ? item.outputIndex
      : typeof item.output_index === 'number'
        ? item.output_index
        : undefined
  const recipient =
    typeof item.scriptPubKeyAddress === 'string'
      ? item.scriptPubKeyAddress
      : typeof item.recipient === 'string'
        ? item.recipient
        : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const transactionIndex =
    typeof item.transactionIndex === 'number'
      ? item.transactionIndex
      : typeof item.transactionIndex === 'string'
        ? Number(item.transactionIndex)
        : undefined
  const fallbackPrimaryId =
    blockNumber !== undefined ? `${blockNumber}:${transactionIndex ?? 'tx'}:${outputIndex ?? 'output'}` : undefined
  const valueBtc = exactDecimalText(item.value)

  return withCommonAliases(
    {
      ...item,
      ...(valueBtc ? { value: valueBtc, value_btc: valueBtc, value_unit: 'BTC' } : {}),
    },
    {
      chain_kind: 'bitcoin',
      record_type: 'output',
      primary_id:
        txHash && outputIndex !== undefined
          ? `${txHash}:output:${outputIndex}`
          : txHash
            ? `${txHash}:output`
            : fallbackPrimaryId
              ? `bitcoin:output:${fallbackPrimaryId}`
              : undefined,
      tx_hash: txHash,
      recipient,
      block_number: blockNumber,
      timestamp,
    },
  )
}

export function normalizeSubstrateEventResult(item: RecordLike): RecordLike {
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const eventIndex =
    typeof item.index === 'number' ? item.index : typeof item.event_index === 'number' ? item.event_index : undefined
  const eventName = typeof item.name === 'string' ? item.name : undefined
  const extrinsicIndex =
    typeof item.extrinsicIndex === 'number'
      ? item.extrinsicIndex
      : typeof item.extrinsic_index === 'number'
        ? item.extrinsic_index
        : undefined
  const callAddress = Array.isArray(item.callAddress)
    ? item.callAddress.join('.')
    : typeof item.call_address === 'string'
      ? item.call_address
      : undefined
  const txHash = typeof item.extrinsic_hash === 'string' ? item.extrinsic_hash : undefined
  const timestamp = normalizeUnixTimestamp(item.timestamp)
  const primaryId =
    blockNumber !== undefined
      ? eventIndex !== undefined
        ? `${blockNumber}:${eventIndex}`
        : `${blockNumber}:extrinsic:${extrinsicIndex ?? 'unknown'}:call:${callAddress ?? 'unknown'}:event:${eventName ?? 'unknown'}`
      : txHash

  return withCommonAliases(
    {
      ...item,
      ...(eventName ? { event_name: eventName } : {}),
    },
    {
      chain_kind: 'substrate',
      record_type: 'event',
      primary_id: primaryId,
      tx_hash: txHash,
      block_number: blockNumber,
      timestamp,
    },
  )
}

export function normalizeSubstrateCallResult(item: RecordLike): RecordLike {
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const callName = typeof item.name === 'string' ? item.name : undefined
  const callAddress = Array.isArray(item.address)
    ? item.address.join('.')
    : typeof item.call_address === 'string'
      ? item.call_address
      : undefined
  const txHash = typeof item.extrinsic_hash === 'string' ? item.extrinsic_hash : undefined
  const extrinsicIndex =
    typeof item.extrinsicIndex === 'number'
      ? item.extrinsicIndex
      : typeof item.extrinsic_index === 'number'
        ? item.extrinsic_index
        : undefined
  const timestamp = normalizeUnixTimestamp(item.timestamp)
  const primaryId =
    blockNumber !== undefined
      ? `${blockNumber}:extrinsic:${extrinsicIndex ?? 'unknown'}:call:${callAddress || callName || 'root'}`
      : txHash

  const inheritedContext = {
    ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(txHash ? { extrinsic_hash: txHash } : {}),
  }
  const normalizedEvents = Array.isArray(item.events)
    ? item.events.map((event) =>
        normalizeSubstrateEventResult({
          ...(event as RecordLike),
          ...inheritedContext,
        }),
      )
    : undefined
  const normalizeRelatedCall = (call: unknown) =>
    normalizeSubstrateCallResult({
      ...(call as RecordLike),
      ...inheritedContext,
      ...(extrinsicIndex !== undefined && (call as RecordLike)?.extrinsicIndex === undefined ? { extrinsicIndex } : {}),
    })
  const normalizedSubcalls = Array.isArray(item.subcalls) ? item.subcalls.map(normalizeRelatedCall) : undefined
  const normalizedCallStack = Array.isArray(item.call_stack) ? item.call_stack.map(normalizeRelatedCall) : undefined

  return withCommonAliases(
    {
      ...item,
      ...(normalizedEvents ? { events: normalizedEvents } : {}),
      ...(normalizedSubcalls ? { subcalls: normalizedSubcalls } : {}),
      ...(normalizedCallStack ? { call_stack: normalizedCallStack } : {}),
      ...(callName ? { call_name: callName } : {}),
      ...(callAddress ? { call_address: callAddress } : {}),
    },
    {
      chain_kind: 'substrate',
      record_type: 'call',
      primary_id: primaryId,
      tx_hash: txHash,
      block_number: blockNumber,
      timestamp,
    },
  )
}

export function normalizeHyperliquidFillResult(item: RecordLike): RecordLike {
  const txHash = usableHash(item.hash)
  const fillIndex =
    typeof item.fillIndex === 'number'
      ? item.fillIndex
      : typeof item.fillIndex === 'string'
        ? Number(item.fillIndex)
        : undefined
  const sender = typeof item.user === 'string' ? item.user : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestampValue = item.time ?? item.block_timestamp ?? item.timestamp
  const timestamp = normalizeUnixTimestamp(timestampValue)
  const primaryId =
    txHash && fillIndex !== undefined
      ? `${txHash}:${fillIndex}`
      : blockNumber !== undefined && fillIndex !== undefined
        ? `hyperliquid:${blockNumber}:fill:${fillIndex}`
        : blockNumber !== undefined
          ? `hyperliquid:${blockNumber}:fill:${timestamp ?? 'unknown'}:${sender ?? 'unknown'}`
          : txHash

  const price = exactDecimalText(item.px)
  const size = exactDecimalText(item.sz)
  const fee = exactDecimalText(item.fee)
  const closedPnl = exactDecimalText(item.closedPnl)
  const startPosition = exactDecimalText(item.startPosition)
  const builderFee = exactDecimalText(item.builderFee)
  const coin = typeof item.coin === 'string' ? item.coin : undefined
  const feeToken = typeof item.feeToken === 'string' ? item.feeToken : undefined

  return withCommonAliases(
    {
      ...item,
      ...(price ? { px: price, price_unit: 'USD per base asset' } : {}),
      ...(size ? { sz: size, size_unit: coin ?? 'base asset' } : {}),
      ...(fee ? { fee, fee_unit: feeToken ?? 'quote asset' } : {}),
      ...(closedPnl ? { closedPnl, closed_pnl_unit: 'quote asset' } : {}),
      ...(startPosition ? { startPosition, start_position_unit: coin ?? 'base asset' } : {}),
      ...(builderFee ? { builderFee, builder_fee_unit: feeToken ?? 'quote asset' } : {}),
    },
    {
      chain_kind: 'hyperliquid',
      record_type: 'fill',
      primary_id: primaryId,
      tx_hash: txHash,
      sender,
      block_number: blockNumber,
      timestamp,
    },
  )
}

export function normalizeHyperliquidReplicaCmdResult(item: RecordLike): RecordLike {
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const actionIndex =
    typeof item.actionIndex === 'number'
      ? item.actionIndex
      : typeof item.actionIndex === 'string'
        ? Number(item.actionIndex)
        : undefined
  const sender = typeof item.user === 'string' ? item.user : undefined
  const timestampValue = item.timestamp ?? item.block_timestamp ?? item.time
  const timestamp = normalizeUnixTimestamp(timestampValue)
  const primaryId =
    blockNumber !== undefined && actionIndex !== undefined
      ? `${blockNumber}:${actionIndex}`
      : blockNumber !== undefined
        ? `${blockNumber}:action`
        : undefined

  return withCommonAliases(item, {
    chain_kind: 'hyperliquid',
    record_type: 'replica_command',
    primary_id: primaryId,
    sender,
    block_number: blockNumber,
    timestamp,
  })
}

// ============================================================================
// Tron
// ============================================================================

function tronRecordAddress(value: unknown): { hex: string; base58: string } | undefined {
  return describeTronAddress(value)
}

function tronTransactionSuccess(item: RecordLike): boolean | undefined {
  const ret = item.ret
  if (Array.isArray(ret) && ret.length > 0) {
    const first = ret[0] as RecordLike
    if (typeof first?.contractRet === 'string') return first.contractRet === 'SUCCESS'
  }
  if (typeof item.result === 'string') return item.result === 'SUCCESS'
  return undefined
}

/**
 * Tron transaction rows carry the contract call in `parameter.value` with
 * fields that depend on the contract type. Surface the common ones as
 * top-level aliases (sender, recipient, amount in TRX, called contract, method
 * selector) while keeping the raw parameter intact.
 */
export function normalizeTronTransactionResult(item: RecordLike): RecordLike {
  const txHash = typeof item.hash === 'string' ? item.hash : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const transactionTimestampMs = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const timestampMs = typeof item.block_timestamp === 'number' ? item.block_timestamp : transactionTimestampMs
  const timestamp = tronMillisToSeconds(timestampMs)
  const parameter = item.parameter as RecordLike | undefined
  const value = (parameter?.value ?? {}) as RecordLike
  const owner = tronRecordAddress(value.owner_address)
  const to = tronRecordAddress(value.to_address)
  const contract = tronRecordAddress(value.contract_address ?? item.contractAddress)
  const rawAmount =
    typeof value.amount === 'number' || typeof value.amount === 'string' ? String(value.amount) : undefined
  // `parameter.value.amount` means SUN only on a native TRX transfer. On a
  // TransferAssetContract it is a TRC-10 amount in that asset's own units, so
  // labelling it amount_sun/amount_trx presented a token transfer as TRX.
  const contractType = typeof item.type === 'string' ? item.type : undefined
  const isAssetTransfer = contractType === 'TransferAssetContract' || value.asset_name !== undefined
  const amountSun = isAssetTransfer ? undefined : rawAmount
  const assetAmount = isAssetTransfer ? rawAmount : undefined
  const callData = typeof value.data === 'string' ? value.data : undefined
  const assetName = decodeTronHexText(value.asset_name)
  const success = tronTransactionSuccess(item)
  const feeTrx = sunToTrx(item.fee)

  return withCommonAliases(
    {
      ...item,
      ...(timestampMs !== undefined ? { timestamp_ms: timestampMs } : {}),
      ...(transactionTimestampMs !== undefined ? { transaction_timestamp_ms: transactionTimestampMs } : {}),
      ...(owner ? { sender_base58: owner.base58 } : {}),
      ...(to ? { recipient_base58: to.base58 } : {}),
      ...(contract ? { contract_address: contract.hex, contract_base58: contract.base58 } : {}),
      ...(amountSun !== undefined
        ? { amount_sun: amountSun, amount_trx: sunToTrx(amountSun), amount_unit: 'TRX' }
        : {}),
      ...(assetAmount !== undefined
        ? {
            asset_amount: assetAmount,
            // TRC-10 decimals are a property of the asset, not of the chain, so
            // the raw integer is the only exact value available here.
            asset_amount_unit: assetName ? `TRC-10 asset ${assetName} base units` : 'TRC-10 asset base units',
          }
        : {}),
      ...(callData ? { method_sighash: callData.slice(0, 8), call_data: callData } : {}),
      ...(assetName ? { asset_name: assetName } : {}),
      ...(success !== undefined ? { success } : {}),
      ...(feeTrx !== undefined ? { fee_trx: feeTrx } : {}),
    },
    {
      chain_kind: 'tron',
      record_type: 'transaction',
      primary_id: txHash,
      tx_hash: txHash,
      sender: owner?.hex,
      recipient: to?.hex ?? (contract && callData ? contract.hex : undefined),
      block_number: blockNumber,
      timestamp,
    },
  )
}

export function normalizeTronLogResult(item: RecordLike): RecordLike {
  const txHash = typeof item.tx_hash === 'string' ? item.tx_hash : undefined
  const logIndex = typeof item.logIndex === 'number' ? item.logIndex : undefined
  const transactionIndex = typeof item.transactionIndex === 'number' ? item.transactionIndex : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = tronMillisToSeconds(item.block_timestamp ?? item.timestamp)
  const contract = tronRecordAddress(item.address)
  const topics = Array.isArray(item.topics)
    ? (item.topics as unknown[]).filter((t): t is string => typeof t === 'string')
    : []
  const idBase =
    txHash ??
    (blockNumber !== undefined && transactionIndex !== undefined ? `${blockNumber}:tx:${transactionIndex}` : undefined)

  return withCommonAliases(
    {
      ...item,
      ...(contract ? { contract_address: contract.hex, contract_base58: contract.base58 } : {}),
      ...(topics.length > 0 ? { topic0: topics[0] } : {}),
    },
    {
      chain_kind: 'tron',
      record_type: 'log',
      primary_id: idBase && logIndex !== undefined ? `${idBase}:${logIndex}` : idBase,
      tx_hash: txHash,
      block_number: blockNumber,
      timestamp,
    },
  )
}

export function normalizeTronInternalTransactionResult(item: RecordLike): RecordLike {
  const txHash = typeof item.tx_hash === 'string' ? item.tx_hash : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const caller = tronRecordAddress(item.callerAddress)
  const to = tronRecordAddress(item.transferToAddress)
  const note = decodeTronHexText(item.note)
  const index = typeof item.internalTransactionIndex === 'number' ? item.internalTransactionIndex : undefined
  const callValues = Array.isArray(item.callValueInfo) ? (item.callValueInfo as RecordLike[]) : []
  const trxValue = callValues.find(
    (entry) => entry && (entry.tokenId === null || entry.tokenId === undefined),
  )?.callValue
  const amountTrx = sunToTrx(trxValue)

  return withCommonAliases(
    {
      ...item,
      ...(caller ? { caller_base58: caller.base58 } : {}),
      ...(to ? { recipient_base58: to.base58 } : {}),
      ...(note ? { note_text: note } : {}),
      ...(amountTrx !== undefined ? { amount_trx: amountTrx } : {}),
    },
    {
      chain_kind: 'tron',
      record_type: 'internal_transaction',
      primary_id: txHash && index !== undefined ? `${txHash}:internal:${index}` : txHash,
      tx_hash: txHash,
      sender: caller?.hex,
      recipient: to?.hex,
      block_number: blockNumber,
      timestamp: tronMillisToSeconds(item.block_timestamp ?? item.timestamp),
    },
  )
}

// ============================================================================
// EVM traces
// ============================================================================

function hexToEth(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return undefined
  const wei = BigInt(value)
  const whole = wei / 1_000_000_000_000_000_000n
  const fraction = (wei % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = (value as RecordLike)[key]
  return typeof entry === 'string' ? entry : undefined
}

export function traceAddressLabel(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  return value.length === 0 ? 'root' : value.map((part) => String(part)).join('.')
}

/**
 * Portal returns trace inputs under `action` and outputs under `result`, with
 * the field set depending on the trace type. Flatten the common ones into
 * stable names, keep the raw shape, and give every row an id made of the
 * transaction hash plus the trace address.
 */
export function normalizeEvmTraceResult(item: RecordLike): RecordLike {
  const type = typeof item.type === 'string' ? item.type : undefined
  const action = (item.action ?? {}) as RecordLike
  const result = (item.result ?? {}) as RecordLike
  const txHash = typeof item.tx_hash === 'string' ? item.tx_hash : undefined
  const blockNumber = typeof item.block_number === 'number' ? item.block_number : undefined
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : undefined
  const transactionIndex = typeof item.transactionIndex === 'number' ? item.transactionIndex : undefined
  const traceAddress = traceAddressLabel(item.traceAddress)
  const idBase =
    txHash ??
    (blockNumber !== undefined && transactionIndex !== undefined ? `${blockNumber}:tx:${transactionIndex}` : undefined)
  const error = item.error === null || typeof item.error === 'string' ? (item.error as string | null) : undefined

  const flattened: RecordLike = {
    ...(traceAddress !== undefined ? { trace_address: traceAddress } : {}),
    ...(error !== undefined ? { success: error === null } : {}),
  }
  let sender: string | undefined
  let recipient: string | undefined
  if (type === 'call') {
    sender = nestedString(action, 'from')
    recipient = nestedString(action, 'to')
    const value = nestedString(action, 'value')
    const valueEth = hexToEth(value)
    Object.assign(flattened, {
      ...(sender ? { call_from: sender } : {}),
      ...(recipient ? { call_to: recipient } : {}),
      ...(value ? { call_value: value } : {}),
      ...(valueEth !== undefined ? { value_eth: valueEth } : {}),
      ...(nestedString(action, 'sighash') ? { call_sighash: nestedString(action, 'sighash') } : {}),
      ...((nestedString(action, 'callType') ?? nestedString(action, 'type'))
        ? { call_type: nestedString(action, 'callType') ?? nestedString(action, 'type') }
        : {}),
      ...(nestedString(action, 'gas') ? { call_gas: nestedString(action, 'gas') } : {}),
      ...(nestedString(action, 'input') ? { call_input: nestedString(action, 'input') } : {}),
      ...(nestedString(result, 'gasUsed') ? { gas_used: nestedString(result, 'gasUsed') } : {}),
      ...(nestedString(result, 'output') ? { call_output: nestedString(result, 'output') } : {}),
    })
  } else if (type === 'create') {
    sender = nestedString(action, 'from')
    recipient = nestedString(result, 'address')
    const value = nestedString(action, 'value')
    const valueEth = hexToEth(value)
    Object.assign(flattened, {
      ...(sender ? { create_from: sender } : {}),
      ...(recipient ? { created_contract_address: recipient } : {}),
      ...(value ? { create_value: value } : {}),
      ...(valueEth !== undefined ? { value_eth: valueEth } : {}),
      ...(nestedString(action, 'gas') ? { create_gas: nestedString(action, 'gas') } : {}),
      ...(nestedString(result, 'gasUsed') ? { gas_used: nestedString(result, 'gasUsed') } : {}),
      ...(nestedString(result, 'code') ? { created_code: nestedString(result, 'code') } : {}),
      ...(nestedString(action, 'init') ? { create_init: nestedString(action, 'init') } : {}),
    })
  } else if (type === 'suicide') {
    sender = nestedString(action, 'address')
    recipient = nestedString(action, 'refundAddress')
    const balance = nestedString(action, 'balance')
    const balanceEth = hexToEth(balance)
    Object.assign(flattened, {
      ...(sender ? { suicide_address: sender } : {}),
      ...(recipient ? { refund_address: recipient } : {}),
      ...(balance ? { suicide_balance: balance } : {}),
      ...(balanceEth !== undefined ? { value_eth: balanceEth } : {}),
    })
  } else if (type === 'reward') {
    recipient = nestedString(action, 'author')
    const value = nestedString(action, 'value')
    const valueEth = hexToEth(value)
    Object.assign(flattened, {
      ...(recipient ? { reward_author: recipient } : {}),
      ...(value ? { reward_value: value } : {}),
      ...(valueEth !== undefined ? { value_eth: valueEth } : {}),
      ...(nestedString(action, 'type') ? { reward_type: nestedString(action, 'type') } : {}),
    })
  }

  // The nested action and result objects are dropped: every value they carry is
  // flattened above, and keeping both doubles the size of a trace page.
  const { action: _action, result: _result, ...rest } = item
  return withCommonAliases(
    { ...rest, ...flattened },
    {
      chain_kind: 'evm',
      record_type: 'trace',
      primary_id: idBase && traceAddress !== undefined ? `${idBase}:${traceAddress}` : idBase,
      tx_hash: txHash,
      sender,
      recipient,
      block_number: blockNumber,
      timestamp,
    },
  )
}
