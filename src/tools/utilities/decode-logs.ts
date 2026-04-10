import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeAddresses } from '../../helpers/validation.js'

// ============================================================================
// Known Event Signatures
// ============================================================================

type EventInput = { name: string; indexed: boolean }

const KNOWN_EVENTS: Record<string, { name: string; inputs: EventInput[] }> = {
  // ERC20 - Transfer(address indexed from, address indexed to, uint256 value)
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': {
    name: 'Transfer',
    inputs: [
      { name: 'from', indexed: true },
      { name: 'to', indexed: true },
      { name: 'value', indexed: false },
    ],
  },
  // ERC20 - Approval(address indexed owner, address indexed spender, uint256 value)
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': {
    name: 'Approval',
    inputs: [
      { name: 'owner', indexed: true },
      { name: 'spender', indexed: true },
      { name: 'value', indexed: false },
    ],
  },
  // ERC721 - ApprovalForAll(address indexed owner, address indexed operator, bool approved)
  '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31': {
    name: 'ApprovalForAll',
    inputs: [
      { name: 'owner', indexed: true },
      { name: 'operator', indexed: true },
      { name: 'approved', indexed: false },
    ],
  },
  // ERC1155 - TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62': {
    name: 'TransferSingle',
    inputs: [
      { name: 'operator', indexed: true },
      { name: 'from', indexed: true },
      { name: 'to', indexed: true },
      { name: 'id', indexed: false },
      { name: 'value', indexed: false },
    ],
  },
  // ERC1155 - TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)
  '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb': {
    name: 'TransferBatch',
    inputs: [
      { name: 'operator', indexed: true },
      { name: 'from', indexed: true },
      { name: 'to', indexed: true },
      { name: 'ids', indexed: false },
      { name: 'values', indexed: false },
    ],
  },
  // Uniswap V2 - NOTE: sender and to are INDEXED (in topics), amounts are in data
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822': {
    name: 'Swap',
    inputs: [
      { name: 'sender', indexed: true },
      { name: 'amount0In', indexed: false },
      { name: 'amount1In', indexed: false },
      { name: 'amount0Out', indexed: false },
      { name: 'amount1Out', indexed: false },
      { name: 'to', indexed: true },
    ],
  },
  // Uniswap V2 - Sync(uint112 reserve0, uint112 reserve1)
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1': {
    name: 'Sync',
    inputs: [
      { name: 'reserve0', indexed: false },
      { name: 'reserve1', indexed: false },
    ],
  },
  // Uniswap V3 - Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67': {
    name: 'Swap',
    inputs: [
      { name: 'sender', indexed: true },
      { name: 'recipient', indexed: true },
      { name: 'amount0', indexed: false },
      { name: 'amount1', indexed: false },
      { name: 'sqrtPriceX96', indexed: false },
      { name: 'liquidity', indexed: false },
      { name: 'tick', indexed: false },
    ],
  },
  // WETH - Deposit(address indexed dst, uint wad)
  '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c': {
    name: 'Deposit',
    inputs: [
      { name: 'dst', indexed: true },
      { name: 'wad', indexed: false },
    ],
  },
  // WETH - Withdrawal(address indexed src, uint wad)
  '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65': {
    name: 'Withdrawal',
    inputs: [
      { name: 'src', indexed: true },
      { name: 'wad', indexed: false },
    ],
  },
  // Burn(address indexed account, uint256 amount)
  '0xcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5': {
    name: 'Burn',
    inputs: [
      { name: 'account', indexed: true },
      { name: 'amount', indexed: false },
    ],
  },
  // Mint(address indexed account, uint256 amount)
  '0xab8530f87dc9b59234c4623bf917212bb2536d647574c8e7e5da92c2ede0c9f8': {
    name: 'Mint',
    inputs: [
      { name: 'account', indexed: true },
      { name: 'amount', indexed: false },
    ],
  },
  // Uniswap V3 - IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
  '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f': {
    name: 'IncreaseLiquidity',
    inputs: [
      { name: 'tokenId', indexed: true },
      { name: 'liquidity', indexed: false },
      { name: 'amount0', indexed: false },
      { name: 'amount1', indexed: false },
    ],
  },
  // Uniswap V3 - DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
  '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4': {
    name: 'DecreaseLiquidity',
    inputs: [
      { name: 'tokenId', indexed: true },
      { name: 'liquidity', indexed: false },
      { name: 'amount0', indexed: false },
      { name: 'amount1', indexed: false },
    ],
  },
  // EIP-3009 - AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)
  '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5': {
    name: 'AuthorizationUsed',
    inputs: [
      { name: 'authorizer', indexed: true },
      { name: 'nonce', indexed: true },
    ],
  },
}

export function decodeLog(log: {
  address: string
  topics: string[]
  data: string
  transactionHash?: string
  logIndex?: number
}): {
  address: string
  event_name: string | null
  decoded: Record<string, string> | null
  raw?: { topics: string[]; data: string }
  transaction_hash?: string
  log_index?: number
} {
  const topic0 = log.topics[0]
  const eventInfo = KNOWN_EVENTS[topic0]

  if (!eventInfo) {
    return {
      address: log.address,
      event_name: null,
      decoded: null,
      raw: { topics: log.topics, data: log.data },
      transaction_hash: log.transactionHash,
      log_index: log.logIndex,
    }
  }

  const decoded: Record<string, string> = {}

  // Separate indexed and non-indexed inputs
  const indexedInputs = eventInfo.inputs.filter((inp) => inp.indexed)
  const nonIndexedInputs = eventInfo.inputs.filter((inp) => !inp.indexed)

  // Decode indexed parameters from topics (topic0 is event signature, skip it)
  let topicIndex = 1 // Start from topic1
  for (const input of indexedInputs) {
    if (topicIndex >= log.topics.length) break

    const topic = log.topics[topicIndex]
    // For addresses, extract last 40 chars
    if (
      input.name === 'from' ||
      input.name === 'to' ||
      input.name === 'owner' ||
      input.name === 'spender' ||
      input.name === 'operator' ||
      input.name === 'sender' ||
      input.name === 'recipient' ||
      input.name === 'dst' ||
      input.name === 'src'
    ) {
      decoded[input.name] = '0x' + topic.slice(-40)
    } else {
      decoded[input.name] = topic
    }
    topicIndex++
  }

  // Decode non-indexed parameters from data
  if (log.data && log.data !== '0x') {
    const dataWithoutPrefix = log.data.slice(2)
    const chunks = dataWithoutPrefix.match(/.{64}/g) || []

    for (let i = 0; i < nonIndexedInputs.length && i < chunks.length; i++) {
      const input = nonIndexedInputs[i]
      const rawHex = '0x' + chunks[i]

      // Convert numeric values to decimal strings for readability
      if (
        input.name === 'value' ||
        input.name === 'wad' ||
        input.name === 'id' ||
        input.name === 'amount0' ||
        input.name === 'amount1' ||
        input.name === 'amount0In' ||
        input.name === 'amount1In' ||
        input.name === 'amount0Out' ||
        input.name === 'amount1Out' ||
        input.name === 'reserve0' ||
        input.name === 'reserve1' ||
        input.name === 'liquidity' ||
        input.name === 'sqrtPriceX96' ||
        input.name === 'amount' ||
        input.name === 'tokenId'
      ) {
        try {
          decoded[input.name] = BigInt(rawHex).toString()
        } catch {
          decoded[input.name] = rawHex
        }
      } else {
        decoded[input.name] = rawHex
      }
    }
  }

  // Omit raw section for successfully decoded events — the decoded fields
  // contain the same info in human-readable form, so raw just bloats the response.
  return {
    address: log.address,
    event_name: eventInfo.name,
    decoded,
    transaction_hash: log.transactionHash,
    log_index: log.logIndex,
  }
}

// ============================================================================
// Tool: Decode Logs
// ============================================================================

export function registerDecodeLogsTool(server: McpServer) {
  server.tool(
    'portal_decode_logs',
    'Decode event logs using known event signatures (Transfer, Approval, Swap, etc.)',
    {
      dataset: z.string().describe('Dataset name or alias'),
      from_block: z.number().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      addresses: z.array(z.string()).optional().describe('Contract addresses to filter'),
      event_types: z
        .array(z.enum([
          'Transfer', 'Approval', 'ApprovalForAll', 'Swap', 'Sync',
          'Deposit', 'Withdrawal', 'Burn', 'Mint',
          'IncreaseLiquidity', 'DecreaseLiquidity', 'all',
        ]))
        .optional()
        .default(['all'])
        .describe('Event types to decode'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Max logs to return (default: 20). Note: Lower default for MCP to reduce context usage.'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
    },
    async ({ dataset, from_block, to_block, addresses, event_types, limit, finalized_only }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_decode_logs',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_solana_query_instructions for Solana program activity.',
            'Use portal_query_bitcoin_outputs or portal_query_bitcoin_inputs for Bitcoin activity.',
          ],
        })
      }

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )

      // Build topic0 filter based on event types
      let topic0Filter: string[] | undefined
      if (!event_types?.includes('all')) {
        topic0Filter = []
        const eventToSig: Record<string, string> = {
          Transfer: EVENT_SIGNATURES.TRANSFER_ERC20,
          Approval: EVENT_SIGNATURES.APPROVAL_ERC20,
          ApprovalForAll: EVENT_SIGNATURES.APPROVAL_FOR_ALL,
          Swap: EVENT_SIGNATURES.UNISWAP_V2_SWAP,
          Sync: EVENT_SIGNATURES.SYNC,
          Deposit: EVENT_SIGNATURES.DEPOSIT,
          Withdrawal: EVENT_SIGNATURES.WITHDRAWAL,
          Burn: EVENT_SIGNATURES.BURN,
          Mint: EVENT_SIGNATURES.MINT,
          IncreaseLiquidity: EVENT_SIGNATURES.INCREASE_LIQUIDITY,
          DecreaseLiquidity: EVENT_SIGNATURES.DECREASE_LIQUIDITY,
        }
        for (const et of event_types || []) {
          if (eventToSig[et]) {
            topic0Filter.push(eventToSig[et])
          }
        }
        // Also add Uniswap V3 Swap if Swap is requested
        if (event_types?.includes('Swap')) {
          topic0Filter.push(EVENT_SIGNATURES.UNISWAP_V3_SWAP)
        }
      }

      const logFilter: Record<string, unknown> = {}
      if (addresses) {
        logFilter.address = normalizeAddresses(addresses, 'evm')
      }
      if (topic0Filter && topic0Filter.length > 0) {
        logFilter.topic0 = topic0Filter
      }

      const query = {
        type: 'evm',
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          log: buildEvmLogFields(),
        },
        logs: [logFilter],
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const decodedLogs = results
        .flatMap((block: unknown) => {
          const b = block as {
            header?: { number: number; timestamp: number }
            logs?: Array<{
              address: string
              topics: string[]
              data: string
              transactionHash: string
              logIndex: number
            }>
          }
          return (b.logs || []).map((log) => ({
            block_number: b.header?.number,
            timestamp: b.header?.timestamp,
            ...decodeLog(log),
          }))
        })
        .slice(0, limit)

      const knownCount = decodedLogs.filter((l) => l.event_name !== null).length
      const unknownCount = decodedLogs.length - knownCount

      return formatResult(
        decodedLogs,
        `Decoded ${decodedLogs.length} logs (${knownCount} known events, ${unknownCount} unknown)`,
        {
          metadata: {
            dataset,
            from_block,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
