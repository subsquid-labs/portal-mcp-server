// ============================================================================
// EVM Field Builders
// ============================================================================

export function buildEvmBlockFields(includeL2: boolean = false) {
  const fields: Record<string, boolean> = {
    number: true,
    hash: true,
    parentHash: true,
    timestamp: true,
    transactionsRoot: true,
    receiptsRoot: true,
    stateRoot: true,
    logsBloom: true,
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
  }

  if (includeL2) {
    fields.l1BlockNumber = true
  }

  return fields
}

export function buildEvmTransactionFields(includeL2: boolean = false, includeReceipt: boolean = false) {
  const fields: Record<string, boolean> = {
    transactionIndex: true,
    hash: true,
    from: true,
    to: true,
    value: true,
    input: true,
    nonce: true,
    gas: true,
    gasPrice: true,
    maxFeePerGas: true,
    maxPriorityFeePerGas: true,
    gasUsed: true,
    cumulativeGasUsed: true,
    effectiveGasPrice: true,
    type: true,
    status: true,
    sighash: true,
    contractAddress: true,
    yParity: true,
    chainId: true,
    v: true,
    r: true,
    s: true,
  }

  if (includeL2) {
    fields.l1Fee = true
    fields.l1FeeScalar = true
    fields.l1GasPrice = true
    fields.l1GasUsed = true
    fields.l1BlobBaseFee = true
    fields.l1BlobBaseFeeScalar = true
    fields.l1BaseFeeScalar = true
  }

  if (includeReceipt) {
    fields.logsBloom = true
  }

  return fields
}

export function buildEvmLogFields() {
  return {
    logIndex: true,
    transactionIndex: true,
    transactionHash: true,
    address: true,
    data: true,
    topics: true,
  }
}

export function buildEvmTraceFields() {
  return {
    traceAddress: true,
    subtraces: true,
    transactionIndex: true,
    // transactionHash: true,  // REMOVED: Not a valid field in Portal API trace schema
    type: true,
    error: true,
    revertReason: true,
    // Call fields
    callFrom: true,
    callTo: true,
    callValue: true,
    callGas: true,
    callSighash: true,
    callInput: true,
    callType: true,
    callResultGasUsed: true,
    callResultOutput: true,
    // Create fields
    createFrom: true,
    createValue: true,
    createGas: true,
    createInit: true,
    createResultGasUsed: true,
    createResultCode: true,
    createResultAddress: true,
    // Suicide fields
    suicideAddress: true,
    suicideBalance: true,
    suicideRefundAddress: true,
    // Reward fields
    rewardAuthor: true,
    rewardValue: true,
    rewardType: true,
  }
}

export function buildEvmStateDiffFields() {
  return {
    transactionIndex: true,
    // transactionHash: true,  // REMOVED: Not a valid field in Portal API stateDiff schema
    address: true,
    key: true,
    kind: true,
    prev: true,
    next: true,
  }
}

// ============================================================================
// Solana Field Builders
// ============================================================================

export function buildSolanaInstructionFields(includeDiscriminators: boolean = false) {
  const fields: Record<string, boolean> = {
    transactionIndex: true,
    instructionAddress: true,
    programId: true,
    accounts: true,
    data: true,
    isCommitted: true,
    hasDroppedLogMessages: true,
  }

  if (includeDiscriminators) {
    fields.d1 = true
    fields.d2 = true
    fields.d4 = true
    fields.d8 = true
  }

  return fields
}

export function buildSolanaTransactionFields() {
  return {
    transactionIndex: true,
    signature: true,
    version: true,
    fee: true,
    err: true,
    computeUnitsConsumed: true,
    isCommitted: true,
    hasDroppedLogMessages: true,
    signatures: true,
    accountKeys: true,
    recentBlockhash: true,
    addressTableLookups: true,
    loadedAddresses: true,
  }
}

export function buildSolanaBalanceFields() {
  return {
    transactionIndex: true,
    account: true,
    pre: true,
    post: true,
  }
}

export function buildSolanaTokenBalanceFields() {
  return {
    transactionIndex: true,
    account: true,
    preMint: true,
    postMint: true,
    preDecimals: true,
    postDecimals: true,
    preProgramId: true,
    postProgramId: true,
    preOwner: true,
    postOwner: true,
    preAmount: true,
    postAmount: true,
  }
}

export function buildSolanaLogFields() {
  return {
    transactionIndex: true,
    logIndex: true,
    instructionAddress: true,
    programId: true,
    kind: true,
    message: true,
  }
}

export function buildSolanaRewardFields() {
  return {
    pubkey: true,
    lamports: true,
    postBalance: true,
    rewardType: true,
    commission: true,
  }
}
