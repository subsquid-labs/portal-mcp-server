import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildLlmHints } from './llm-hints.js'

describe('buildLlmHints slim structural pointers', () => {
  it('omits duplicated top-level payloads while keeping lossless 1-row primary_preview', () => {
    const payload = {
      answer: 'Found 2 transfers.',
      items: [
        {
          hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          amount: '0.00000001',
          block_number: 100,
        },
        {
          hash: '0x2222222222222222222222222222222222222222222222222222222222222222',
          amount: '1.5',
          block_number: 101,
        },
      ],
      tables: [
        {
          id: 'transfers',
          title: 'Transfers',
          data_key: 'items',
          row_count: 2,
          key_field: 'hash',
          columns: [
            { key: 'hash', label: 'Hash', kind: 'dimension', format: 'identifier' },
            { key: 'amount', label: 'Amount', kind: 'metric', format: 'decimal' },
          ],
        },
      ],
      _ui: {
        version: 'portal_ui_v1',
        headline: { title: 'Transfers', subtitle: 'Recent' },
        metric_cards: [{ id: 'count', label: 'Count', value_path: 'items.length', format: 'integer' }],
        panels: [{ id: 'tbl', kind: 'table_panel', title: 'Transfers', table_id: 'transfers' }],
      },
      _pagination: { next_cursor: 'cursor-123' },
    }

    const hints = buildLlmHints(payload, { parser_notes: ['Note 1', 'Note 2'] })
    assert.equal(hints.version, 'portal_llm_v1')
    assert.equal('chart' in hints, false)
    assert.equal('tables' in hints, false)
    assert.equal('metric_cards' in hints, false)
    assert.equal('headline' in hints, false)
    assert.equal(hints.primary_preview?.rows?.length, 1)
    assert.equal(hints.primary_preview?.rows?.[0]?.cells[1]?.display_value, '0.00000001')
    assert.equal(hints.follow_up?.continue_cursor_path, '_pagination.next_cursor')
    assert.deepEqual(hints.parser_notes, ['Note 1'])
    assert.ok(hints.sections.length <= 4)
    assert.ok(hints.recommended_views.length <= 3)

    const compactHints = buildLlmHints(payload, { compact: true })
    assert.equal(compactHints.primary_preview, undefined)
    assert.deepEqual(compactHints.recommended_views, [])
    assert.equal(compactHints.sections.length, 1)
  })
})
