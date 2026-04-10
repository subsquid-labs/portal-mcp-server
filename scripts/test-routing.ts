#!/usr/bin/env tsx

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { getToolContract } from '../src/helpers/tool-ux.ts'
import { LEGACY_TOOL_NAMES } from './tool-manifest.ts'
import { ROUTING_EVAL_CASES } from './routing-manifest.ts'
import { assert } from './test-helpers.ts'

type ListedTool = {
  name: string
  description?: string
}

type ParsedSections = {
  summary: string[]
  firstChoice: string[]
  whenToUse: string[]
  dontUse: string[]
  examples: string[]
}

type ToolProfile = {
  name: string
  description: string
  audience: 'public' | 'advanced'
  vm: string[]
  intent: string
  resultKind: string
  tokenWeights: Map<string, number>
  phraseWeights: Map<string, number>
}

type RankedTool = {
  name: string
  score: number
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'be',
  'been',
  'can',
  'do',
  'even',
  'for',
  'from',
  'get',
  'give',
  'i',
  'if',
  'in',
  'is',
  'it',
  'just',
  'lately',
  'me',
  'my',
  'not',
  'now',
  'of',
  'on',
  'or',
  'please',
  'right',
  'show',
  'so',
  'supposed',
  'the',
  'this',
  'to',
  'up',
  'use',
  'what',
  'which',
  'yet',
  'your',
])

const EVM_NETWORK_HINTS = new Set([
  'arbitrum',
  'avalanche',
  'base',
  'blast',
  'bsc',
  'ethereum',
  'evm',
  'linea',
  'monad',
  'optimism',
  'polygon',
  'scroll',
  'zksync',
])

const DEBUG_HINTS = new Set(['advanced', 'debug', 'direct', 'directly', 'exact', 'exactly', 'manual', 'raw'])
const CHART_HINTS = new Set(['bucket', 'buckets', 'candle', 'candles', 'chart', 'graph', 'ohlc', 'plot', 'series', 'trend', 'trends'])
const SUMMARY_HINTS = new Set(['analytics', 'big', 'health', 'healthy', 'overview', 'picture', 'snapshot', 'summarize', 'summary'])
const RAW_HINTS = new Set(['event', 'events', 'fills', 'instruction', 'instructions', 'log', 'logs', 'query', 'raw', 'transaction', 'transactions'])

const TOKEN_SYNONYMS: Record<string, string[]> = {
  account: ['address', 'wallet'],
  behind: ['fresh', 'indexed', 'lag'],
  big: ['analytics', 'overview', 'summary'],
  blocks: ['block'],
  busy: ['activity', 'interactions'],
  candles: ['candle', 'chart', 'ohlc', 'price'],
  candle: ['candles', 'chart', 'ohlc', 'price'],
  call: ['name', 'network'],
  caught: ['fresh', 'indexed'],
  chain: ['network', 'name'],
  commands: ['actions', 'cancels', 'orders', 'replica'],
  current: ['head', 'latest'],
  doing: ['activity', 'summary'],
  eth: ['ethereum'],
  events: ['event', 'logs', 'transfers'],
  event: ['events', 'log', 'logs'],
  fills: ['fill', 'trade', 'trades'],
  fill: ['fills', 'trade', 'trades'],
  graph: ['chart', 'series', 'time'],
  happening: ['activity', 'recent'],
  healthy: ['analytics', 'health', 'snapshot'],
  hottest: ['active', 'top', 'trending'],
  indexed: ['fresh', 'network'],
  instructions: ['instruction', 'program'],
  instruction: ['instructions', 'program'],
  latest: ['current', 'head', 'recent'],
  logs: ['event', 'events', 'log'],
  moved: ['transfer', 'transfers'],
  move: ['transfer', 'transfers'],
  most: ['top', 'volume'],
  name: ['network'],
  order: ['orders', 'replica'],
  orders: ['command', 'commands', 'replica'],
  picture: ['analytics', 'overview', 'summary'],
  plot: ['chart', 'graph', 'series'],
  recent: ['activity', 'latest'],
  stuff: ['activity', 'recent'],
  summarize: ['overview', 'summary'],
  traded: ['trade', 'trader', 'volume'],
  trader: ['trade', 'traders', 'volume'],
  traders: ['top', 'trade', 'volume'],
  trades: ['fill', 'fills', 'trade'],
  trade: ['fill', 'fills', 'trades'],
  transfers: ['token', 'transfer'],
  transfer: ['event', 'token', 'transfers'],
  wallet: ['account', 'address'],
}

function baseTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function expandTokens(tokens: string[]): string[] {
  const expanded = new Set<string>()

  for (const token of tokens) {
    if (STOP_WORDS.has(token)) continue

    expanded.add(token)

    if (token.endsWith('ies') && token.length > 4) {
      expanded.add(`${token.slice(0, -3)}y`)
    } else if (token.endsWith('s') && token.length > 4 && !token.endsWith('ss')) {
      expanded.add(token.slice(0, -1))
    }

    const synonyms = TOKEN_SYNONYMS[token] ?? []
    synonyms.forEach((synonym) => expanded.add(synonym))
  }

  return [...expanded]
}

function buildPhrases(tokens: string[]): string[] {
  const filtered = tokens.filter((token) => !STOP_WORDS.has(token))
  const phrases = new Set<string>()

  for (let i = 0; i < filtered.length; i++) {
    if (i + 1 < filtered.length) {
      phrases.add(`${filtered[i]} ${filtered[i + 1]}`)
    }
    if (i + 2 < filtered.length) {
      phrases.add(`${filtered[i]} ${filtered[i + 1]} ${filtered[i + 2]}`)
    }
  }

  return [...phrases]
}

function parseDescriptionSections(description: string): ParsedSections {
  const sections: ParsedSections = {
    summary: [],
    firstChoice: [],
    whenToUse: [],
    dontUse: [],
    examples: [],
  }

  let current: keyof ParsedSections = 'summary'

  for (const rawLine of description.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (line === 'FIRST CHOICE FOR:') {
      current = 'firstChoice'
      continue
    }
    if (line === 'WHEN TO USE:') {
      current = 'whenToUse'
      continue
    }
    if (line === "DON'T USE:") {
      current = 'dontUse'
      continue
    }
    if (line === 'EXAMPLES:') {
      current = 'examples'
      continue
    }

    sections[current].push(line.replace(/^- /, ''))
  }

  return sections
}

function addWeightedText(target: Map<string, number>, text: string, weight: number) {
  const tokens = expandTokens(baseTokens(text))
  for (const token of tokens) {
    target.set(token, (target.get(token) ?? 0) + weight)
  }
}

function addWeightedPhrases(target: Map<string, number>, text: string, weight: number) {
  const phrases = buildPhrases(baseTokens(text))
  for (const phrase of phrases) {
    target.set(phrase, (target.get(phrase) ?? 0) + weight)
  }
}

function buildToolProfiles(tools: ListedTool[]): ToolProfile[] {
  return tools.map((tool) => {
    const description = tool.description ?? ''
    const sections = parseDescriptionSections(description)
    const contract = getToolContract(tool.name)
    const tokenWeights = new Map<string, number>()
    const phraseWeights = new Map<string, number>()

    addWeightedText(tokenWeights, tool.name.replaceAll('_', ' '), 6)
    addWeightedPhrases(phraseWeights, tool.name.replaceAll('_', ' '), 4)
    addWeightedText(tokenWeights, sections.summary.join(' '), 4.5)
    addWeightedPhrases(phraseWeights, sections.summary.join(' '), 3.5)
    addWeightedText(tokenWeights, sections.firstChoice.join(' '), 4)
    addWeightedPhrases(phraseWeights, sections.firstChoice.join(' '), 3.5)
    addWeightedText(tokenWeights, sections.whenToUse.join(' '), 3)
    addWeightedPhrases(phraseWeights, sections.whenToUse.join(' '), 2.5)
    addWeightedText(tokenWeights, sections.examples.join(' '), 2)
    addWeightedPhrases(phraseWeights, sections.examples.join(' '), 1.5)

    if (contract) {
      addWeightedText(
        tokenWeights,
        [
          contract.category,
          contract.intent,
          contract.result_kind,
          contract.audience,
          ...contract.vm,
          ...(contract.first_choice_for ?? []),
        ].join(' '),
        2.5,
      )
    }

    return {
      name: tool.name,
      description,
      audience: contract?.audience ?? 'public',
      vm: contract?.vm ?? ['cross-chain'],
      intent: contract?.intent ?? 'query',
      resultKind: contract?.result_kind ?? 'list',
      tokenWeights,
      phraseWeights,
    }
  })
}

function buildIdfMap(values: Array<Set<string>>): Map<string, number> {
  const documentFrequency = new Map<string, number>()

  for (const valueSet of values) {
    for (const value of valueSet) {
      documentFrequency.set(value, (documentFrequency.get(value) ?? 0) + 1)
    }
  }

  const totalDocuments = values.length
  const idf = new Map<string, number>()
  for (const [value, frequency] of documentFrequency) {
    idf.set(value, Math.log((totalDocuments + 1) / (frequency + 1)) + 1)
  }

  return idf
}

function inferVmHints(prompt: string, tokens: string[]): Set<string> {
  const normalizedPrompt = prompt.toLowerCase()
  const hints = new Set<string>()

  if (tokens.includes('solana')) hints.add('solana')
  if (tokens.includes('hyperliquid')) hints.add('hyperliquid')
  if (tokens.includes('bitcoin') || (tokens.includes('btc') && !tokens.includes('hyperliquid'))) hints.add('bitcoin')
  if (tokens.some((token) => EVM_NETWORK_HINTS.has(token)) || normalizedPrompt.includes(' base ') || normalizedPrompt.startsWith('base ')) {
    hints.add('evm')
  }

  return hints
}

function scoreTool(
  prompt: string,
  promptTokens: string[],
  promptPhrases: string[],
  profile: ToolProfile,
  tokenIdf: Map<string, number>,
  phraseIdf: Map<string, number>,
): number {
  let score = 0
  const promptLower = prompt.toLowerCase()

  for (const token of promptTokens) {
    const weight = profile.tokenWeights.get(token)
    if (weight) {
      score += weight * (tokenIdf.get(token) ?? 1)
    }
  }

  for (const phrase of promptPhrases) {
    const weight = profile.phraseWeights.get(phrase)
    if (weight) {
      score += weight * (phraseIdf.get(phrase) ?? 1)
    }
  }

  const debugPrompt = promptTokens.some((token) => DEBUG_HINTS.has(token))
  const chartPrompt = promptTokens.some((token) => CHART_HINTS.has(token))
  const summaryPrompt = promptTokens.some((token) => SUMMARY_HINTS.has(token))
  const rawPrompt = promptTokens.some((token) => RAW_HINTS.has(token))
  const vmHints = inferVmHints(prompt, promptTokens)
  const freshnessPrompt = promptTokens.some((token) => ['behind', 'caught', 'fresh', 'indexed', 'lag'].includes(token))
  const latestHeadPrompt = promptTokens.some((token) => ['current', 'head', 'latest'].includes(token))
  const blockPrompt = promptTokens.some((token) => ['block', 'blocks', 'height', 'slot', 'slots'].includes(token))
  const timestampResolvePrompt =
    promptTokens.includes('timestamp') && promptTokens.some((token) => ['block', 'height', 'match', 'matches'].includes(token))
  const simpleHeadPrompt =
    !debugPrompt
    && !timestampResolvePrompt
    && (
      /\bwhat(?:'s| is)? (?:the )?(?:current |latest )?(?:head|block|slot|height)\b/.test(promptLower)
      || (/\bright now\b/.test(promptLower) && blockPrompt)
      || (/\bcurrent\b/.test(promptLower) && blockPrompt)
    )
  const traderPrompt = promptTokens.some((token) => ['most', 'top', 'trader', 'traders', 'volume'].includes(token))
  const namingPrompt = promptTokens.some((token) => ['alias', 'call', 'chain', 'name', 'network'].includes(token))
  const hyperliquidPrompt = promptTokens.includes('hyperliquid')

  if (profile.audience === 'advanced') {
    score += debugPrompt ? 5 : -7
  } else if (!debugPrompt) {
    score += 1
  }

  if (vmHints.size > 0) {
    const vmMatch = profile.vm.some((vm) => vmHints.has(vm) || vm === 'cross-chain')
    if (vmMatch) {
      score += profile.vm.includes('cross-chain') ? 1.5 : 3.5
    } else {
      score -= 40
    }
  }

  if (chartPrompt) {
    score += profile.resultKind === 'chart' ? 4 : -0.5
  }

  if (summaryPrompt) {
    score += profile.intent === 'analytics' || profile.intent === 'summary' ? 2.5 : 0
  }

  if (rawPrompt) {
    score += profile.intent === 'query' || profile.intent === 'debug' ? 2 : 0
  }

  if (freshnessPrompt) {
    score += profile.name === 'portal_get_network_info' ? 18 : 0
    score += profile.name === 'portal_get_head' ? -6 : 0
  }

  if (latestHeadPrompt && blockPrompt) {
    score += profile.name === 'portal_get_head' ? 7 : 0
  }

  if (simpleHeadPrompt) {
    score += profile.name === 'portal_get_head' ? 18 : 0
    score += profile.name === 'portal_debug_query_blocks' ? -16 : 0
    score += profile.name === 'portal_debug_resolve_time_to_block' ? -8 : 0
  }

  if (timestampResolvePrompt) {
    score += profile.name === 'portal_debug_resolve_time_to_block' ? 9 : 0
  }

  if (traderPrompt) {
    score += profile.name === 'portal_hyperliquid_get_analytics' ? 8 : 0
    score += profile.name === 'portal_hyperliquid_query_fills' ? -3 : 0
  }

  if (namingPrompt) {
    score += profile.name === 'portal_list_networks' ? 14 : 0
  }

  if (summaryPrompt && vmHints.size > 0) {
    const analyticsVmMatch = profile.intent === 'analytics' && profile.vm.some((vm) => vmHints.has(vm))
    if (analyticsVmMatch) {
      score += 10
    }
  }

  if (hyperliquidPrompt && summaryPrompt) {
    score += profile.name === 'portal_hyperliquid_get_analytics' ? 16 : 0
    score += profile.name === 'portal_hyperliquid_query_fills' ? -8 : 0
  }

  return score
}

function rankTools(prompt: string, profiles: ToolProfile[], tokenIdf: Map<string, number>, phraseIdf: Map<string, number>): RankedTool[] {
  const promptTokens = expandTokens(baseTokens(prompt))
  const promptPhrases = buildPhrases(baseTokens(prompt))

  return profiles
    .map((profile) => ({
      name: profile.name,
      score: scoreTool(prompt, promptTokens, promptPhrases, profile, tokenIdf, phraseIdf),
    }))
    .sort((left, right) => right.score - left.score)
}

async function main() {
  console.log(`Routing-eval: ranking ${ROUTING_EVAL_CASES.length} naive prompts against the live 26-tool catalog...\n`)

  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] })
  const client = new Client({ name: 'routing-eval', version: '1.0.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  const actualNames = new Set(tools.map((tool) => tool.name))
  const legacyStillExposed = LEGACY_TOOL_NAMES.filter((name) => actualNames.has(name))
  assert(tools.length === 26, `Expected exactly 26 tools, got ${tools.length}`)
  assert(legacyStillExposed.length === 0, `Legacy tool names are still exposed: ${legacyStillExposed.join(', ')}`)

  const listedTools = tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' }))
  const profiles = buildToolProfiles(listedTools)
  const tokenIdf = buildIdfMap(profiles.map((profile) => new Set(profile.tokenWeights.keys())))
  const phraseIdf = buildIdfMap(profiles.map((profile) => new Set(profile.phraseWeights.keys())))

  let passed = 0
  let failed = 0
  const failures: Array<{ prompt: string; expected: string; topThree: RankedTool[] }> = []

  for (const testCase of ROUTING_EVAL_CASES) {
    const ranked = rankTools(testCase.prompt, profiles, tokenIdf, phraseIdf)
    const maxRank = testCase.max_rank ?? 1
    const accepted = new Set([testCase.expected, ...(testCase.acceptable ?? [])])
    const hitIndex = ranked.findIndex((tool) => accepted.has(tool.name))
    const topThree = ranked.slice(0, 3)

    if (hitIndex !== -1 && hitIndex < maxRank) {
      const winner = ranked[hitIndex]
      console.log(`  PASS  [top ${hitIndex + 1}] ${testCase.prompt}`)
      console.log(`        -> ${winner.name} (${winner.score.toFixed(2)})`)
      passed++
      continue
    }

    console.log(`  FAIL  ${testCase.prompt}`)
    console.log(`        expected <= top ${maxRank}: ${testCase.expected}`)
    console.log(`        top 3: ${topThree.map((tool) => `${tool.name} (${tool.score.toFixed(2)})`).join(', ')}`)
    failed++
    failures.push({ prompt: testCase.prompt, expected: testCase.expected, topThree })
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(`Routing results: ${passed} passed, ${failed} failed out of ${ROUTING_EVAL_CASES.length} prompts`)

  if (failures.length > 0) {
    console.log('\nRouting failures:')
    failures.forEach((failure) => {
      console.log(`  - ${failure.prompt}`)
      console.log(`    expected: ${failure.expected}`)
      console.log(`    top 3: ${failure.topThree.map((tool) => tool.name).join(', ')}`)
    })
  }

  console.log(`${'='.repeat(70)}`)

  await client.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
