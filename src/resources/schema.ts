import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server'

import { getDatasets, resolveDataset } from '../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../constants/index.js'
import { portalFetch } from '../helpers/fetch.js'
import {
  buildBitcoinBlockFields,
  buildBitcoinInputFields,
  buildBitcoinOutputFields,
  buildBitcoinTransactionFields,
  buildEvmBlockFields,
  buildEvmLogFields,
  buildEvmStateDiffFields,
  buildEvmTraceFields,
  buildEvmTransactionFields,
  buildSolanaBalanceFields,
  buildSolanaInstructionFields,
  buildSolanaLogFields,
  buildSolanaRewardFields,
  buildSolanaTokenBalanceFields,
  buildSolanaTransactionFields,
  buildSubstrateBlockFields,
  buildSubstrateCallFields,
  buildSubstrateEventFields,
  buildSubstrateExtrinsicFields,
  buildTronBlockFields,
  buildTronInternalTransactionFields,
  buildTronLogFields,
  buildTronTransactionFields,
} from '../helpers/fields.js'
import { type ToolGuideEntry, getToolGuideEntries, getToolGuideEntry } from '../helpers/tool-ux.js'
import { captureToolActivePredicate } from '../toolsets.js'
import type { BlockHead, DatasetMetadata } from '../types/index.js'
import { npmVersion } from '../version.js'

// ============================================================================
// MCP Resources
// ============================================================================

function groupToolsByCategory(tools: ToolGuideEntry[]) {
  return tools.reduce<Record<string, string[]>>((groups, tool) => {
    groups[tool.category] ??= []
    groups[tool.category].push(tool.name)
    return groups
  }, {})
}

/* A route is only worth reading when the tool it starts from is registered,
   and the tools it hands off to are filtered to the ones this deployment
   serves. Without this the guide read as though the full catalog were
   available and sent callers at tools that are not there. */
function activeRoutes<T extends { start_with: string; then_use: string[] }>(
  routes: T[],
  isActive: (toolName: string) => boolean,
): T[] {
  return routes
    .filter((route) => isActive(route.start_with))
    .map((route) => ({ ...route, then_use: route.then_use.filter((tool) => isActive(tool)) }))
    .filter((route) => route.then_use.length > 0)
    .filter((route) => !('reason' in route) || mentionsOnlyActiveTools(String(route.reason), isActive))
}

/*
 * Prose in the guide names tools too, in `integration_notes`, in a route's
 * `reason`, and in a tool entry's own advice. Filtering the lists while
 * leaving the sentences alone still pointed a trimmed connection at tools it
 * does not serve, so a sentence is dropped when a tool it names is absent.
 */
function mentionsOnlyActiveTools(text: string, isActive: (toolName: string) => boolean): boolean {
  return (text.match(/portal_[a-z0-9_]+/g) ?? []).every((tool) => isActive(tool))
}

function activeNotes(notes: string[], isActive: (toolName: string) => boolean): string[] {
  return notes.filter((note) => mentionsOnlyActiveTools(note, isActive))
}

function pruneToolEntryProse(tool: ToolGuideEntry, isActive: (toolName: string) => boolean): ToolGuideEntry {
  return {
    ...tool,
    when_to_use: activeNotes(tool.when_to_use, isActive),
    ...(tool.avoid_when ? { avoid_when: activeNotes(tool.avoid_when, isActive) } : {}),
  }
}

function buildDeveloperToolGuide(isActive: (toolName: string) => boolean) {
  const tools = getToolGuideEntries()
    .filter((tool) => isActive(tool.name))
    .map((tool) => pruneToolEntryProse(tool, isActive))
  const publicTools = tools.filter((tool) => tool.audience === 'public')
  const advancedTools = tools.filter((tool) => tool.audience === 'advanced')

  return {
    description: 'Developer-facing guide for selecting SQD Portal MCP tools and starting from common workflows.',
    version: npmVersion,
    counts: {
      tools: tools.length,
      public: publicTools.length,
      advanced: advancedTools.length,
    },
    recommended_starting_points: [
      {
        job: 'Find the right network name or VM family',
        tool: 'portal_list_networks',
        reason:
          'Use this before any query when a user says "Base", "Polkadot", "Hyperliquid", or another fuzzy chain name.',
      },
      {
        job: 'Check whether a network is indexed and fresh',
        tool: 'portal_get_network_info',
        reason: 'Use this before debugging missing data or stale-looking results.',
      },
      {
        job: 'Resolve user-facing entity names before querying',
        tool: 'portal_resolve_entity',
        reason:
          'Use this when a user says a token symbol, contract alias, pool identifier, protocol name, or Hyperliquid coin name and you need explicit filters.',
      },
      {
        job: 'Show recent activity without manual block math',
        tool: 'portal_get_recent_activity',
        reason: 'Best first tool for broad "what happened recently?" prompts across supported VMs.',
      },
      {
        job: 'Summarize a wallet before drilling into raw records',
        tool: 'portal_get_wallet_summary',
        reason: 'Returns a cross-chain overview, recent activity, counterparties, and chain-specific sections.',
      },
      {
        job: 'Build chart-ready buckets or period comparisons',
        tool: 'portal_get_time_series',
        reason: 'Use when the developer or model needs time-series, grouped trend, or compare-previous output.',
      },
    ].filter((entry) => isActive(entry.tool)),
    common_question_routes: activeRoutes(
      [
        {
          ask: 'Investigate this wallet or suspicious address',
          start_with: 'portal_get_wallet_summary',
          then_use: [
            'portal_evm_query_transactions',
            'portal_evm_query_token_transfers',
            'portal_evm_query_traces',
            'portal_solana_query_transactions',
            'portal_hyperliquid_query_fills',
          ],
          reason:
            'Wallet summary returns fund_flow, separate activity and asset-movement counterparties, largest movements within each asset, and investigation pivots before raw record drill-down.',
        },
        {
          ask: 'Trace USDC or token outflows',
          start_with: 'portal_resolve_entity',
          then_use: ['portal_evm_query_token_transfers', 'portal_get_wallet_summary'],
          reason:
            'Resolve the token symbol first, then query exact transfer evidence and summarize the sender or recipient wallet.',
        },
        {
          ask: 'Explain why network or contract activity spiked',
          start_with: 'portal_get_time_series',
          then_use: ['portal_evm_query_logs', 'portal_evm_query_transactions', 'portal_evm_get_contract_activity'],
          reason:
            'Use complete buckets to find the spike, then pivot into exact logs, transactions, or contract activity.',
        },
        {
          ask: 'What did this contract do recently?',
          start_with: 'portal_evm_get_contract_activity',
          then_use: ['portal_evm_query_logs', 'portal_evm_query_transactions', 'portal_evm_query_traces'],
          reason:
            'Contract activity gives the overview; raw logs, transactions, and traces provide exact evidence rows.',
        },
        {
          ask: 'What did this transaction call internally?',
          start_with: 'portal_evm_query_traces',
          then_use: ['portal_evm_query_logs', 'portal_evm_get_contract_deployment'],
          reason:
            'Traces filtered by transaction_hash return every internal call, creation, and value move with a deterministic id; logs and deployment lookups add the emitted events and creation context.',
        },
      ],
      isActive,
    ),
    integration_notes: activeNotes(
      [
        'Prefer public tools for normal agent flows; advanced tools are for debugging Portal coverage or exact block resolution.',
        'Use network parameters in public APIs. Raw Portal dataset names are resolved internally.',
        'Most query tools support timeframe or timestamp inputs, so clients rarely need to calculate block ranges themselves.',
        'Use portal_resolve_entity or token_symbols on supported EVM tools instead of hardcoding entity identifiers in client code.',
        'Raw query tools default to compact output. Use response_format: "full" only when the caller needs chain-specific raw fields.',
        'Wallet investigations should start from fund_flow and investigation.pivots, then use raw tools only for evidence drill-down.',
        'For chartable responses, read chart and tables metadata before inferring visual structure from raw arrays.',
      ],
      isActive,
    ),
    categories: groupToolsByCategory(tools),
    tools,
  }
}

export function registerSchemaResource(server: McpServer) {
  const isActive = captureToolActivePredicate()

  /* These four resources now vary with the connection's toolset selection, so a
   response cached for one caller must never be replayed to another. `public`
   invited exactly that: a full-catalog client's copy served to a trimmed one. */
  server.registerResource(
    'tool-guide',
    'sqd://tools',
    { mimeType: 'application/json', cacheHint: { ttlMs: 300_000, cacheScope: 'private' } },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(buildDeveloperToolGuide(isActive), null, 2),
          },
        ],
      }
    },
  )

  server.registerResource(
    'tool-guide-entry',
    new ResourceTemplate('sqd://tools/{name}', { list: undefined }),
    { mimeType: 'application/json', cacheHint: { ttlMs: 300_000, cacheScope: 'private' } },
    async (uri, { name }) => {
      const toolName = Array.isArray(name) ? name[0] : name
      const tool = getToolGuideEntry(toolName)
      if (!tool || !isActive(tool.name)) {
        throw new Error(`Unknown Portal MCP tool "${toolName}". Read sqd://tools for the current tool guide.`)
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            // Pruned the same way the guide's own list is: this entry's
            // advice names other tools, and serving it raw put back exactly
            // the prose the list had already filtered out.
            text: JSON.stringify(pruneToolEntryProse(tool, isActive), null, 2),
          },
        ],
      }
    },
  )

  // Resource: List all datasets
  server.registerResource(
    'datasets',
    'sqd://datasets',
    { mimeType: 'application/json', cacheHint: { ttlMs: 60_000, cacheScope: 'public' } },
    async (uri) => {
      const datasets = await getDatasets()
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(datasets, null, 2),
          },
        ],
      }
    },
  )

  // Resource: Dataset info template
  server.registerResource(
    'dataset-info',
    new ResourceTemplate('sqd://datasets/{name}', { list: undefined }),
    { mimeType: 'application/json', cacheHint: { ttlMs: 30_000, cacheScope: 'public' } },
    async (uri, { name }) => {
      let datasetName = Array.isArray(name) ? name[0] : name
      datasetName = await resolveDataset(datasetName)
      const metadata = await portalFetch<DatasetMetadata>(`${PORTAL_URL}/datasets/${datasetName}/metadata`)
      const head = await portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${datasetName}/head`)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ ...metadata, head }, null, 2),
          },
        ],
      }
    },
  )

  // Resource: EVM API Schema
  server.registerResource(
    'schema-evm',
    'sqd://schema/evm',
    { mimeType: 'application/json', cacheHint: { ttlMs: 300_000, cacheScope: 'public' } },
    async (uri) => {
      const schema = {
        description: 'SQD Portal EVM API Documentation',
        version: npmVersion,
        endpoints: {
          blocks: {
            description: 'Query block data',
            fields: Object.keys(buildEvmBlockFields(true)),
            filters: ['number', 'hash'],
          },
          transactions: {
            description: 'Query transaction data',
            fields: Object.keys(buildEvmTransactionFields(true)),
            filters: ['from', 'to', 'sighash', 'firstNonce', 'lastNonce'],
            relatedData: ['logs', 'traces', 'stateDiffs'],
          },
          logs: {
            description: 'Query event logs',
            fields: Object.keys(buildEvmLogFields()),
            filters: ['address', 'topic0', 'topic1', 'topic2', 'topic3'],
            relatedData: ['transaction', 'transactionTraces', 'transactionLogs'],
          },
          traces: {
            description: 'Query internal transactions/traces',
            fields: Object.keys(buildEvmTraceFields()),
            filters: [
              'type',
              'callFrom',
              'callTo',
              'callSighash',
              'suicideRefundAddress',
              'rewardAuthor',
              'createResultAddress',
            ],
            relatedData: ['transaction', 'transactionLogs', 'subtraces', 'parents'],
          },
          stateDiffs: {
            description: 'Query state changes',
            fields: Object.keys(buildEvmStateDiffFields()),
            filters: ['address', 'key', 'kind'],
            kindValues: {
              '=': 'exists (no change)',
              '+': 'created',
              '*': 'modified',
              '-': 'deleted',
            },
          },
        },
        l2Fields: [
          'l1Fee',
          'l1FeeScalar',
          'l1GasPrice',
          'l1GasUsed',
          'l1BlobBaseFee',
          'l1BlobBaseFeeScalar',
          'l1BaseFeeScalar',
          'l1BlockNumber',
        ],
        eventSignatures: EVENT_SIGNATURES,
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      }
    },
  )

  // Resource: Solana API Schema
  server.registerResource(
    'schema-solana',
    'sqd://schema/solana',
    { mimeType: 'application/json', cacheHint: { ttlMs: 300_000, cacheScope: 'public' } },
    async (uri) => {
      const schema = {
        description: 'SQD Portal Solana API Documentation',
        version: npmVersion,
        endpoints: {
          instructions: {
            description: 'Query instruction data',
            fields: Object.keys(buildSolanaInstructionFields(true)),
            filters: [
              'programId',
              'd1',
              'd2',
              'd4',
              'd8',
              'a0-a15 (account positions)',
              'mentionsAccount',
              'isCommitted',
              'transactionFeePayer',
            ],
            discriminatorInfo: {
              d1: '1-byte discriminator (0x-prefixed hex)',
              d2: '2-byte discriminator (0x-prefixed hex)',
              d4: '4-byte discriminator (0x-prefixed hex)',
              d8: '8-byte discriminator - Anchor standard (0x-prefixed hex)',
            },
            relatedData: [
              'transaction',
              'transactionBalances',
              'transactionTokenBalances',
              'transactionInstructions',
              'innerInstructions',
              'logs',
            ],
          },
          transactions: {
            description: 'Query transaction data',
            fields: Object.keys(buildSolanaTransactionFields()),
            filters: ['feePayer', 'isCommitted'],
          },
          balances: {
            description: 'Query SOL balance changes',
            fields: Object.keys(buildSolanaBalanceFields()),
            filters: ['account'],
          },
          tokenBalances: {
            description: 'Query SPL token balance changes',
            fields: Object.keys(buildSolanaTokenBalanceFields()),
            filters: ['account', 'mint', 'owner', 'preProgramId', 'postProgramId'],
          },
          logs: {
            description: 'Query log messages',
            fields: Object.keys(buildSolanaLogFields()),
            filters: ['programId', 'kind'],
            kindValues: ['log', 'data', 'other'],
          },
          rewards: {
            description: 'Query block rewards',
            fields: Object.keys(buildSolanaRewardFields()),
            filters: ['pubkey'],
          },
        },
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      }
    },
  )

  // Resource: Bitcoin API Schema
  server.registerResource(
    'schema-bitcoin',
    'sqd://schema/bitcoin',
    { mimeType: 'application/json', cacheHint: { ttlMs: 300_000, cacheScope: 'public' } },
    async (uri) => {
      const schema = {
        description: 'SQD Portal Bitcoin API Documentation',
        version: npmVersion,
        queryType: 'bitcoin',
        endpoints: {
          blocks: {
            description: 'Query Bitcoin block headers',
            fields: Object.keys(buildBitcoinBlockFields()),
          },
          transactions: {
            description: 'Query Bitcoin transactions',
            fields: Object.keys(buildBitcoinTransactionFields()),
            relatedData: ['inputs', 'outputs'],
          },
          inputs: {
            description: 'Query spent transaction inputs (prevouts)',
            fields: Object.keys(buildBitcoinInputFields()),
            filters: ['type', 'prevoutScriptPubKeyAddress', 'prevoutScriptPubKeyType'],
            relatedData: ['transaction', 'transactionOutputs'],
          },
          outputs: {
            description: 'Query transaction outputs (UTXOs)',
            fields: Object.keys(buildBitcoinOutputFields()),
            filters: ['scriptPubKeyAddress', 'scriptPubKeyType'],
            relatedData: ['transaction', 'transactionInputs'],
          },
        },
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      }
    },
  )

  // Resource: Substrate API Schema
  server.registerResource(
    'schema-substrate',
    'sqd://schema/substrate',
    { mimeType: 'application/json', cacheHint: { ttlMs: 300_000, cacheScope: 'public' } },
    async (uri) => {
      const schema = {
        description: 'SQD Portal Substrate API Documentation',
        version: npmVersion,
        queryType: 'substrate',
        endpoints: {
          blocks: {
            description: 'Query Substrate block headers',
            fields: Object.keys(buildSubstrateBlockFields()),
          },
          extrinsics: {
            description: 'Query Substrate extrinsics',
            fields: Object.keys(buildSubstrateExtrinsicFields()),
          },
          calls: {
            description: 'Query runtime calls',
            fields: Object.keys(buildSubstrateCallFields()),
            filters: ['name'],
            relatedData: ['extrinsic', 'events', 'stack'],
          },
          events: {
            description: 'Query runtime events',
            fields: Object.keys(buildSubstrateEventFields()),
            filters: ['name'],
            relatedData: ['extrinsic', 'call', 'stack'],
          },
        },
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      }
    },
  )

  // Resource: Hyperliquid API Schema
  server.registerResource(
    'schema-hyperliquid',
    'sqd://schema/hyperliquid',
    { mimeType: 'application/json', cacheHint: { ttlMs: 300_000, cacheScope: 'public' } },
    async (uri) => {
      const schema = {
        description: 'SQD Portal Hyperliquid API Documentation',
        version: npmVersion,
        datasets: {
          'hyperliquid-fills': {
            queryType: 'hyperliquidFills',
            endpoints: {
              fills: {
                description: 'Query perpetual trade fills',
                fields: [
                  'fillIndex',
                  'user',
                  'coin',
                  'px',
                  'sz',
                  'side',
                  'time',
                  'startPosition',
                  'dir',
                  'closedPnl',
                  'hash',
                  'oid',
                  'crossed',
                  'fee',
                  'tid',
                  'feeToken',
                  'builderFee',
                ],
                filters: ['user', 'coin', 'dir', 'cloid', 'feeToken'],
              },
            },
          },
          'hyperliquid-replica-cmds': {
            queryType: 'hyperliquidReplicaCmds',
            endpoints: {
              actions: {
                description: 'Query signed Hyperliquid L1 replica actions',
                fields: ['actionIndex', 'user', 'action', 'nonce', 'signature', 'status'],
                filters: ['user', 'actionType'],
              },
            },
          },
        },
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      }
    },
  )

  // Resource: Tron API Schema
  server.registerResource(
    'schema-tron',
    'sqd://schema/tron',
    { mimeType: 'application/json', cacheHint: { ttlMs: 300_000, cacheScope: 'public' } },
    async (uri) => {
      const schema = {
        description: 'SQD Portal Tron API Documentation',
        version: npmVersion,
        queryType: 'tron',
        addressNote:
          'Portal Tron uses three hex encodings by context: transaction filters (owner, to, contract) use 41-prefixed 21-byte hex without 0x; log emitter filters (address) use bare 20-byte hex without 0x or 41 prefix; indexed log address topics (topic1/topic2) use 32-byte (64-char) left-padded hex without 0x. MCP tools accept Base58 (T...), 41-hex, or 0x/bare 20-byte hex and convert automatically.',
        endpoints: {
          blocks: {
            description: 'Query Tron block headers (millisecond timestamps)',
            fields: Object.keys(buildTronBlockFields()),
          },
          transactions: {
            description:
              'Query all Tron transactions or narrow families via transferTransactions, transferAssetTransactions, and triggerSmartContractTransactions',
            addressFormat: '41-prefixed 21-byte hex without 0x for owner, to, and contract filters',
            fields: Object.keys(buildTronTransactionFields()),
            requestKeys: [
              'transactions',
              'transferTransactions',
              'transferAssetTransactions',
              'triggerSmartContractTransactions',
            ],
            filters: {
              transactions: ['type'],
              transferTransactions: ['owner', 'to'],
              transferAssetTransactions: ['owner', 'to', 'asset'],
              triggerSmartContractTransactions: ['owner', 'contract', 'sighash'],
            },
            relatedData: ['logs', 'internalTransactions'],
          },
          logs: {
            description: 'Query TRC-20 and smart-contract event logs',
            addressFormat:
              'Bare 20-byte hex (no 0x, no 41 prefix) for address (emitting contract); 32-byte left-padded hex (no 0x) for topic1/topic2 addresses',
            fields: Object.keys(buildTronLogFields()),
            filters: ['address', 'topic0', 'topic1', 'topic2', 'topic3'],
            relatedData: ['transaction'],
          },
          internalTransactions: {
            description: 'Query internal calls and value transfers',
            fields: Object.keys(buildTronInternalTransactionFields()),
          },
        },
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      }
    },
  )
}
