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
    // logsBloom: true,  // REMOVED: 512-byte hex blob wastes context window
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

export function buildEvmTransactionFields(includeL2: boolean = false) {
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
    chainId: true,
    // v, r, s, yParity REMOVED: signature components waste ~192 bytes per tx with no analytical value
    // logsBloom REMOVED: not in TransactionFieldSelection per OpenAPI spec (only in BlockFieldSelection)
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
    type: true,
    error: true,
    // revertReason REMOVED: not in OpenAPI TraceFieldSelection
    // callType REMOVED: not in OpenAPI TraceFieldSelection
    // Call fields
    callFrom: true,
    callTo: true,
    callValue: true,
    callGas: true,
    callSighash: true,
    callInput: true,
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
    error: true,
    computeUnitsConsumed: true,
    isCommitted: true,
    hasDroppedLogMessages: true,
  }

  if (includeDiscriminators) {
    fields.d1 = true
    fields.d2 = true
    // d3 REMOVED: not in OpenAPI InstructionFieldSelection (only d1, d2, d4, d8)
    fields.d4 = true
    fields.d8 = true
  }

  return fields
}

export function buildSolanaTransactionFields() {
  return {
    transactionIndex: true,
    version: true,
    fee: true,
    feePayer: true,
    err: true,
    computeUnitsConsumed: true,
    hasDroppedLogMessages: true,
    signatures: true,
    accountKeys: true,
    recentBlockhash: true,
    addressTableLookups: true,
    loadedAddresses: true,
    numReadonlySignedAccounts: true,
    numReadonlyUnsignedAccounts: true,
    numRequiredSignatures: true,
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
    pubKey: true,
    lamports: true,
    postBalance: true,
    rewardType: true,
    commission: true,
  }
}

// ============================================================================
// Bitcoin Field Builders
// ============================================================================

export function buildBitcoinBlockFields() {
  return {
    number: true,
    hash: true,
    parentHash: true,
    timestamp: true,
    medianTime: true,
    version: true,
    merkleRoot: true,
    nonce: true,
    target: true,
    bits: true,
    difficulty: true,
    chainWork: true,
    strippedSize: true,
    size: true,
    weight: true,
  }
}

export function buildBitcoinTransactionFields() {
  return {
    transactionIndex: true,
    txid: true,
    hash: true,
    size: true,
    vsize: true,
    weight: true,
    version: true,
    locktime: true,
    // hex REMOVED: raw transaction hex is very large and wastes context
  }
}

export function buildBitcoinInputFields() {
  return {
    transactionIndex: true,
    inputIndex: true,
    type: true,
    txid: true,
    vout: true,
    scriptSigHex: true,
    scriptSigAsm: true,
    sequence: true,
    coinbase: true,
    txInWitness: true,
    prevoutGenerated: true,
    prevoutHeight: true,
    prevoutValue: true,
    prevoutScriptPubKeyType: true,
    prevoutScriptPubKeyAddress: true,
    // prevoutScriptPubKeyHex, prevoutScriptPubKeyAsm, prevoutScriptPubKeyDesc REMOVED: verbose, rarely needed
  }
}

export function buildBitcoinOutputFields() {
  return {
    transactionIndex: true,
    outputIndex: true,
    value: true,
    scriptPubKeyAddress: true,
    scriptPubKeyType: true,
    scriptPubKeyAsm: true,
    scriptPubKeyHex: true,
    // scriptPubKeyDesc REMOVED: descriptor format rarely needed in MCP context
  }
}

// ============================================================================
// Substrate Field Builders
// ============================================================================

export function buildSubstrateBlockFields() {
  return {
    number: true,
    hash: true,
    parentHash: true,
    stateRoot: true,
    extrinsicsRoot: true,
    specName: true,
    specVersion: true,
    implName: true,
    implVersion: true,
    validator: true,
    timestamp: true,
  }
}

export function buildSubstrateExtrinsicFields() {
  return {
    index: true,
    version: true,
    success: true,
    hash: true,
    fee: true,
    tip: true,
    signature: true,
    error: true,
  }
}

export function buildSubstrateCallFields() {
  return {
    extrinsicIndex: true,
    address: true,
    name: true,
    success: true,
    args: true,
    origin: true,
    error: true,
  }
}

export function buildSubstrateEventFields() {
  return {
    index: true,
    extrinsicIndex: true,
    name: true,
    phase: true,
    callAddress: true,
    topics: true,
    args: true,
  }
}
