import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getTokenListChainForDataset } from './entity-resolution.js'

describe('entity-resolution token list chain mapping', () => {
  it('maps EVM, Solana, and Tron datasets to CoinGecko token-list chains', () => {
    assert.equal(getTokenListChainForDataset('ethereum-mainnet'), 'ethereum')
    assert.equal(getTokenListChainForDataset('base-mainnet'), 'base')
    assert.equal(getTokenListChainForDataset('solana-mainnet'), 'solana')
    assert.equal(getTokenListChainForDataset('tron-mainnet'), 'tron')
  })

  it('returns undefined for chains without a CoinGecko token list', () => {
    assert.equal(getTokenListChainForDataset('bitcoin-mainnet'), undefined)
    assert.equal(getTokenListChainForDataset('polkadot'), undefined)
  })
})
