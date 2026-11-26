import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { detectChainType } from '../../helpers/chain.js'
import {
  buildTokenListLookupNotices,
  resolveContractQuery,
  resolveHyperliquidCoinQuery,
  resolvePoolQuery,
  resolveProtocolQuery,
  resolveTokenQueryFromList,
} from '../../helpers/entity-resolution.js'
import { ActionableError } from '../../helpers/errors.js'
import { formatResult } from '../../helpers/format.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import { buildPaginationInfo } from '../../helpers/pagination.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { quoteUntrusted } from '../../helpers/untrusted-text.js'

export function registerResolveEntityTool(server: McpServer) {
  registerPortalTool(
    server,
    'portal_resolve_entity',
    buildToolDescription('portal_resolve_entity'),
    {
      network: z
        .string()
        .optional()
        .describe(
          'Network name or alias when the entity is network-scoped, e.g. "base", "ethereum", "arbitrum-one", or "hyperliquid-fills".',
        ),
      kind: z
        .enum(['token', 'contract', 'pool', 'protocol', 'hyperliquid_coin'])
        .optional()
        .default('token')
        .describe(
          'Entity kind to resolve: token, contract alias/address, pool identifier, protocol name, or Hyperliquid coin/ticker.',
        ),
      query: z.string().describe('Entity string to resolve, e.g. "USDC", "bayc", "uniswap", "BTC", or "0x...".'),
      limit: z.number().min(1).max(50).optional().default(10).describe('Maximum matches to return.'),
    },
    async ({ network, kind, query, limit }) => {
      const queryStartTime = Date.now()
      const effectiveKind = kind ?? 'token'
      const notices: string[] = []

      if ((effectiveKind === 'token' || effectiveKind === 'contract' || effectiveKind === 'pool') && !network) {
        throw new ActionableError(`${effectiveKind} resolution requires network.`, [
          'Pass network for chain-scoped entities, for example "base-mainnet" or "ethereum-mainnet".',
          'Use kind="protocol" when resolving a cross-chain protocol name.',
          'Use kind="hyperliquid_coin" for Hyperliquid tickers.',
        ])
      }

      let result:
        | Awaited<ReturnType<typeof resolveTokenQueryFromList>>
        | Awaited<ReturnType<typeof resolveContractQuery>>
        | Awaited<ReturnType<typeof resolvePoolQuery>>
        | Awaited<ReturnType<typeof resolveProtocolQuery>>
        | ReturnType<typeof resolveHyperliquidCoinQuery>

      if (effectiveKind === 'token') {
        result = await resolveTokenQueryFromList({ network: network!, query, limit })
        notices.push(...buildTokenListLookupNotices(result.lookup))
      } else if (effectiveKind === 'contract') {
        result = await resolveContractQuery({ network: network!, query, limit })
      } else if (effectiveKind === 'pool') {
        result = await resolvePoolQuery({ network: network!, query, limit })
      } else if (effectiveKind === 'protocol') {
        result = await resolveProtocolQuery({ query, limit })
      } else {
        result = resolveHyperliquidCoinQuery({ query, limit })
      }

      const matches = result.matches
      // Every resolver ranks its candidates and then cuts the list to `limit`.
      // Reporting only the returned rows as `match_count`, under the default
      // coverage that declares a result complete, told the caller that the
      // list it received was the whole list.
      const totalMatches = result.total_matches
      const truncated = totalMatches > matches.length
      // Pool resolution bounds its own candidate search, so its total counts
      // what was searched rather than what exists.
      const searchComplete = 'search_complete' in result ? result.search_complete : true
      const tokenAddresses =
        effectiveKind === 'token' ? matches.flatMap((match) => ('address' in match ? [match.address] : [])) : []
      const contractAddresses =
        effectiveKind === 'contract' ? matches.flatMap((match) => ('address' in match ? [match.address] : [])) : []
      const poolIdentifiers =
        effectiveKind === 'pool' ? matches.flatMap((match) => ('identifier' in match ? [match.identifier] : [])) : []
      const firstPoolMatch =
        effectiveKind === 'pool' && matches[0] && 'identifier' in matches[0] ? matches[0] : undefined
      const poolTokens =
        firstPoolMatch?.base_token && firstPoolMatch?.quote_token
          ? [firstPoolMatch.base_token, firstPoolMatch.quote_token].sort((left, right) =>
              left.address.toLowerCase().localeCompare(right.address.toLowerCase()),
            )
          : []
      const inferredPoolSource =
        firstPoolMatch?.dex_id === 'uniswap' && firstPoolMatch.labels?.some((label) => label.toLowerCase() === 'v3')
          ? 'uniswap_v3_swap'
          : firstPoolMatch?.dex_id === 'uniswap' && firstPoolMatch.labels?.some((label) => label.toLowerCase() === 'v2')
            ? 'uniswap_v2_swap'
            : undefined
      const hyperliquidCoins =
        effectiveKind === 'hyperliquid_coin' ? matches.flatMap((match) => ('coin' in match ? [match.coin] : [])) : []
      const protocolSlugs =
        effectiveKind === 'protocol' ? matches.flatMap((match) => ('slug' in match ? [match.slug] : [])) : []

      const resolvedNetwork = 'dataset' in result ? result.dataset : undefined
      const resolvedChainType = resolvedNetwork ? detectChainType(resolvedNetwork) : undefined
      const isEnsName = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(result.query.trim())

      const suggestedArguments =
        matches.length > 0
          ? effectiveKind === 'token'
            ? resolvedChainType === 'solana'
              ? {
                  mint_addresses: tokenAddresses,
                  mentions_account: tokenAddresses,
                  note: 'Use these SPL mint addresses with portal_solana_query_transactions or portal_solana_query_instructions.',
                }
              : resolvedChainType === 'tron'
                ? {
                    contract_addresses: tokenAddresses,
                    addresses: tokenAddresses,
                    note: 'Use these TRC-20 contract addresses with portal_tron_query_logs or portal_tron_query_transactions.',
                  }
                : {
                    token_addresses: tokenAddresses,
                    token_symbols: [result.query],
                    note: 'Use token_addresses when you need a deterministic contract filter; token_symbols can be used by supported EVM token/log tools.',
                  }
            : effectiveKind === 'contract'
              ? {
                  contract_address: contractAddresses[0],
                  addresses: contractAddresses,
                  note: 'Use the address fields for deterministic EVM contract filters.',
                }
              : effectiveKind === 'pool'
                ? {
                    pool_address: poolIdentifiers.find((value) => value.length === 42),
                    pool_id: poolIdentifiers.find((value) => value.length === 66),
                    ...(poolTokens[0]
                      ? {
                          token0_address: poolTokens[0].address,
                          token0_symbol: poolTokens[0].symbol,
                        }
                      : {}),
                    ...(poolTokens[1]
                      ? {
                          token1_address: poolTokens[1].address,
                          token1_symbol: poolTokens[1].symbol,
                        }
                      : {}),
                    ...(inferredPoolSource ? { source: inferredPoolSource } : {}),
                    note:
                      firstPoolMatch?.validation_status === 'external_indexer_match'
                        ? 'Use these pool and token arguments on portal_evm_get_ohlc. Token decimals are resolved from open token-list metadata.'
                        : 'This identifier passed format validation only. Use the matching pool_address or pool_id field on pool-aware tools.',
                  }
                : effectiveKind === 'hyperliquid_coin'
                  ? {
                      coin: hyperliquidCoins,
                      note: 'Use coin filters on Hyperliquid fill, analytics, or OHLC tools.',
                    }
                  : {
                      protocol_slugs: protocolSlugs,
                      note: 'Use the slug to continue with protocol-aware research or external protocol metadata.',
                    }
          : undefined

      if (matches.length === 0) {
        if (isEnsName) {
          notices.push(
            `${quoteUntrusted(result.query)} looks like an ENS name. SQD Portal indexes raw on-chain records without off-chain ENS forward resolution; pass the resolved 0x address directly to wallet or query tools.`,
          )
        } else {
          notices.push(
            effectiveKind === 'token'
              ? 'No token-list match found. Check the network, use the exact token contract address, or try a canonical symbol.'
              : effectiveKind === 'contract'
                ? 'No built-in contract alias match found. Pass the exact contract address for deterministic EVM queries.'
                : effectiveKind === 'pool'
                  ? 'No pool match found. Use a pair such as "WETH/USDC uniswap", or pass a 20-byte EVM pool address or 32-byte pool id.'
                  : effectiveKind === 'hyperliquid_coin'
                    ? 'No Hyperliquid coin candidate could be normalized from the query.'
                    : 'No protocol match found from DeFi Llama protocol metadata.',
          )
        }
      }
      if (truncated) {
        notices.push(
          `Showing the ${matches.length} best of ${totalMatches} ${effectiveKind} matches. Raise limit (max 50) or narrow the query to see the rest.`,
        )
      }
      if (!searchComplete) {
        notices.push(
          'The pool search was bounded and did not cover every token variant, so this is not a complete list of matching pools. Pass the pool address or pool id for a deterministic answer.',
        )
      }
      if (matches.length > 1) {
        notices.push(
          effectiveKind === 'token'
            ? 'Multiple token-list matches were found. Use token_addresses for deterministic queries when bridged variants matter.'
            : `Multiple ${effectiveKind} matches were found. Pick one explicit identifier before issuing a chain query.`,
        )
      }
      if (effectiveKind === 'pool' && matches.length > 0) {
        if (firstPoolMatch?.validation_status === 'external_indexer_match') {
          notices.push(
            'Pool address and token-pair metadata were matched through DEX Screener. Query tools still read blockchain rows from SQD Portal.',
          )
        } else {
          notices.push('Pool resolution validated identifier shape only; it did not prove the pool exists on-chain.')
        }
      }
      if (effectiveKind === 'hyperliquid_coin' && matches.length > 0) {
        notices.push(
          'Hyperliquid coin resolution normalizes ticker/name input but does not validate current market listing.',
        )
      }

      return formatResult(
        {
          kind: effectiveKind,
          query: result.query,
          ...('dataset' in result ? { network: result.dataset } : {}),
          match_count: matches.length,
          ...(truncated ? { total_match_count: totalMatches } : {}),
          source: result.source,
          matches,
          ...('lookup' in result ? { token_list_lookup: result.lookup } : {}),
          ...(suggestedArguments ? { suggested_arguments: suggestedArguments } : {}),
        },
        truncated
          ? `Resolved ${quoteUntrusted(result.query)} to ${totalMatches} ${effectiveKind} matches, showing the best ${matches.length}`
          : !searchComplete
            ? `Resolved ${quoteUntrusted(result.query)} to ${matches.length} ${effectiveKind} matches from a bounded search`
            : matches.length === 1
              ? `Resolved ${quoteUntrusted(result.query)} to 1 ${effectiveKind} match`
              : `Resolved ${quoteUntrusted(result.query)} to ${matches.length} ${effectiveKind} matches`,
        {
          toolName: 'portal_resolve_entity',
          notices,
          coverage: {
            kind: 'entity_resolution',
            result_complete: !truncated && searchComplete,
            // `continuation` belongs on every incomplete result, not only a
            // truncated one: without it the formatter falls back to telling
            // the caller to continue with a cursor this tool never issues.
            ...(truncated || !searchComplete ? { continuation: 'none' } : {}),
            ...(truncated ? { returned: matches.length, matching: totalMatches } : {}),
            ...(searchComplete ? {} : { candidate_search: 'bounded' }),
          },
          // The shared shape, so a truncated ranked list reads like every
          // other incomplete page: no cursor and has_more false, with the
          // coverage block saying the result is incomplete and has no
          // continuation to give.
          pagination: buildPaginationInfo(limit, matches.length),
          execution: buildExecutionMetadata({
            limit,
            normalized_output: true,
            notes: [
              effectiveKind === 'token'
                ? 'Token addresses and metadata come from open token-list data, not hardcoded constants.'
                : undefined,
              effectiveKind === 'protocol'
                ? 'Protocol matches come from DeFi Llama metadata and are not Portal chain records.'
                : undefined,
              effectiveKind === 'pool' && firstPoolMatch?.validation_status === 'external_indexer_match'
                ? 'Pool address and pair metadata come from DEX Screener; blockchain query rows still come from SQD Portal.'
                : undefined,
              effectiveKind === 'hyperliquid_coin'
                ? 'Hyperliquid coin names are normalized for Portal filters; listing validation is left to the query tool.'
                : undefined,
            ].filter((note): note is string => Boolean(note)),
          }),
          metadata: {
            ...('dataset' in result ? { network: result.dataset, dataset: result.dataset } : {}),
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
