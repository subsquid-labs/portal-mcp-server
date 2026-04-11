#!/usr/bin/env tsx

/**
 * Quick prompt taxonomy helper for observability JSONL exports.
 * Usage: tsx scripts/prompt-taxonomy.ts <path-to-jsonl>
 */
import { readFileSync } from 'node:fs'

type Bucket = {
  name: string
  patterns: RegExp[]
}

const BUCKETS: Bucket[] = [
  { name: 'wallet_investigation', patterns: [/wallet/i, /address/i, /balances?/i, /counterpart/i, /holdings?/i] },
  { name: 'time_series', patterns: [/time\s*series/i, /chart/i, /trend/i, /bucket/i, /compare/i] },
  { name: 'contract_activity', patterns: [/contract/i, /top contracts?/i, /activity/i] },
  { name: 'token_transfers', patterns: [/token/i, /transfer/i, /erc20/i, /usdc/i, /stablecoin/i] },
  { name: 'nft_activity', patterns: [/nft/i, /erc721/i, /erc1155/i, /mint/i] },
  { name: 'dex_perps', patterns: [/swap/i, /dex/i, /ohlc/i, /price/i, /perp/i, /hyperliquid/i] },
  { name: 'network_health', patterns: [/head/i, /latest block/i, /caught up/i, /network/i] },
  { name: 'raw_query', patterns: [/query/i, /logs?/i, /transactions?/i, /traces?/i] },
]

function classify(query: string) {
  const matches = BUCKETS.filter((bucket) => bucket.patterns.some((pattern) => pattern.test(query)))
  if (!matches.length) return 'other'
  return matches[0].name
}

function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('Usage: tsx scripts/prompt-taxonomy.ts <jsonl-path>')
    process.exit(1)
  }

  const input = readFileSync(path, 'utf-8')
  const lines = input.split('\n').filter(Boolean)
  const counts = new Map<string, number>()
  let total = 0

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      const query = parsed?.user_query
      if (typeof query !== 'string' || !query.trim()) continue
      total += 1
      const bucket = classify(query)
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    } catch {
      continue
    }
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  console.log(`Total queries analyzed: ${total}`)
  sorted.forEach(([bucket, count]) => {
    console.log(`${bucket}: ${count}`)
  })
}

main()
