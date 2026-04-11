import { humanizeLabel } from './format.js'

export interface PipesRecipe {
  version: 'pipes_recipe_v1'
  title: string
  summary: string
  goal: string
  entities: string[]
  filters: Record<string, unknown>
  outputs: string[]
  validation_hints: string[]
  recommended_skills: string[]
  starter_prompt: string
  client_limitations: string
}

function omitUndefined(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

export function buildTimeSeriesPipesRecipe(params: {
  network: string
  metric: string
  interval: string
  duration: string
  address?: string
  compare_previous?: boolean
  group_by?: string
}) : PipesRecipe {
  const networkLabel = humanizeLabel(params.network) ?? params.network
  const metricLabel = humanizeLabel(params.metric) ?? params.metric

  return {
    version: 'pipes_recipe_v1',
    title: `Need more data? Build a custom ${metricLabel.toLowerCase()} pipeline`,
    summary: `Use Pipes when you need a longer lookback, protocol-specific joins, or a derived ${metricLabel.toLowerCase()} view that goes beyond the built-in Portal chart.`,
    goal: `Create a custom ${metricLabel.toLowerCase()} time-series indexer for ${networkLabel}${params.address ? ` filtered to ${params.address}` : ''}.`,
    entities: params.group_by === 'contract'
      ? ['blocks', 'transactions', 'contracts', 'derived bucket metrics']
      : ['blocks', 'transactions', 'derived bucket metrics'],
    filters: omitUndefined({
      network: params.network,
      metric: params.metric,
      interval: params.interval,
      duration: params.duration,
      address: params.address,
      compare_previous: params.compare_previous,
      group_by: params.group_by && params.group_by !== 'none' ? params.group_by : undefined,
    }),
    outputs: [
      `${metricLabel} buckets by ${params.interval}`,
      ...(params.compare_previous ? ['current-vs-previous comparison buckets'] : []),
      ...(params.group_by === 'contract' ? ['top grouped entities with ranked trend lines'] : []),
      'chart-ready output plus a compact summary table',
    ],
    validation_hints: [
      'Compare the first custom chart against portal_get_time_series for the same network and window.',
      'Start with a small backfill like 24h before widening the range.',
      'Keep one stable bucket schema so the chart and summary table stay in sync.',
    ],
    recommended_skills: ['pipes-new-indexer', 'portal-query'],
    starter_prompt: `Build a Pipes-based ${metricLabel.toLowerCase()} time-series workflow for ${networkLabel}. Reuse the current Portal query as the validation baseline, keep ${params.interval} buckets, and produce both chart-ready rows and a summary table.`,
    client_limitations: 'Chat clients usually cannot create the full indexer for you inline, so treat this as a handoff recipe for Codex, Claude Code, or another terminal agent with the Pipes SDK.',
  }
}

export function buildWalletPipesRecipe(params: {
  network: string
  address: string
  timeframe: string
  mode: 'fast' | 'deep'
  include_tokens?: boolean
  include_nfts?: boolean
}) : PipesRecipe {
  const networkLabel = humanizeLabel(params.network) ?? params.network

  return {
    version: 'pipes_recipe_v1',
    title: 'Need more data? Build a custom wallet investigation pipeline',
    summary: 'Use Pipes when you want protocol-specific wallet attribution, longer history, or custom joins across transfers, swaps, positions, and derived balances.',
    goal: `Create a custom wallet investigation workflow for ${params.address} on ${networkLabel}.`,
    entities: [
      'transactions',
      ...(params.include_tokens ? ['token transfers'] : []),
      ...(params.include_nfts ? ['NFT transfers'] : []),
      'counterparties',
      'derived wallet summary tables',
    ],
    filters: omitUndefined({
      network: params.network,
      address: params.address,
      timeframe: params.timeframe,
      mode: params.mode,
      include_tokens: params.include_tokens,
      include_nfts: params.include_nfts,
    }),
    outputs: [
      'wallet activity timeline',
      'counterparty rollups',
      'asset movement summary',
      'protocol-specific enrichment tables',
    ],
    validation_hints: [
      'Compare the first custom summary against portal_get_wallet_summary for the same wallet and timeframe.',
      'Start with the current wallet window before attempting a full historical rebuild.',
      'Keep one normalized activity table so app and summary views can share the same base data.',
    ],
    recommended_skills: ['pipes-new-indexer', 'portal-query'],
    starter_prompt: `Build a Pipes-based wallet investigation workflow for ${params.address} on ${networkLabel}. Keep a normalized activity table, add counterparty and asset summaries, and validate the first output against portal_get_wallet_summary.`,
    client_limitations: 'Chat clients usually cannot scaffold and run the full Pipes project inline, so this recipe is designed for a terminal agent or local development handoff.',
  }
}
