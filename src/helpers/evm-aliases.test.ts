import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ActionableError } from './errors.js'
import { listMethodAliases, resolveEventTopic0, resolveMethodSighashes } from './evm-aliases.js'

describe('EVM method and event aliases', () => {
  it('resolves swap, execute, and multicall method aliases', () => {
    const swapSelectors = resolveMethodSighashes('swap')
    assert.ok(swapSelectors.includes('0x414bf389'), 'swap should include Uniswap V3 exactInputSingle')
    assert.ok(swapSelectors.includes('0x3593564c'), 'swap should include Universal Router execute')
    assert.ok(swapSelectors.includes('0x38ed1739'), 'swap should include Uniswap V2 swapExactTokensForTokens')
    assert.deepEqual(resolveMethodSighashes('execute'), ['0x3593564c'])
    assert.ok(resolveMethodSighashes('multicall').includes('0xac9650d8'))
  })

  it('lists known aliases when an invalid method or event alias is given', () => {
    assert.throws(
      () => resolveMethodSighashes('not_a_real_method'),
      (error: unknown) => {
        assert.ok(error instanceof ActionableError)
        assert.equal(error.code, 'invalid_request')
        assert.equal(error.origin, 'client_input')
        assert.ok(error.suggestions[0]?.includes('swap'))
        for (const alias of listMethodAliases().slice(0, 3)) {
          assert.ok(error.suggestions[0]?.includes(alias))
        }
        return true
      },
    )
    assert.throws(
      () => resolveEventTopic0('not_a_real_event'),
      (error: unknown) => error instanceof ActionableError && error.code === 'invalid_request',
    )
  })
})
