import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SQD_ICON_DATA_URI } from './icons.js'
import { SERVER_CARD_HEADERS, buildServerCard } from './server-card.js'
import { npmVersion } from './version.js'

describe('MCP well-known server card', () => {
  it('advertises server metadata, SQD icons, skills, and unauthenticated Streamable HTTP endpoint', () => {
    const card = buildServerCard({ origin: 'https://portal.sqd.dev' })
    assert.equal(card.schemaVersion, '2026-07-28')
    assert.equal(card.serverInfo.name, 'sqd-portal-mcp-server')
    assert.equal(card.serverInfo.version, npmVersion)
    assert.equal(card.serverInfo.icons[0]?.src, SQD_ICON_DATA_URI)
    assert.equal(card.transport.endpoint, 'https://portal.sqd.dev/mcp')
    assert.equal(card.authentication.required, false)
    assert.equal(card.capabilities.progress, true)
    assert.equal('elicitation' in card.capabilities, false)
    assert.match(SERVER_CARD_HEADERS.Vary, /Host/)
    assert.match(SERVER_CARD_HEADERS.Vary, /X-Forwarded-Proto/)
    const skillsExt = card.capabilities.extensions['io.modelcontextprotocol/skills']
    assert.equal(skillsExt?.count, 4)
    const portalSkill = skillsExt?.skills.find((skill) => skill.name === 'portal')
    assert.equal(portalSkill?.uri, 'skill://portal/SKILL.md')
    assert.ok(typeof portalSkill?.description === 'string' && portalSkill.description.length > 20)
  })

  it('omits UI extension when MCP_APP_ENABLED=false', () => {
    const previous = process.env.MCP_APP_ENABLED
    process.env.MCP_APP_ENABLED = 'false'
    try {
      const card = buildServerCard()
      assert.equal(card.transport.endpoint, '/mcp')
      assert.equal('io.modelcontextprotocol/ui' in card.capabilities.extensions, false)
    } finally {
      if (previous === undefined) delete process.env.MCP_APP_ENABLED
      else process.env.MCP_APP_ENABLED = previous
    }
  })
})
