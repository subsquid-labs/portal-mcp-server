type ToolAudience = 'public' | 'advanced'
type ToolCategory =
  | 'discovery'
  | 'convenience'
  | 'evm'
  | 'solana'
  | 'bitcoin'
  | 'substrate'
  | 'hyperliquid'
  | 'tron'
  | 'debug'
type ToolIntent = 'discover' | 'lookup' | 'query' | 'summary' | 'analytics' | 'chart' | 'debug'
type ToolVm = 'cross-chain' | 'evm' | 'solana' | 'bitcoin' | 'substrate' | 'hyperliquid' | 'tron'
type ToolResultKind = 'list' | 'summary' | 'chart' | 'lookup'
type TimeInput = 'blocks' | 'timeframe' | 'timestamps'

type ToolExample = {
  label: string
  input: Record<string, unknown>
}

type RuntimeToolContract = {
  name: string
  audience: ToolAudience
  category: ToolCategory
  intent: ToolIntent
  vm: ToolVm[]
  result_kind: ToolResultKind
  normalized_output: boolean
  first_choice_for?: string[]
  supports?: {
    pagination?: boolean
    response_formats?: Array<'full' | 'compact' | 'summary'>
    modes?: string[]
    time_inputs?: TimeInput[]
    decode?: boolean
    compare_previous?: boolean
    group_by?: string[]
  }
}

export type ToolDefinition = RuntimeToolContract & {
  summary: string
  when_to_use: string[]
  avoid_when?: string[]
  examples: ToolExample[]
}

export type ToolGuideEntry = ToolDefinition

export type ToolExecutionMetadataInput = {
  mode?: string
  response_format?: string
  result_scope?: string
  estimated_runtime_class?: string
  estimated_scan_blocks?: number
  requested_blocks?: number
  analyzed_blocks?: number
  recommended_window?: string
  scan_order?: string
  order_by?: string
  range_kind?: string
  from_block?: number
  to_block?: number
  page_to_block?: number
  limit?: number
  finalized_only?: boolean
  metric?: string
  interval?: string
  duration?: string
  duration_seconds?: number
  group_by?: string
  compare_previous?: boolean
  decode?: boolean
  normalized_output?: boolean
  notes?: string[]
}

const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  portal_list_networks: {
    name: 'portal_list_networks',
    audience: 'public',
    category: 'discovery',
    intent: 'discover',
    vm: ['cross-chain'],
    result_kind: 'list',
    normalized_output: false,
    first_choice_for: ['finding the correct network before any other query'],
    summary: 'Find the right network or chain name to use across EVM, Solana, Bitcoin, Substrate, and Hyperliquid.',
    when_to_use: [
      'You are not sure which network name, chain name, or alias to use.',
      'You want to filter networks by VM family, network type, or real-time availability.',
    ],
    avoid_when: ['You already know the exact network and want live data from that network.'],
    examples: [
      { label: 'Find Base-like networks', input: { query: 'base', limit: 10 } },
      { label: 'Show Solana mainnets', input: { vm: 'solana', network_type: 'mainnet' } },
      { label: 'Show Substrate mainnets', input: { vm: 'substrate', network_type: 'mainnet' } },
    ],
    supports: {
      time_inputs: [],
    },
  },
  portal_get_network_info: {
    name: 'portal_get_network_info',
    audience: 'public',
    category: 'discovery',
    intent: 'lookup',
    vm: ['cross-chain'],
    result_kind: 'lookup',
    normalized_output: false,
    first_choice_for: ['checking indexing head, lag, tables, and capabilities for one network'],
    summary: 'Answer "is this network caught up?" with indexing freshness, lag, heads, and available tables.',
    when_to_use: [
      'You want to know whether a network is indexed, fresh, caught up, or behind before querying.',
      'You need chain family, real-time status, or available tables for a network.',
    ],
    avoid_when: ['You only need the latest block or slot number.'],
    examples: [{ label: 'Is Base caught up?', input: { network: 'base-mainnet' } }],
    supports: {
      time_inputs: [],
    },
  },
  portal_get_head: {
    name: 'portal_get_head',
    audience: 'public',
    category: 'discovery',
    intent: 'lookup',
    vm: ['cross-chain'],
    result_kind: 'lookup',
    normalized_output: false,
    first_choice_for: ['getting the current indexed head before building a manual block range'],
    summary: 'Get just the latest indexed head block or slot for a network.',
    when_to_use: [
      'You only need the current block or slot number.',
      'You need the current head before building a raw block-range query.',
    ],
    avoid_when: ['You want to know if the network is caught up, behind, fresh, or what tables are available.'],
    examples: [
      { label: 'Latest head', input: { network: 'base-mainnet' } },
      { label: 'Finalized head', input: { network: 'ethereum-mainnet', type: 'finalized' } },
    ],
    supports: {
      time_inputs: [],
    },
  },
  portal_resolve_entity: {
    name: 'portal_resolve_entity',
    audience: 'public',
    category: 'discovery',
    intent: 'lookup',
    vm: ['cross-chain'],
    result_kind: 'lookup',
    normalized_output: true,
    first_choice_for: [
      'resolving a token symbol like USDC to token contract addresses',
      'resolving EVM contract aliases, protocol names, pool identifiers, or Hyperliquid coin names before querying',
      'checking which token-list addresses a symbol maps to before querying logs or transfers',
      'turning a user-friendly token name into deterministic EVM filters',
    ],
    summary: 'Resolve user-facing blockchain entities into query-ready identifiers, with ambiguity kept explicit.',
    when_to_use: [
      'The user names a token symbol such as USDC, WETH, DAI, or PEPE and you need contract addresses before querying raw data.',
      'The user names a well-known EVM contract, protocol, pool identifier, or Hyperliquid ticker and you need a deterministic follow-up filter.',
      'You need to disambiguate bridged token variants on an EVM network.',
      'You want a source-backed token address rather than relying on memory or hardcoded constants.',
    ],
    avoid_when: [
      'You already have the exact address, pool id, protocol slug, or coin filter and can pass it directly.',
    ],
    examples: [
      { label: 'Resolve USDC on Base', input: { network: 'base-mainnet', kind: 'token', query: 'USDC', limit: 10 } },
      {
        label: 'Resolve WETH on Ethereum',
        input: { network: 'ethereum-mainnet', kind: 'token', query: 'WETH', limit: 5 },
      },
      { label: 'Resolve BAYC contract', input: { network: 'ethereum-mainnet', kind: 'contract', query: 'bored apes' } },
      { label: 'Resolve Hyperliquid coin', input: { kind: 'hyperliquid_coin', query: 'bitcoin' } },
    ],
    supports: {
      time_inputs: [],
    },
  },
  portal_get_recent_activity: {
    name: 'portal_get_recent_activity',
    audience: 'public',
    category: 'convenience',
    intent: 'summary',
    vm: ['cross-chain'],
    result_kind: 'list',
    normalized_output: true,
    first_choice_for: [
      'recent activity on any supported network without manual block math',
      'questions like "what has been happening on Base lately?"',
      'first-pass incident triage when the user asks what happened recently on a network',
    ],
    summary:
      'Get a simple recent-activity feed across EVM, Solana, Bitcoin, or Hyperliquid with chronological paging and investigation pivots.',
    when_to_use: [
      'You want a quick recent-activity feed for a network.',
      'You want to ask what has been happening lately on a network and see the newest activity first.',
      'You want the simplest starting point before reaching for raw VM-specific query tools.',
      'You are investigating an incident and need a bounded, recent evidence timeline before narrowing to wallets, transfers, logs, or fills.',
    ],
    avoid_when: [
      'You need raw logs, instructions, or chain-specific fields that only raw query tools return.',
      'You want a chart over time rather than a recent feed.',
    ],
    examples: [
      { label: 'Recent activity on Base', input: { network: 'base-mainnet', timeframe: '1h', limit: 10 } },
      { label: 'Recent Hyperliquid fills', input: { network: 'hyperliquid-fills', timeframe: '1h', limit: 10 } },
    ],
    supports: {
      pagination: true,
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_get_wallet_summary: {
    name: 'portal_get_wallet_summary',
    audience: 'public',
    category: 'convenience',
    intent: 'summary',
    vm: ['cross-chain'],
    result_kind: 'summary',
    normalized_output: true,
    first_choice_for: [
      'one-call wallet analysis across supported VMs',
      'suspicious wallet triage, fund-flow direction, counterparties, and next evidence pivots before drilling into raw records',
    ],
    summary:
      'Summarize wallet activity and fund flow with shared overview, asset movement, counterparties, evidence pivots, and follow-up filters across supported networks.',
    when_to_use: [
      'You want a single high-level answer about what one wallet has been doing and where value appears to move.',
      'You want inbound/outbound flow, activity and asset-movement counterparties, largest movements within each asset, and exact next pivots before drilling into raw transactions or fills.',
      'The user asks to investigate a suspicious wallet, stolen-funds path, exploit counterparty, or incident address.',
    ],
    avoid_when: ['You need every raw record with full chain-specific fields and no summarization.'],
    examples: [
      {
        label: 'EVM wallet fund-flow triage',
        input: { network: 'base-mainnet', address: '0xabc...', timeframe: '24h' },
      },
      {
        label: 'Solana wallet activity and fee flow',
        input: { network: 'solana-mainnet', address: 'Vote111...', timeframe: '6h' },
      },
    ],
    supports: {
      pagination: true,
      modes: ['fast', 'deep'],
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_get_time_series: {
    name: 'portal_get_time_series',
    audience: 'public',
    category: 'convenience',
    intent: 'chart',
    vm: ['cross-chain'],
    result_kind: 'chart',
    normalized_output: false,
    first_choice_for: ['activity over time, compare-current-vs-previous, grouped trends, and simple activity charts'],
    summary:
      'Build simple activity charts and other time-series views across supported VMs, including compare-previous windows and grouped EVM contract trends.',
    when_to_use: [
      'You want chart-ready metric buckets over time.',
      'You want a simple activity chart. Use a shorter window on fast networks such as Base.',
      'You want to compare the current period to the previous period.',
    ],
    avoid_when: [
      'You need raw record lists instead of aggregated buckets.',
      'You need DEX pool candles or OHLC output.',
    ],
    examples: [
      {
        label: 'Base transactions per 5m bucket',
        input: { network: 'base-mainnet', metric: 'transaction_count', duration: '15m', interval: '5m' },
      },
      {
        label: 'Compare two periods',
        input: {
          network: 'solana-mainnet',
          metric: 'transaction_count',
          duration: '1h',
          interval: '5m',
          compare_previous: true,
        },
      },
    ],
    supports: {
      modes: ['fast', 'deep'],
      time_inputs: ['timeframe', 'timestamps'],
      compare_previous: true,
      group_by: ['none', 'contract'],
    },
  },
  portal_substrate_query_events: {
    name: 'portal_substrate_query_events',
    audience: 'public',
    category: 'substrate',
    intent: 'query',
    vm: ['substrate'],
    result_kind: 'list',
    normalized_output: true,
    first_choice_for: ['raw Substrate or Polkadot event rows with optional parent call or extrinsic context'],
    summary:
      'Query raw Substrate or Polkadot event rows with pallet/event-name filters and optional parent call or extrinsic context.',
    when_to_use: [
      'You need raw event records on a Substrate network.',
      'You want pallet-level event activity like Balances.Transfer or Contracts.ContractEmitted.',
      'You want event rows first, even if the network is a Polkadot-family chain.',
    ],
    avoid_when: ['You want calls or aggregate analytics rather than event rows.'],
    examples: [
      {
        label: 'Balances.Transfer events on Polkadot',
        input: { network: 'polkadot', timeframe: '1h', event_names: ['Balances.Transfer'], limit: 20 },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_substrate_query_calls: {
    name: 'portal_substrate_query_calls',
    audience: 'public',
    category: 'substrate',
    intent: 'query',
    vm: ['substrate'],
    result_kind: 'list',
    normalized_output: true,
    first_choice_for: [
      'raw Substrate or Polkadot call rows, especially when you want the events emitted by those calls',
    ],
    summary:
      'Query raw Substrate or Polkadot calls with pallet/call-name filters and optional child-call, emitted-event, or extrinsic context.',
    when_to_use: [
      'You need raw call records on a Substrate network.',
      'You want pallet call activity like Balances.transfer_keep_alive or Ethereum.transact.',
      'You want calls plus the events emitted by those calls.',
    ],
    avoid_when: ['You want events or aggregate analytics rather than call rows.'],
    examples: [
      {
        label: 'Recent Balances calls',
        input: { network: 'polkadot', timeframe: '1h', call_names: ['Balances.transfer_keep_alive'], limit: 20 },
      },
      {
        label: 'Polkadot calls with emitted events',
        input: {
          network: 'polkadot',
          timeframe: '1h',
          call_names: ['ParaInherent.enter'],
          include_events: true,
          limit: 20,
        },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_substrate_get_analytics: {
    name: 'portal_substrate_get_analytics',
    audience: 'public',
    category: 'substrate',
    intent: 'analytics',
    vm: ['substrate'],
    result_kind: 'summary',
    normalized_output: false,
    first_choice_for: [
      'Polkadot activity analytics in an indexed window',
      'how Polkadot is doing in an indexed window',
      'analytics snapshot for Polkadot or another Substrate network in an indexed window',
    ],
    summary:
      'Analytics snapshot for Substrate or Polkadot activity in an indexed window, with event, call, and extrinsic counts plus top event and call names.',
    when_to_use: [
      'You want Polkadot activity analytics in a selected indexed window.',
      'You want to ask "how is Polkadot doing in this indexed window?" and get an analytics answer rather than just network freshness metadata.',
      'You want a quick Substrate network snapshot or health check.',
      'You want top pallet events and calls rather than raw rows.',
      'You want to know how a Substrate network is doing in the selected indexed window.',
    ],
    avoid_when: ['You need full raw event or call records.'],
    examples: [
      { label: 'Polkadot activity snapshot', input: { network: 'polkadot', timeframe: '1h' } },
      { label: 'Big picture for Polkadot activity', input: { network: 'polkadot', timeframe: '1h' } },
      { label: 'How is Polkadot doing?', input: { network: 'polkadot', timeframe: '6h' } },
    ],
    supports: {
      modes: ['fast', 'deep'],
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_evm_query_transactions: {
    name: 'portal_evm_query_transactions',
    audience: 'public',
    category: 'evm',
    intent: 'query',
    vm: ['evm'],
    result_kind: 'list',
    normalized_output: true,
    summary:
      'Query raw EVM transactions with optional logs, traces, state-diff context, and evidence pivots for transaction-level investigations.',
    when_to_use: [
      'You need raw transaction records on an EVM network.',
      'You want chain-specific transaction fields or include flags that convenience tools do not expose.',
      'You need exact transaction evidence for an investigation, including sender, receiver, transaction hash, logs, traces, or failed calls.',
      'You need to find the first transaction matching a raw field condition such as transaction type 0x1 from a known block.',
      'You need top-N raw transactions ranked by value, gas used, or effective gas price.',
      'You need top senders or receivers from a bounded transaction window.',
      'You want common method names such as transfer, approve, deposit, or withdraw instead of remembering sighashes.',
      'You want calls to a token contract by symbol, such as transfer calls to USDC, without hardcoding token addresses.',
    ],
    avoid_when: ['You only need a quick recent feed or wallet-level summary.'],
    examples: [
      { label: 'Recent Base transactions', input: { network: 'base-mainnet', timeframe: '1h', limit: 20 } },
      {
        label: 'Filter by sender',
        input: { network: 'ethereum-mainnet', timeframe: '6h', from_addresses: ['0xabc...'], limit: 20 },
      },
      {
        label: 'First EIP-2930 transaction from Berlin fork',
        input: {
          network: 'ethereum-mainnet',
          from_block: 12244000,
          transaction_type: '0x1',
          scan_order: 'earliest',
          limit: 1,
          field_preset: 'minimal',
        },
      },
      {
        label: 'Largest recent calls to a resolved token contract',
        input: {
          network: 'base-mainnet',
          timeframe: '1h',
          to_token_symbols: ['USDC'],
          method: 'transfer',
          order_by: 'gas_used_desc',
          limit: 5,
        },
      },
      {
        label: 'Top senders by transaction count',
        input: {
          network: 'base-mainnet',
          timeframe: '1h',
          aggregate_by: 'sender',
          aggregate_metric: 'count',
          limit: 10,
        },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_evm_query_logs: {
    name: 'portal_evm_query_logs',
    audience: 'public',
    category: 'evm',
    intent: 'query',
    vm: ['evm'],
    result_kind: 'list',
    normalized_output: true,
    first_choice_for: [
      'NFT or ERC721 mint lookups such as latest pass minted, token ID, and mint transaction hash',
      'contract event questions where the user needs exact event evidence rather than wallet or transaction summaries',
    ],
    summary:
      'Query raw EVM logs with address/topic filters, common event aliases, earliest/latest scanning, and optional inline decoding.',
    when_to_use: [
      'You need event logs filtered by contract or topic signature.',
      'You want decoded log hints while still keeping the raw log shape available.',
      'You want the first or last matching event in a bounded block/time window.',
      'You want common event names such as transfer, approval, swap, mint, or burn instead of remembering topic0 hashes.',
      'You need the latest ERC721/pass mint in a bounded deployment/recent window: filter Transfer events with topic1 as the zero address, use scan_order=latest, limit=1, and decode=true to expose decoded_log.decoded.token_id plus transaction_hash.',
    ],
    avoid_when: ['You only want token transfers, which are easier with the token-transfer tool.'],
    examples: [
      {
        label: 'Recent USDC Transfer logs',
        input: {
          network: 'base-mainnet',
          timeframe: '1h',
          token_symbols: ['USDC'],
          event: 'transfer',
          limit: 20,
        },
      },
      {
        label: 'First recent USDC Transfer log',
        input: {
          network: 'base-mainnet',
          timeframe: '1h',
          token_symbols: ['USDC'],
          event: 'transfer',
          scan_order: 'earliest',
          limit: 1,
        },
      },
      {
        label: 'Latest ERC721/pass mint ID and tx hash',
        input: {
          network: 'base-mainnet',
          from_block: 46020000,
          to_block: 46100000,
          addresses: ['0xE4E70FdF2Fc1147a7f35c4c5de88E6BeA63eeAfA'],
          event: 'transfer',
          topic1: ['0x0000000000000000000000000000000000000000000000000000000000000000'],
          scan_order: 'latest',
          decode: true,
          include_transaction: true,
          limit: 1,
        },
      },
      {
        label: 'Decode logs inline',
        input: {
          network: 'ethereum-mainnet',
          timeframe: '1h',
          topic0: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
          decode: true,
          limit: 10,
        },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
      decode: true,
    },
  },
  portal_evm_query_traces: {
    name: 'portal_evm_query_traces',
    audience: 'public',
    category: 'evm',
    intent: 'query',
    vm: ['evm'],
    result_kind: 'list',
    normalized_output: true,
    first_choice_for: [
      'what a transaction called internally, including value moved by internal calls',
      'contracts deployed by an address, or the internal call tree behind an incident',
    ],
    summary:
      'Query raw EVM traces: internal calls, contract creations, self-destructs, and block rewards, filtered by caller, callee, method, deployer, or one transaction, with the parent transaction hash on every row.',
    when_to_use: [
      'You need the internal calls of a transaction: which contracts it called, with what selector and value, and which calls failed.',
      'You want contracts created by a deployer or the creation trace of a contract.',
      'You are tracing an exploit or incident below the top-level transaction and log surface.',
      'You want internal ETH transfers between contracts that emit no event.',
    ],
    avoid_when: [
      'You only need top-level transactions or event logs; those tools are cheaper.',
      'You need storage changes; state diffs are not exposed by this tool.',
    ],
    examples: [
      {
        label: 'Internal calls of one transaction',
        input: {
          network: 'ethereum-mainnet',
          from_block: 12244145,
          to_block: 12244145,
          transaction_hash: '0x851bad0415758075a1eb86776749c829b866d43179c57c3e4a4b9359a0358231',
          limit: 25,
        },
      },
      {
        label: 'Recent internal calls into a contract',
        input: {
          network: 'base-mainnet',
          timeframe: '10m',
          type: ['call'],
          call_to: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
          method: 'transfer',
          limit: 20,
        },
      },
      {
        label: 'Contracts deployed by an address',
        input: {
          network: 'base-mainnet',
          timeframe: '24h',
          type: ['create'],
          create_from: ['0x4200000000000000000000000000000000000006'],
          limit: 10,
        },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_evm_query_token_transfers: {
    name: 'portal_evm_query_token_transfers',
    audience: 'public',
    category: 'evm',
    intent: 'query',
    vm: ['evm'],
    result_kind: 'list',
    normalized_output: true,
    summary:
      'Query token-transfer activity on EVM without needing to remember Transfer event signatures. Best for "did token X move?" and asset-tracing questions.',
    when_to_use: [
      'You want ERC-20 style transfer activity filtered by token, sender, or recipient.',
      'You want the fastest answer to a token movement question like "did USDC move?".',
      'You are tracing suspicious, stolen, bridged, or exploit-related token movement and need sender/recipient/transaction pivots.',
      'You want the easiest raw transfer query on an EVM network.',
      'You need the first matching transfer in a bounded window without typing the Transfer topic hash.',
    ],
    avoid_when: ['You need arbitrary event logs beyond token transfers.'],
    examples: [
      {
        label: 'Recent USDC transfers',
        input: {
          network: 'base-mainnet',
          timeframe: '1h',
          token_symbols: ['USDC'],
          limit: 20,
        },
      },
      {
        label: 'First recent USDC transfer',
        input: {
          network: 'base-mainnet',
          timeframe: '1h',
          token_symbols: ['USDC'],
          scan_order: 'earliest',
          limit: 1,
        },
      },
    ],
    supports: {
      pagination: true,
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_evm_get_contract_deployment: {
    name: 'portal_evm_get_contract_deployment',
    audience: 'public',
    category: 'evm',
    intent: 'lookup',
    vm: ['evm'],
    result_kind: 'lookup',
    normalized_output: true,
    first_choice_for: [
      'who deployed this EVM contract',
      'when was this contract deployed',
      'what deployment transaction created this contract',
    ],
    summary:
      'Locate the create trace and parent transaction that deployed a specific EVM contract address within a bounded window.',
    when_to_use: [
      'You need the deployer, deployment block, deployment timestamp, or deployment transaction for an EVM contract.',
      'You can provide a starting block/time window, a contract address, or a supported well-known contract alias such as BAYC/Bored Apes.',
      'You want a deployment lookup instead of general contract activity.',
    ],
    avoid_when: [
      'You need all activity for a contract after deployment.',
      'The contract is old and no block/time hint is available; provide from_block or from_timestamp first.',
    ],
    examples: [
      {
        label: 'Find BAYC deployment',
        input: {
          network: 'ethereum-mainnet',
          contract: 'bored apes',
          from_block: 12000000,
          to_block: 13000000,
          scan_order: 'earliest',
        },
      },
      {
        label: 'Find recent deployment',
        input: { network: 'base-mainnet', contract_address: '0xabc...', search_depth_blocks: 100000 },
      },
      {
        label: 'Find deployment from known range',
        input: {
          network: 'ethereum-mainnet',
          contract_address: '0xabc...',
          from_block: 17000000,
          to_block: 17100000,
          scan_order: 'earliest',
        },
      },
    ],
    supports: {
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_evm_get_contract_activity: {
    name: 'portal_evm_get_contract_activity',
    audience: 'public',
    category: 'evm',
    intent: 'summary',
    vm: ['evm'],
    result_kind: 'summary',
    normalized_output: false,
    first_choice_for: ['what one specific contract has been doing lately on an EVM network'],
    summary:
      'Summarize what one specific contract has been doing lately, including recent interactions, unique callers, and optional event activity.',
    when_to_use: [
      'You want to ask "what has this contract been doing?" and get a contract-level answer.',
      'You want a contract-centric activity summary instead of raw records.',
      'You need top callers and interaction volume for one contract.',
    ],
    avoid_when: [
      'You need the underlying raw logs or transactions.',
      'You want general recent network activity without naming one contract.',
    ],
    examples: [
      {
        label: 'Contract activity snapshot',
        input: { network: 'base-mainnet', contract_address: '0xabc...', timeframe: '24h' },
      },
    ],
    supports: {
      modes: ['fast', 'deep'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_evm_get_analytics: {
    name: 'portal_evm_get_analytics',
    audience: 'public',
    category: 'evm',
    intent: 'analytics',
    vm: ['evm'],
    result_kind: 'summary',
    normalized_output: false,
    first_choice_for: ['the big picture for activity on an EVM network like Base or Optimism'],
    summary: 'Get the big picture for network-wide EVM activity with ranked contracts and compact overview metrics.',
    when_to_use: [
      'You want the big picture for activity on an EVM network.',
      'You want the most active contracts on an EVM network.',
      'You want an analytics-style network overview instead of a raw record list.',
    ],
    avoid_when: ['You need chart buckets over time rather than ranked entities.'],
    examples: [{ label: 'Top contracts on Base', input: { network: 'base-mainnet', timeframe: '1h', limit: 10 } }],
    supports: {
      pagination: true,
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_evm_get_ohlc: {
    name: 'portal_evm_get_ohlc',
    audience: 'public',
    category: 'evm',
    intent: 'chart',
    vm: ['evm'],
    result_kind: 'chart',
    normalized_output: false,
    summary:
      'Build chart-ready EVM OHLC candles plus a recent trade tape from supported DEX event sources, including Uniswap v2-style swaps, Uniswap v3/v4, and Aerodrome Slipstream.',
    when_to_use: [
      'You need OHLC candles for supported EVM event-derived price sources.',
      'You want a candle chart and recent trades instead of scalar time-series buckets.',
      'You want a Dexscreener-style pool chart with hover-ready candle metadata and a trade tape.',
    ],
    avoid_when: [
      'You only need counts or scalar metrics over time.',
      'You want a simple activity chart for a network rather than pool candles.',
    ],
    examples: [
      {
        label: 'Base Uniswap v2-style swap candles',
        input: {
          network: 'base-mainnet',
          source: 'uniswap_v2_swap',
          pool_address: '0x<pool-address>',
          duration: '1h',
          interval: '5m',
          price_in: 'auto',
          include_recent_trades: true,
        },
      },
      {
        label: 'Base Uniswap candles',
        input: {
          network: 'base-mainnet',
          source: 'uniswap_v3_swap',
          pool_address: '0x<pool-address>',
          duration: '1h',
          interval: '5m',
          price_in: 'auto',
        },
      },
      {
        label: 'Base Uniswap v4 candles',
        input: {
          network: 'base-mainnet',
          source: 'uniswap_v4_swap',
          pool_id: '0x<pool-id>',
          duration: '1h',
          interval: '5m',
          price_in: 'auto',
          include_recent_trades: true,
        },
      },
      {
        label: 'Base Aerodrome Slipstream candles',
        input: {
          network: 'base-mainnet',
          source: 'aerodrome_slipstream_swap',
          pool_address: '0x<pool-address>',
          duration: '1h',
          interval: '5m',
          price_in: 'token1',
        },
      },
    ],
    supports: {
      pagination: true,
      modes: ['fast', 'deep'],
      time_inputs: ['timeframe'],
    },
  },
  portal_solana_query_transactions: {
    name: 'portal_solana_query_transactions',
    audience: 'public',
    category: 'solana',
    intent: 'query',
    vm: ['solana'],
    result_kind: 'list',
    normalized_output: true,
    summary: 'Query raw Solana transactions with optional balances, rewards, logs, and instruction context.',
    when_to_use: [
      'You need raw Solana transaction records.',
      'You want Solana-specific filters or include flags that convenience tools do not expose.',
    ],
    avoid_when: ['You only want recent activity or a compact network summary.'],
    examples: [
      { label: 'Recent Solana transactions', input: { network: 'solana-mainnet', timeframe: '1h', limit: 20 } },
      {
        label: 'Filter by program',
        input: {
          network: 'solana-mainnet',
          timeframe: '1h',
          program_id: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
          limit: 20,
        },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_solana_query_instructions: {
    name: 'portal_solana_query_instructions',
    audience: 'public',
    category: 'solana',
    intent: 'query',
    vm: ['solana'],
    result_kind: 'list',
    normalized_output: true,
    summary: 'Query raw Solana instructions with program and account filters.',
    when_to_use: [
      'You need program-level or account-level instruction activity.',
      'You want to inspect Token Program, Jupiter, System Program, or Anchor discriminator activity.',
    ],
    avoid_when: ['You only need transaction-level activity and not individual instructions.'],
    examples: [
      {
        label: 'Token Program instructions',
        input: {
          network: 'solana-mainnet',
          timeframe: '1h',
          program_id: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
          limit: 20,
        },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_solana_get_analytics: {
    name: 'portal_solana_get_analytics',
    audience: 'public',
    category: 'solana',
    intent: 'analytics',
    vm: ['solana'],
    result_kind: 'summary',
    normalized_output: false,
    first_choice_for: ['the big picture for Solana right now'],
    summary: 'Get the big picture for Solana throughput, fees, wallet activity, and optional top-program usage.',
    when_to_use: [
      'You want the big picture for Solana right now.',
      'You want a network health snapshot for Solana.',
      'You want throughput, fee, success-rate, or top-program analytics rather than raw records.',
    ],
    avoid_when: ['You want chart buckets or raw transaction/instruction records.'],
    examples: [
      { label: 'Solana network snapshot', input: { network: 'solana-mainnet', timeframe: '1h' } },
      { label: 'Include top programs', input: { network: 'solana-mainnet', timeframe: '1h', include_programs: true } },
    ],
    supports: {
      modes: ['fast', 'deep'],
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_bitcoin_query_transactions: {
    name: 'portal_bitcoin_query_transactions',
    audience: 'public',
    category: 'bitcoin',
    intent: 'query',
    vm: ['bitcoin'],
    result_kind: 'list',
    normalized_output: true,
    summary: 'Query raw Bitcoin transactions and optionally attach inputs and outputs inline.',
    when_to_use: [
      'You need raw Bitcoin transaction records.',
      'You want the UTXO envelope without switching to separate input/output tools.',
    ],
    avoid_when: ['You only need a quick wallet or network summary.'],
    examples: [
      { label: 'Recent Bitcoin transactions', input: { network: 'bitcoin-mainnet', timeframe: '1h', limit: 20 } },
      {
        label: 'Attach inputs and outputs',
        input: { network: 'bitcoin-mainnet', timeframe: '1h', include_inputs: true, include_outputs: true, limit: 10 },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_bitcoin_get_analytics: {
    name: 'portal_bitcoin_get_analytics',
    audience: 'public',
    category: 'bitcoin',
    intent: 'analytics',
    vm: ['bitcoin'],
    result_kind: 'summary',
    normalized_output: false,
    first_choice_for: ['the big picture for Bitcoin right now'],
    summary: 'Get the big picture for Bitcoin block, fee, and address activity over a recent or explicit window.',
    when_to_use: [
      'You want the big picture for Bitcoin right now.',
      'You want a network-level Bitcoin snapshot.',
      'You care about block cadence, fees, SegWit/Taproot adoption, or activity metrics.',
    ],
    avoid_when: ['You need raw transactions rather than network analytics.'],
    examples: [{ label: 'Bitcoin network snapshot', input: { network: 'bitcoin-mainnet', timeframe: '1h' } }],
    supports: {
      modes: ['fast', 'deep'],
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_hyperliquid_query_fills: {
    name: 'portal_hyperliquid_query_fills',
    audience: 'public',
    category: 'hyperliquid',
    intent: 'query',
    vm: ['hyperliquid'],
    result_kind: 'list',
    normalized_output: true,
    summary: 'Query raw individual Hyperliquid fills with trader, coin, fee, PnL, and builder context.',
    when_to_use: [
      'You need raw fill records on Hyperliquid.',
      'You want to filter by trader, coin, direction, builder, or fee token.',
    ],
    avoid_when: ['You want the big picture, top traders, grouped aggregates, or candles instead of raw fill rows.'],
    examples: [
      { label: 'Recent BTC fills', input: { network: 'hyperliquid-fills', timeframe: '1h', coin: ['BTC'], limit: 20 } },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_hyperliquid_get_analytics: {
    name: 'portal_hyperliquid_get_analytics',
    audience: 'public',
    category: 'hyperliquid',
    intent: 'analytics',
    vm: ['hyperliquid'],
    result_kind: 'summary',
    normalized_output: false,
    summary: 'Get the big-picture Hyperliquid fill analytics with top traders, volume by coin, fees, and PnL.',
    when_to_use: [
      'You want network-level Hyperliquid fill analytics.',
      'You want to know who traded the most, which coins had volume, or how fees and PnL looked.',
      'You want grouped aggregate sections without stitching raw fills together yourself.',
    ],
    avoid_when: ['You need individual fill records or OHLC candles.'],
    examples: [
      { label: 'Hyperliquid fill snapshot', input: { network: 'hyperliquid-fills', timeframe: '1h' } },
      { label: 'Who traded the most?', input: { network: 'hyperliquid-fills', timeframe: '1h' } },
    ],
    supports: {
      pagination: true,
      modes: ['fast', 'deep'],
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_hyperliquid_get_ohlc: {
    name: 'portal_hyperliquid_get_ohlc',
    audience: 'public',
    category: 'hyperliquid',
    intent: 'chart',
    vm: ['hyperliquid'],
    result_kind: 'chart',
    normalized_output: false,
    summary: 'Build chart-ready Hyperliquid trade OHLC candles with fixed buckets and auto intervals.',
    when_to_use: [
      'You want candles for one coin on Hyperliquid.',
      'You need chart-ready OHLC, volume, and VWAP data from fills.',
    ],
    avoid_when: ['You want scalar time-series buckets or raw fills.'],
    examples: [
      { label: 'BTC candles', input: { network: 'hyperliquid-fills', coin: 'BTC', duration: '6h', interval: 'auto' } },
    ],
    supports: {
      pagination: true,
      time_inputs: ['timeframe'],
    },
  },
  portal_tron_query_transactions: {
    name: 'portal_tron_query_transactions',
    audience: 'public',
    category: 'tron',
    intent: 'query',
    vm: ['tron'],
    result_kind: 'list',
    normalized_output: true,
    first_choice_for: [
      'native TRX transfers, TRC-10 transfers, and smart-contract calls on Tron',
      'who sent TRX to an address on Tron, or which wallets called a Tron contract',
    ],
    summary:
      'Query raw Tron transactions: native TRX transfers, TRC-10 asset transfers, TriggerSmartContract calls by contract and method, or any contract type, with optional inline logs and internal transactions.',
    when_to_use: [
      'You need raw Tron transaction records with sender, recipient, amount in TRX, fee, energy, and success.',
      'You want native TRX transfers to or from a wallet in a bounded window.',
      'You want calls to a Tron contract such as USDT filtered by method (transfer, approve) or caller.',
      'You want TRC-10 asset transfers by asset id.',
    ],
    avoid_when: [
      'You need TRC-20 token events; those are logs, so use portal_tron_query_logs.',
      'You need an Ethereum-compatible network; use portal_evm_query_transactions.',
    ],
    examples: [
      {
        label: 'Recent native TRX transfers',
        input: { network: 'tron-mainnet', timeframe: '5m', kind: 'transfer', limit: 20 },
      },
      {
        label: 'USDT transfer calls in a block window',
        input: {
          network: 'tron-mainnet',
          from_block: 84000000,
          to_block: 84000010,
          contract_addresses: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
          method: 'transfer',
          limit: 20,
        },
      },
      {
        label: 'TRX sent from one wallet',
        input: {
          network: 'tron-mainnet',
          timeframe: '1h',
          kind: 'transfer',
          from_addresses: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
          limit: 20,
        },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_tron_query_logs: {
    name: 'portal_tron_query_logs',
    audience: 'public',
    category: 'tron',
    intent: 'query',
    vm: ['tron'],
    result_kind: 'list',
    normalized_output: true,
    first_choice_for: [
      'TRC-20 token transfer events on Tron such as USDT',
      'contract event evidence on Tron with the parent transaction hash',
    ],
    summary:
      'Query raw Tron (TVM) event logs by contract address and topics with common event aliases, the parent transaction hash on every row, and optional inline decoding.',
    when_to_use: [
      'You need TRC-20 Transfer or Approval events for a token such as USDT on Tron.',
      'You need event logs from a Tron contract filtered by topic signature or indexed address.',
      'You want the exact transaction hash behind each Tron event.',
    ],
    avoid_when: [
      'You want native TRX transfers or contract calls; use portal_tron_query_transactions.',
      'You need an Ethereum-compatible network; use portal_evm_query_logs.',
    ],
    examples: [
      {
        label: 'Recent USDT transfers on Tron',
        input: {
          network: 'tron-mainnet',
          timeframe: '5m',
          addresses: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
          event: 'transfer',
          decode: true,
          limit: 20,
        },
      },
      {
        label: 'USDT transfers received by one wallet',
        input: {
          network: 'tron-mainnet',
          from_block: 84000000,
          to_block: 84000100,
          addresses: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
          event: 'transfer',
          topic2: ['TJLuVi6UhS3UTx5EUXNCoz9VNqP2gnPmyf'],
          decode: true,
          limit: 20,
        },
      },
    ],
    supports: {
      pagination: true,
      response_formats: ['full', 'compact', 'summary'],
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
      decode: true,
    },
  },
  portal_debug_query_blocks: {
    name: 'portal_debug_query_blocks',
    audience: 'advanced',
    category: 'debug',
    intent: 'debug',
    vm: ['cross-chain'],
    result_kind: 'list',
    normalized_output: false,
    summary: 'ADVANCED: Query raw block records directly for EVM, Solana, or Bitcoin.',
    when_to_use: [
      'You are debugging Portal coverage or block-level fields.',
      'You need raw block records instead of transactions, logs, or summaries.',
    ],
    avoid_when: [
      'You are answering a normal end-user question; prefer recent activity, time series, or raw transaction tools first.',
    ],
    examples: [{ label: 'Recent Base blocks', input: { network: 'base-mainnet', timeframe: '1h', limit: 5 } }],
    supports: {
      pagination: true,
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
  portal_debug_resolve_time_to_block: {
    name: 'portal_debug_resolve_time_to_block',
    audience: 'advanced',
    category: 'debug',
    intent: 'debug',
    vm: ['evm', 'solana', 'bitcoin', 'substrate'],
    result_kind: 'lookup',
    normalized_output: false,
    summary: 'ADVANCED: Resolve a timestamp to the nearest indexed block or slot.',
    when_to_use: [
      'You are debugging timestamp windows or building a manual block-range query.',
      'You want to inspect exact versus estimated timestamp-to-block resolution.',
    ],
    avoid_when: ['You just want to query by time; most public tools already accept natural timestamps directly.'],
    examples: [
      { label: 'Resolve one hour ago on Base', input: { network: 'base-mainnet', timestamp: '1h ago' } },
      { label: 'Resolve an older time on Polkadot', input: { network: 'polkadot', timestamp: '2026-04-08T12:00:00Z' } },
    ],
    supports: {
      time_inputs: ['timestamps'],
    },
  },
  portal_debug_hyperliquid_query_replica_commands: {
    name: 'portal_debug_hyperliquid_query_replica_commands',
    audience: 'advanced',
    category: 'debug',
    intent: 'debug',
    vm: ['hyperliquid'],
    result_kind: 'list',
    normalized_output: true,
    summary: 'ADVANCED: Query Hyperliquid replica-command actions such as orders, cancels, and leverage updates.',
    when_to_use: [
      'You are debugging Hyperliquid replica-command records.',
      'You need raw order-action events instead of fills or analytics.',
    ],
    avoid_when: ['You only need public trading activity; fills and analytics are usually the better fit.'],
    examples: [
      { label: 'Recent order action', input: { network: 'hyperliquid-replica-cmds', timeframe: '5m', limit: 1 } },
    ],
    supports: {
      pagination: true,
      time_inputs: ['blocks', 'timeframe', 'timestamps'],
    },
  },
}

function stringifyExample(input: Record<string, unknown>): string {
  return JSON.stringify(input)
}

function cloneToolDefinition(definition: ToolDefinition): ToolGuideEntry {
  return {
    ...definition,
    vm: [...definition.vm],
    first_choice_for: definition.first_choice_for ? [...definition.first_choice_for] : undefined,
    when_to_use: [...definition.when_to_use],
    avoid_when: definition.avoid_when ? [...definition.avoid_when] : undefined,
    examples: definition.examples.map((example) => ({
      label: example.label,
      input: { ...example.input },
    })),
    supports: definition.supports
      ? {
          ...definition.supports,
          response_formats: definition.supports.response_formats
            ? [...definition.supports.response_formats]
            : undefined,
          modes: definition.supports.modes ? [...definition.supports.modes] : undefined,
          time_inputs: definition.supports.time_inputs ? [...definition.supports.time_inputs] : undefined,
          group_by: definition.supports.group_by ? [...definition.supports.group_by] : undefined,
        }
      : undefined,
  }
}

export function getToolGuideEntry(toolName: string): ToolGuideEntry | undefined {
  const definition = TOOL_DEFINITIONS[toolName]
  return definition ? cloneToolDefinition(definition) : undefined
}

export function getToolGuideEntries(): ToolGuideEntry[] {
  return Object.values(TOOL_DEFINITIONS)
    .map(cloneToolDefinition)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function buildToolDescription(toolName: string): string {
  const definition = TOOL_DEFINITIONS[toolName]
  if (!definition) {
    return toolName
  }

  const lines = [definition.summary]

  lines.push('', 'COMMON USER ASKS:')
  definition.examples.slice(0, 3).forEach((example) => lines.push(`- ${example.label}`))

  if (definition.first_choice_for?.length) {
    lines.push('', 'FIRST CHOICE FOR:')
    definition.first_choice_for.forEach((item) => lines.push(`- ${item}`))
  }

  lines.push('', 'WHEN TO USE:')
  definition.when_to_use.forEach((item) => lines.push(`- ${item}`))

  if (definition.avoid_when?.length) {
    lines.push('', "DON'T USE:")
    definition.avoid_when.forEach((item) => lines.push(`- ${item}`))
  }

  lines.push('', 'EXAMPLES:')
  definition.examples.forEach((example) => {
    lines.push(`- ${example.label}: ${stringifyExample(example.input)}`)
  })

  return lines.join('\n')
}

export function getToolContract(toolName: string): RuntimeToolContract | undefined {
  const definition = TOOL_DEFINITIONS[toolName]
  if (!definition) {
    return undefined
  }

  const {
    summary: _summary,
    when_to_use: _when,
    avoid_when: _avoid,
    examples: _examples,
    ...runtimeContract
  } = definition
  return runtimeContract
}

export function buildExecutionMetadata(input: ToolExecutionMetadataInput): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {}

  if (input.mode) metadata.mode = input.mode
  if (input.response_format) metadata.response_format = input.response_format
  if (input.result_scope) metadata.result_scope = input.result_scope
  if (
    input.estimated_runtime_class ||
    input.estimated_scan_blocks !== undefined ||
    input.requested_blocks !== undefined ||
    input.analyzed_blocks !== undefined ||
    input.recommended_window
  ) {
    metadata.scan_estimate = {
      ...(input.estimated_runtime_class ? { runtime_class: input.estimated_runtime_class } : {}),
      ...(input.estimated_scan_blocks !== undefined ? { estimated_scan_blocks: input.estimated_scan_blocks } : {}),
      ...(input.requested_blocks !== undefined ? { requested_blocks: input.requested_blocks } : {}),
      ...(input.analyzed_blocks !== undefined ? { analyzed_blocks: input.analyzed_blocks } : {}),
      ...(input.recommended_window ? { recommended_window: input.recommended_window } : {}),
    }
  }
  if (input.scan_order) metadata.scan_order = input.scan_order
  if (input.order_by) metadata.order_by = input.order_by
  if (input.metric) metadata.metric = input.metric
  if (input.interval) metadata.interval = input.interval
  if (input.duration) metadata.duration = input.duration
  if (input.duration_seconds !== undefined) metadata.duration_seconds = input.duration_seconds
  if (input.group_by) metadata.group_by = input.group_by
  if (input.compare_previous !== undefined) metadata.compare_previous = input.compare_previous
  if (input.decode !== undefined) metadata.decode = input.decode
  if (input.limit !== undefined) metadata.page_limit = input.limit
  if (input.finalized_only !== undefined) metadata.finality = input.finalized_only ? 'finalized' : 'latest'
  if (input.normalized_output !== undefined) metadata.normalized_output = input.normalized_output
  if (input.notes?.length) metadata.notes = input.notes

  if (input.from_block !== undefined || input.to_block !== undefined || input.page_to_block !== undefined) {
    metadata.scan_window = {
      ...(input.range_kind ? { range_kind: input.range_kind } : {}),
      ...(input.from_block !== undefined ? { from_block: input.from_block } : {}),
      ...(input.to_block !== undefined ? { to_block: input.to_block } : {}),
      ...(input.page_to_block !== undefined ? { page_to_block: input.page_to_block } : {}),
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined
}
