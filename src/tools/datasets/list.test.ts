import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareNetworkRows } from './list.js'

describe('portal_list_networks ranking', () => {
  it('places popular mainnets ahead of alphabetical long-tail chains and testnets', () => {
    const rows = [
      { network: 'abstract-mainnet', type: 'mainnet', real_time: true },
      { network: 'base-sepolia', type: 'testnet', real_time: true },
      { network: 'tron-mainnet', type: 'mainnet', real_time: true },
      { network: 'solana-mainnet', type: 'mainnet', real_time: true },
      { network: 'ethereum-mainnet', type: 'mainnet', real_time: true },
      { network: 'bitcoin-mainnet', type: 'mainnet', real_time: true },
      { network: 'base-mainnet', type: 'mainnet', real_time: true },
    ]
    const sorted = [...rows].sort((left, right) => compareNetworkRows(left, right))
    assert.deepEqual(
      sorted.map((row) => row.network),
      [
        'ethereum-mainnet',
        'base-mainnet',
        'solana-mainnet',
        'bitcoin-mainnet',
        'tron-mainnet',
        'abstract-mainnet',
        'base-sepolia',
      ],
    )
  })

  it('prefers direct and multi-token query matches ahead of featured rank', () => {
    const rows = [
      { network: 'base-mainnet', type: 'mainnet', real_time: true },
      { network: 'ethereum-mainnet', type: 'mainnet', real_time: true },
      { network: 'base-sepolia', type: 'testnet', real_time: true },
    ]
    const exactSorted = [...rows].sort((left, right) => compareNetworkRows(left, right, 'base-sepolia'))
    assert.equal(exactSorted[0]?.network, 'base-sepolia')

    const spacedSorted = [...rows].sort((left, right) => compareNetworkRows(left, right, 'base sepolia'))
    assert.equal(spacedSorted[0]?.network, 'base-sepolia')

    const familySorted = [...rows].sort((left, right) => compareNetworkRows(left, right, 'base'))
    assert.equal(familySorted[0]?.network, 'base-mainnet')
  })
})
