// Field presets for common use cases
// Reduces response size by excluding verbose fields

export const LOG_FIELD_PRESETS = {
  minimal: {
    log: {
      address: true,
      topics: true,
    },
    block: {
      number: true,
    },
  },
  standard: {
    log: {
      address: true,
      topics: true,
      data: true,
      logIndex: true,
      transactionHash: true,
    },
    block: {
      number: true,
      timestamp: true,
    },
  },
  full: {
    log: {
      address: true,
      topics: true,
      data: true,
      logIndex: true,
      transactionIndex: true,
    },
    block: {
      number: true,
      timestamp: true,
      hash: true,
    },
  },
}

export const TRANSACTION_FIELD_PRESETS = {
  minimal: {
    transaction: {
      from: true,
      to: true,
      value: true,
    },
    block: {
      number: true,
    },
  },
  standard: {
    transaction: {
      hash: true,
      from: true,
      to: true,
      value: true,
      gasPrice: true,
      gas: true,
    },
    block: {
      number: true,
      timestamp: true,
    },
  },
  full: {
    transaction: {
      hash: true,
      from: true,
      to: true,
      value: true,
      input: true,
      nonce: true,
      gasPrice: true,
      gas: true,
      sighash: true,
    },
    block: {
      number: true,
      timestamp: true,
      hash: true,
    },
  },
}

export const TRACE_FIELD_PRESETS = {
  minimal: {
    trace: {
      type: true,
      callFrom: true,
      callTo: true,
    },
    block: {
      number: true,
    },
  },
  standard: {
    trace: {
      type: true,
      callFrom: true,
      callTo: true,
      callValue: true,
      callSighash: true,
      createFrom: true,
      createValue: true,
      createResultAddress: true,
      suicideAddress: true,
      suicideRefundAddress: true,
      suicideBalance: true,
      rewardAuthor: true,
      rewardValue: true,
    },
    block: {
      number: true,
      timestamp: true,
    },
  },
  full: {
    trace: {
      type: true,
      callFrom: true,
      callTo: true,
      callValue: true,
      callInput: true,
      callResultOutput: true,
      callSighash: true,
      callGas: true,
      callResultGasUsed: true,
      callType: true,
      callCallType: true,
      createFrom: true,
      createValue: true,
      createGas: true,
      createInit: true,
      createResultGasUsed: true,
      createResultCode: true,
      createResultAddress: true,
      suicideAddress: true,
      suicideRefundAddress: true,
      suicideBalance: true,
      rewardAuthor: true,
      rewardValue: true,
      rewardType: true,
      error: true,
      revertReason: true,
    },
    block: {
      number: true,
      timestamp: true,
      hash: true,
    },
  },
}

export const BLOCK_FIELD_PRESETS = {
  minimal: {
    number: true,
    timestamp: true,
    gasUsed: true,
    gasLimit: true,
    baseFeePerGas: true,
  },
  standard: {
    number: true,
    hash: true,
    timestamp: true,
    miner: true,
    size: true,
    gasUsed: true,
    gasLimit: true,
    baseFeePerGas: true,
  },
  full: {
    number: true,
    hash: true,
    parentHash: true,
    timestamp: true,
    transactionsRoot: true,
    receiptsRoot: true,
    stateRoot: true,
    sha3Uncles: true,
    extraData: true,
    miner: true,
    nonce: true,
    mixHash: true,
    size: true,
    gasLimit: true,
    gasUsed: true,
    difficulty: true,
    totalDifficulty: true,
    baseFeePerGas: true,
  },
}

export type FieldPreset = 'minimal' | 'standard' | 'full' | 'custom'

export function getLogFields(preset: FieldPreset, customFields?: any) {
  if (preset === 'custom' && customFields) {
    return customFields
  }
  return LOG_FIELD_PRESETS[preset as keyof typeof LOG_FIELD_PRESETS] || LOG_FIELD_PRESETS.standard
}

export function getTransactionFields(preset: FieldPreset, customFields?: any) {
  if (preset === 'custom' && customFields) {
    return customFields
  }
  return (
    TRANSACTION_FIELD_PRESETS[preset as keyof typeof TRANSACTION_FIELD_PRESETS] || TRANSACTION_FIELD_PRESETS.standard
  )
}

export function getTraceFields(preset: FieldPreset, customFields?: any) {
  if (preset === 'custom' && customFields) {
    return customFields
  }
  return TRACE_FIELD_PRESETS[preset as keyof typeof TRACE_FIELD_PRESETS] || TRACE_FIELD_PRESETS.standard
}

export function getBlockFields(preset: FieldPreset, customFields?: any) {
  if (preset === 'custom' && customFields) {
    return customFields
  }
  return BLOCK_FIELD_PRESETS[preset as keyof typeof BLOCK_FIELD_PRESETS] || BLOCK_FIELD_PRESETS.standard
}
