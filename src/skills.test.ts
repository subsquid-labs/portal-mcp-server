import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { SKILLS_EXTENSION_ID, SKILLS_GET_METHOD, SKILLS_LIST_METHOD } from '@modelcontextprotocol/server/ext/skills'
import { z } from 'zod'

import { createPortalServer } from './server.js'
import { getPortalSkillCatalog, resolveSkillsDirectory } from './skills.js'

describe('MCP Skills extension (SEP-2640)', () => {
  it('loads all bundled SQD skills from disk without warnings', () => {
    assert.ok(resolveSkillsDirectory(), 'expected bundled skills directory to be found')
    const catalog = getPortalSkillCatalog()
    assert.ok(catalog, 'expected bundled skill catalog to load')
    const names = catalog.entries.map((entry) => entry.frontmatter.name).sort()
    assert.deepEqual(names, ['migrate-to-portal', 'pipes-sdk', 'portal', 'squid-perf'])
  })

  it('serves skills/list, skills/get, and skill:// resource reads over MCP', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createPortalServer({ transport: 'stdio' })
    const client = new Client({ name: 'sqd-skills-test', version: '1.0.0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const capabilities = client.getServerCapabilities() as Record<string, any> | undefined
      assert.ok(
        capabilities?.extensions?.[SKILLS_EXTENSION_ID],
        'server should advertise the io.modelcontextprotocol/skills extension capability',
      )

      const listResult = await client.request(
        { method: SKILLS_LIST_METHOD, params: {} },
        z.object({ skills: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
      )
      assert.equal(listResult.skills.length, 4)
      const portalSkill = listResult.skills.find(
        (entry) => (entry.frontmatter as { name?: string } | undefined)?.name === 'portal',
      ) as { uri: string; frontmatter: { name: string; description: string } } | undefined
      assert.equal(portalSkill?.uri, 'skill://portal/SKILL.md')

      const getResult = await client.request(
        { method: SKILLS_GET_METHOD, params: { uri: portalSkill.uri } },
        z.object({ skill: z.record(z.string(), z.unknown()) }).passthrough(),
      )
      assert.equal((getResult.skill.frontmatter as { name?: string } | undefined)?.name, 'portal')

      const readResult = await client.readResource({ uri: portalSkill.uri })
      const text = readResult.contents[0] && 'text' in readResult.contents[0] ? readResult.contents[0].text : ''
      assert.ok(text.includes('# Portal'), 'reading skill://portal/SKILL.md should return the skill playbook')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
