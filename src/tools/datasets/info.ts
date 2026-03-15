import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, getChainType, getDatasets, isL2Chain, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetch } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import type { BlockHead, DatasetMetadata } from '../../types/index.js'

// ============================================================================
// Tool: Get Dataset Info
// ============================================================================

export function registerGetDatasetInfoTool(server: McpServer) {
  server.tool(
    'portal_get_dataset_info',
    'Get detailed info about a dataset: latest block, start block, chain type, available tables, and metadata.',
    {
      dataset: z.string().describe('Dataset name or alias'),
    },
    async ({ dataset }) => {
      dataset = await resolveDataset(dataset)

      const [datasets, metadata, head, finalizedHead] = await Promise.all([
        getDatasets(),
        portalFetch<DatasetMetadata>(`${PORTAL_URL}/datasets/${dataset}/metadata`),
        portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/head`),
        portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/finalized-head`).catch(() => undefined),
      ])

      const ds = datasets.find((d) => d.dataset === dataset)
      const chainType = await getChainType(dataset)

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
        dataset,
        display_name: ds?.metadata?.display_name,
        kind: chainType,
        network_type: networkType,
        chain_id: ds?.metadata?.evm?.chain_id,
        is_l2: chainType === 'evm' && isL2Chain(dataset),
        real_time: ds?.real_time,
        start_block: metadata.start_block,
        head,
        finalized_head: finalizedHead,
        tables: ds?.schema?.tables ? Object.keys(ds.schema.tables) : undefined,
        aliases: ds?.aliases,
      })
    },
  )
}
