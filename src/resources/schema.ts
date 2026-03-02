import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getDatasets, resolveDataset } from '../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../constants/index.js'
import { portalFetch } from '../helpers/fetch.js'
import {
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
} from '../helpers/fields.js'
import type { BlockHead, DatasetMetadata } from '../types/index.js'
import { npmVersion } from '../version.js'

// ============================================================================
// MCP Resources
// ============================================================================

export function registerSchemaResource(server: McpServer) {
  // Resource: List all datasets
  server.resource('datasets', 'sqd://datasets', async (uri) => {
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
  })

  // Resource: Dataset info template
  server.resource(
    'dataset-info',
    new ResourceTemplate('sqd://datasets/{name}', { list: undefined }),
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
  server.resource('schema-evm', 'sqd://schema/evm', async (uri) => {
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
  })

  // Resource: Solana API Schema
  server.resource('schema-solana', 'sqd://schema/solana', async (uri) => {
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
  })
}
