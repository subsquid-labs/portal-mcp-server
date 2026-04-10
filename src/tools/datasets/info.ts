import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, getChainType, getDatasets, isL2Chain, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetch, portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatDuration, formatTimestamp } from '../../helpers/formatting.js'
import { buildToolDescription } from '../../helpers/tool-ux.js'
import type { BlockHead, DatasetMetadata } from '../../types/index.js'

async function fetchHeadTimestamp(dataset: string, chainType: string, blockNumber: number): Promise<number | undefined> {
  const baseQuery = {
    fromBlock: blockNumber,
    toBlock: blockNumber,
    fields: {
      block: {
        number: true,
        timestamp: true,
      },
    },
  }

  const query =
    chainType === 'solana'
      ? {
          type: 'solana',
          includeAllBlocks: true,
          ...baseQuery,
        }
      : chainType === 'bitcoin'
        ? {
            type: 'bitcoin',
            includeAllBlocks: true,
            ...baseQuery,
          }
        : chainType === 'hyperliquidFills'
          ? {
              type: 'hyperliquidFills',
              ...baseQuery,
              fields: {
                ...baseQuery.fields,
                fill: { time: true },
              },
              fills: [{}],
            }
          : chainType === 'hyperliquidReplicaCmds'
            ? {
                type: 'hyperliquidReplicaCmds',
                ...baseQuery,
                fields: {
                  ...baseQuery.fields,
                  action: { actionIndex: true },
                },
                actions: [{}],
              }
            : {
                type: 'evm',
                includeAllBlocks: true,
                ...baseQuery,
              }

  const response = await portalFetchStream(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    query,
    { maxBlocks: 1, maxBytes: 2 * 1024 * 1024 },
  )

  const first = response[0] as { header?: { timestamp?: number }; timestamp?: number } | undefined
  return first?.header?.timestamp ?? first?.timestamp
}

function buildHeadLag(blockNumber: number | undefined, timestamp: number | undefined) {
  if (blockNumber === undefined) {
    return undefined
  }

  const lag: Record<string, unknown> = {
    block_number: blockNumber,
  }

  if (timestamp !== undefined) {
    const nowUnix = Math.floor(Date.now() / 1000)
    const ageSeconds = Math.max(0, nowUnix - timestamp)
    lag.timestamp = timestamp
    lag.timestamp_human = formatTimestamp(timestamp)
    lag.age_seconds = ageSeconds
    lag.age_formatted = formatDuration(ageSeconds)
    lag.status = ageSeconds <= 300 ? 'fresh' : ageSeconds <= 1800 ? 'delayed' : 'lagging'
  }

  return lag
}

// ============================================================================
// Tool: Get Dataset Info
// ============================================================================

export function registerGetDatasetInfoTool(server: McpServer) {
  server.tool(
    'portal_get_network_info',
    buildToolDescription('portal_get_network_info'),
    {
      network: z.string().describe('Network name or alias'),
    },
    async ({ network }) => {
      const dataset = await resolveDataset(network)

      const [datasets, metadata, head, finalizedHead] = await Promise.all([
        getDatasets(),
        portalFetch<DatasetMetadata>(`${PORTAL_URL}/datasets/${dataset}/metadata`),
        portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/head`),
        portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/finalized-head`).catch(() => undefined),
      ])

      const ds = datasets.find((d) => d.dataset === dataset)
      const chainType = await getChainType(dataset)
      const [headTimestamp, finalizedHeadTimestamp] = await Promise.all([
        fetchHeadTimestamp(dataset, chainType, head.number).catch(() => undefined),
        finalizedHead ? fetchHeadTimestamp(dataset, chainType, finalizedHead.number).catch(() => undefined) : Promise.resolve(undefined),
      ])

      // Infer correct network type (Portal metadata has bugs — many mainnets labeled "testnet")
      const name = dataset.toLowerCase()
      let networkType = ds?.metadata?.type
      if (name.includes('mainnet') || name.includes('-fills') || name.includes('-replica-cmds') || name === 'arbitrum-one' || name === 'arbitrum-nova') {
        networkType = 'mainnet'
      } else if (name.includes('testnet') || name.includes('sepolia') || name.includes('holesky') || name.includes('goerli')) {
        networkType = 'testnet'
      } else if (name.includes('devnet')) {
        networkType = 'devnet'
      }

      return formatResult({
        network: dataset,
        display_name: ds?.metadata?.display_name,
        vm:
          chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds'
            ? 'hyperliquid'
            : chainType,
        network_type: networkType,
        chain_id: ds?.metadata?.evm?.chain_id,
        is_l2: chainType === 'evm' && isL2Chain(dataset),
        real_time: ds?.real_time,
        start_block: metadata.start_block,
        head,
        finalized_head: finalizedHead,
        indexing: {
          indexed_head: buildHeadLag(head.number, headTimestamp),
          finalized_head: finalizedHead ? buildHeadLag(finalizedHead.number, finalizedHeadTimestamp) : undefined,
          finalized_lag_blocks:
            finalizedHead !== undefined ? Math.max(0, head.number - finalizedHead.number) : undefined,
          finalized_lag_seconds:
            finalizedHeadTimestamp !== undefined && headTimestamp !== undefined
              ? Math.max(0, headTimestamp - finalizedHeadTimestamp)
              : undefined,
          finalized_lag_formatted:
            finalizedHeadTimestamp !== undefined && headTimestamp !== undefined
              ? formatDuration(Math.max(0, headTimestamp - finalizedHeadTimestamp))
              : undefined,
        },
        tables: ds?.schema?.tables ? Object.keys(ds.schema.tables) : undefined,
        aliases: ds?.aliases,
      }, undefined, {
        toolName: 'portal_get_network_info',
      })
    },
  )
}
