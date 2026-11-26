import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { getBlockHead, resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import {
  buildBoundedSearchExecution,
  buildBoundedSearchNotice,
  scanBoundedBlockRange,
} from '../../helpers/bounded-search.js'
import { detectChainType } from '../../helpers/chain.js'
import { resolveKnownContractReference } from '../../helpers/entity-resolution.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStreamRange } from '../../helpers/fetch.js'
import { buildEvmTransactionFields } from '../../helpers/fields.js'
import { formatDuration, formatResult, formatTimestamp } from '../../helpers/format.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import { buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { estimateBlockTime, getTimestampWindowNotices, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { quoteUntrusted } from '../../helpers/untrusted-text.js'

const DEFAULT_RECENT_SEARCH_DEPTH_BLOCKS = 100_000
const DEFAULT_MAX_SCAN_BLOCKS = 1_000_000
const MAX_SCAN_BLOCKS = 1_000_000
const FILTERED_CREATE_TRACE_CHUNK_SIZE = 50_000

type DeploymentTrace = Record<string, unknown> & {
  block_number?: number
  timestamp?: number
  timestamp_human?: string
  transaction_hash?: string
  transaction_from?: string
  transaction_to?: string | null
  transaction_index?: number
  transaction_status?: number
  deployer?: string
  deployed_contract_address?: string
  gas_used?: string | number
  error?: string | null
}

function readNestedString(value: unknown, ...path: string[]): string | undefined {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : undefined
}

function readNestedNumber(value: unknown, ...path: string[]): number | undefined {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'number' ? current : undefined
}

function flattenCreateTraces(records: unknown[], targetAddress: string): DeploymentTrace[] {
  return records.flatMap((block: unknown) => {
    const typedBlock = block as {
      number?: number
      timestamp?: number
      header?: { number?: number; timestamp?: number }
      transactions?: Record<string, unknown>[]
      traces?: Record<string, unknown>[]
    }
    const blockNumber = typedBlock.number ?? typedBlock.header?.number
    const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp
    const transactionsByIndex = new Map<number, Record<string, unknown>>()
    for (const tx of typedBlock.transactions ?? []) {
      const index = typeof tx.transactionIndex === 'number' ? tx.transactionIndex : undefined
      if (index !== undefined) transactionsByIndex.set(index, tx)
    }

    const matches: DeploymentTrace[] = []
    for (const trace of typedBlock.traces ?? []) {
      const resultAddress =
        typeof trace.createResultAddress === 'string'
          ? trace.createResultAddress
          : readNestedString(trace, 'result', 'address')
      if (!resultAddress || resultAddress.toLowerCase() !== targetAddress) continue

      const transactionIndex =
        typeof trace.transactionIndex === 'number'
          ? trace.transactionIndex
          : readNestedNumber(trace, 'transactionIndex')
      const tx = transactionIndex !== undefined ? transactionsByIndex.get(transactionIndex) : undefined

      matches.push({
        block_number: blockNumber,
        timestamp,
        ...(timestamp !== undefined ? { timestamp_human: formatTimestamp(timestamp) } : {}),
        transaction_hash: typeof tx?.hash === 'string' ? tx.hash : undefined,
        transaction_from: typeof tx?.from === 'string' ? tx.from : undefined,
        transaction_to: typeof tx?.to === 'string' || tx?.to === null ? (tx.to as string | null) : undefined,
        transaction_index: transactionIndex,
        transaction_status: typeof tx?.status === 'number' ? tx.status : undefined,
        deployer: typeof trace.createFrom === 'string' ? trace.createFrom : readNestedString(trace, 'action', 'from'),
        deployed_contract_address: resultAddress.toLowerCase(),
        gas_used:
          typeof trace.createResultGasUsed === 'string' || typeof trace.createResultGasUsed === 'number'
            ? trace.createResultGasUsed
            : readNestedString(trace, 'result', 'gasUsed'),
        error: typeof trace.error === 'string' || trace.error === null ? trace.error : undefined,
      })
    }
    return matches
  })
}

function getBlockNumber(item: DeploymentTrace): number | undefined {
  return typeof item.block_number === 'number' ? item.block_number : undefined
}

export function registerContractDeploymentTool(server: McpServer) {
  registerPortalTool(
    server,
    'portal_evm_get_contract_deployment',
    buildToolDescription('portal_evm_get_contract_deployment'),
    {
      network: z.string().describe('EVM network name or alias, e.g. base, ethereum, arbitrum.'),
      contract_address: z
        .string()
        .optional()
        .describe('Contract address whose deployment transaction should be located.'),
      contract: z
        .string()
        .optional()
        .describe('Contract address or a supported well-known alias/name, e.g. "bayc" or "bored apes" on Ethereum.'),
      timeframe: z.string().optional().describe('Optional recent time window to search, e.g. "24h" or "7d".'),
      from_block: z
        .number()
        .optional()
        .describe('Optional starting block. Provide this for older contracts when the deployment is not recent.'),
      to_block: z.number().optional().describe('Optional ending block. Defaults to the indexed head.'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "7d ago".',
        ),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".',
        ),
      search_depth_blocks: z
        .number()
        .max(250000)
        .optional()
        .default(DEFAULT_RECENT_SEARCH_DEPTH_BLOCKS)
        .describe('When no explicit range is given, search this many recent blocks backward from the indexed head.'),
      max_scan_blocks: z
        .number()
        .max(MAX_SCAN_BLOCKS)
        .optional()
        .describe(
          'Safety cap for historical deployment scans. Default: scan the requested window up to 1,000,000 blocks.',
        ),
      scan_order: z
        .enum(['latest', 'earliest'])
        .optional()
        .default('latest')
        .describe(
          'Scan latest first for recent deployments, or earliest first when you provide a historical from_block.',
        ),
    },
    async ({
      network,
      contract_address,
      contract,
      timeframe,
      from_block,
      to_block,
      from_timestamp,
      to_timestamp,
      search_depth_blocks,
      max_scan_blocks,
      scan_order,
    }) => {
      const queryStartTime = Date.now()
      const dataset = await resolveDataset(network)
      const chainType = detectChainType(dataset)
      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_evm_get_contract_deployment',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: ['Use this only for EVM smart-contract datasets.'],
        })
      }

      if (
        (contract_address === undefined || contract_address.trim() === '') &&
        (contract === undefined || contract.trim() === '')
      ) {
        throw new ActionableError(
          'portal_evm_get_contract_deployment requires contract_address or contract.',
          [
            'Pass contract_address when you have a hex contract address.',
            'Pass contract for supported well-known aliases such as "bored apes" on Ethereum.',
          ],
          { network: dataset },
        )
      }

      if (contract_address !== undefined && contract !== undefined) {
        throw new ActionableError(
          'Use either contract_address or contract, not both.',
          ['Prefer contract_address for exact hex addresses; use contract only for supported aliases.'],
          { contract_address, contract },
        )
      }

      const contractReference = contract_address ?? contract ?? ''
      const resolvedContract = resolveKnownContractReference(dataset, contractReference)
      const normalizedContract = resolvedContract.address
      const hasExplicitWindow =
        timeframe !== undefined ||
        from_block !== undefined ||
        from_timestamp !== undefined ||
        to_timestamp !== undefined
      const head = await getBlockHead(dataset, false)
      const resolvedBlocks = hasExplicitWindow
        ? await resolveTimeframeOrBlocks({
            dataset,
            timeframe,
            from_block,
            to_block,
            from_timestamp,
            to_timestamp,
          })
        : {
            from_block: Math.max(0, head.number - search_depth_blocks + 1),
            to_block: head.number,
            range_kind: 'block_range' as const,
          }

      const { validatedToBlock: endBlock, head: validatedHead } = await validateBlockRange(
        dataset,
        resolvedBlocks.from_block,
        resolvedBlocks.to_block ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const transactionFields = buildEvmTransactionFields(false)
      delete transactionFields.input
      const portalUrl = `${PORTAL_URL}/datasets/${dataset}/stream`
      const query = {
        type: 'evm',
        fromBlock: resolvedBlocks.from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          transaction: transactionFields,
          trace: {
            transactionIndex: true,
            type: true,
            error: true,
            createFrom: true,
            createResultGasUsed: true,
            createResultAddress: true,
          },
        },
        traces: [{ type: ['create'], createResultAddress: [normalizedContract], transaction: true }],
      }

      const chunkSize = FILTERED_CREATE_TRACE_CHUNK_SIZE
      const requestedBlocks = endBlock - resolvedBlocks.from_block + 1
      const maxScanBlocks = Math.max(
        1,
        Math.min(max_scan_blocks ?? DEFAULT_MAX_SCAN_BLOCKS, MAX_SCAN_BLOCKS, requestedBlocks),
      )
      const scanResult = await scanBoundedBlockRange<DeploymentTrace>({
        fromBlock: resolvedBlocks.from_block,
        toBlock: endBlock,
        chunkSize,
        concurrency: 2,
        scanOrder: scan_order,
        maxScanBlocks,
        shouldContinue: (state) => state.items.length === 0,
        fetchChunk: async (chunkBounds) => {
          const records = await portalFetchStreamRange(portalUrl, {
            ...query,
            fromBlock: chunkBounds.fromBlock,
            toBlock: chunkBounds.toBlock,
          })
          const matches = flattenCreateTraces(records, normalizedContract)
          const chunkMatch = scan_order === 'earliest' ? matches[0] : matches.at(-1)
          return chunkMatch ? [chunkMatch] : []
        },
      })
      const deployment = scanResult.items[0]
      const scannedFromBlock = scanResult.scannedFromBlock
      const scannedToBlock = scanResult.scannedToBlock
      const scannedBlocks = scanResult.scannedBlocks
      const approxWindowSeconds = Math.round(scannedBlocks * estimateBlockTime(dataset, chainType))
      const approxSpan = approxWindowSeconds > 0 ? formatDuration(approxWindowSeconds) : undefined

      const items = deployment ? [deployment] : []
      const notices = [...getTimestampWindowNotices(resolvedBlocks)]
      if (resolvedContract.alias) {
        notices.push(
          `Resolved contract alias ${quoteUntrusted(resolvedContract.alias)} to ${normalizedContract} on ${dataset}.`,
        )
      }
      if (!hasExplicitWindow) {
        notices.push(
          `Searched the most recent ${search_depth_blocks.toLocaleString()} blocks${approxSpan ? ` (~${approxSpan} on ${dataset})` : ''}. For older contracts, pass from_block or from_timestamp near the deployment date.`,
        )
      }
      const scanHasMore = !deployment && scanResult.reachedMaxScanBlocks && scanResult.hasUnscannedBlocks
      if (scanHasMore) {
        notices.push(
          `Deployment search was capped at ${maxScanBlocks.toLocaleString()} scanned blocks (${scannedFromBlock}-${scannedToBlock}) to keep the MCP connection responsive.`,
        )
      }
      const boundedSearchNotice = buildBoundedSearchNotice(scanResult, 'Deployment search')
      if (boundedSearchNotice) notices.push(boundedSearchNotice)
      if (!deployment) {
        const directionHint =
          scan_order === 'earliest'
            ? 'Move from_block earlier if the deployment may predate this range, or expand to_block later if you intentionally started before deployment.'
            : 'Try expanding the window backward with an earlier from_block/from_timestamp if this is an old contract.'
        notices.push(
          `No deployment create trace for ${normalizedContract} was found in scanned blocks ${scannedFromBlock}-${scannedToBlock}. ${directionHint}`,
        )
      }

      const freshness = buildQueryFreshness({
        finality: 'latest',
        headBlockNumber: validatedHead.number,
        windowToBlock: endBlock,
        resolvedWindow: resolvedBlocks,
      })
      const coverage = buildQueryCoverage({
        windowFromBlock: resolvedBlocks.from_block,
        windowToBlock: endBlock,
        pageToBlock: scan_order === 'earliest' ? scannedToBlock : endBlock,
        items,
        hasMore: scanHasMore,
        getBlockNumber,
        /* The scan stops at maxScanBlocks, so the window it covered is often
           smaller than the window that was asked for. buildQueryCoverage
           defaults window_complete to true, which had this tool reporting a
           capped search as an analysis of the whole range. */
        windowComplete: !scanResult.hasUnscannedBlocks,
      })

      const execution = {
        ...buildExecutionMetadata({
          limit: 1,
          from_block: resolvedBlocks.from_block,
          to_block: endBlock,
          page_to_block: scan_order === 'earliest' ? scannedToBlock : scannedFromBlock,
          scan_order,
          range_kind: resolvedBlocks.range_kind,
          normalized_output: true,
          notes: [
            'Uses Portal create traces filtered by deployed contract address plus parent transaction context; no custom chain indexing is performed.',
            `Scanned ${scannedBlocks.toLocaleString()} blocks in ${FILTERED_CREATE_TRACE_CHUNK_SIZE.toLocaleString()}-block chunks.`,
          ],
        }),
        contract_reference: contractReference,
        ...buildBoundedSearchExecution(scanResult),
      }

      return formatResult(
        items,
        deployment
          ? `Found deployment for ${normalizedContract} in block ${deployment.block_number}; deployer ${deployment.deployer ?? 'unknown'}.`
          : `No deployment trace found for ${normalizedContract} in the scanned window.`,
        {
          toolName: 'portal_evm_get_contract_deployment',
          notices,
          freshness,
          coverage,
          execution,
          metadata: {
            network: dataset,
            dataset,
            from_block: resolvedBlocks.from_block,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
