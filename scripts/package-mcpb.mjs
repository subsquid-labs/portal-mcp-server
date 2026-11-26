#!/usr/bin/env node
// ============================================================================
// Package the server as an MCP Bundle (.mcpb) for one-click Claude Desktop install
// ============================================================================
//
// Stages the production build, the exact production dependency closure from
// the local node_modules (no network), a manifest, and the icon; validates the
// manifest with the official MCPB CLI; zips it as dist/mcpb/sqd.mcpb; and
// fails above the size budget. Run `npm run build` first.

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.resolve(root, process.argv[2] ?? 'dist/mcpb')
// Staged outside dist so copying dist never copies into itself.
const stage = mkdtempSync(path.join(tmpdir(), 'sqd-mcpb-stage-'))
const bundlePath = path.join(outputDir, 'sqd.mcpb')
const SIZE_BUDGET_BYTES = 15 * 1024 * 1024

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = String(packageJson.version)
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid package version: ${version}`)
if (!existsSync(path.join(root, 'dist/index.js'))) {
  throw new Error('dist/index.js is missing; run `npm run build` before packaging the bundle')
}

/* Files that never need to ship inside the bundle. Licence files stay. */
const EXCLUDED =
  /\.(map|d\.ts|d\.mts|d\.cts|md|markdown|test\.js)$|(^|\/)(CHANGELOG|README|\.github|test|tests|__tests__|docs)(\/|$)/i
function filter(source) {
  const relative = path.relative(root, source)
  if (relative === '') return true
  const normalized = relative.split(path.sep).join('/')
  // Bundled MCP skills ship markdown playbooks and references under dist/skills/.
  if (normalized === 'dist/skills' || normalized.startsWith('dist/skills/')) return true
  const base = path.basename(relative)
  if (/^LICEN[CS]E/i.test(base)) return true
  return !EXCLUDED.test(relative)
}

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })

// 1. Production build.
cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), {
  recursive: true,
  filter: (source) => !source.startsWith(path.join(root, 'dist/mcpb')) && filter(source),
})

// 2. Exact production dependency closure from the installed tree.
const closure = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && line !== root)
for (const packageDir of closure) {
  const relative = path.relative(root, packageDir)
  if (!relative.startsWith('node_modules')) continue
  cpSync(packageDir, path.join(stage, relative), {
    recursive: true,
    filter: (source) => {
      const inner = path.relative(packageDir, source)
      // nested node_modules are separate closure entries
      if (inner.split(path.sep).includes('node_modules')) return false
      return filter(source)
    },
  })
}

// 3. Package metadata, licences, icon.
writeFileSync(
  path.join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: packageJson.name,
      version,
      description: packageJson.description,
      type: packageJson.type,
      license: packageJson.license,
      dependencies: packageJson.dependencies,
      engines: packageJson.engines,
    },
    null,
    2,
  )}\n`,
)
cpSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'))
cpSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(stage, 'THIRD_PARTY_NOTICES.md'))
cpSync(path.join(root, 'plugins/portal/assets/sqd-directory-icon.png'), path.join(stage, 'icon.png'))

// 4. Manifest. Tool names and titles come from the built server so the
//    bundle can never list a tool that the code does not register.
const { createPortalServer } = await import(path.join(root, 'dist/server.js'))
const { Client } = await import('@modelcontextprotocol/client')
const { InMemoryTransport } = await import('@modelcontextprotocol/server')
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const server = createPortalServer({ transport: 'stdio' })
const client = new Client({ name: 'sqd-mcpb-packager', version })
await server.connect(serverTransport)
await client.connect(clientTransport)
const tools = (await client.listTools()).tools.map((tool) => ({
  name: tool.name,
  description: tool.title ?? tool.name,
}))
const prompts = (await client.listPrompts()).prompts.map((prompt) => ({
  name: prompt.name,
  description: prompt.description ?? prompt.title ?? prompt.name,
  arguments: (prompt.arguments ?? []).map((argument) => argument.name),
  text: prompt.description ?? prompt.title ?? prompt.name,
}))
await client.close()
await server.close()

const manifest = {
  $schema: 'https://raw.githubusercontent.com/anthropics/mcpb/main/dist/mcpb-manifest-v0.3.schema.json',
  manifest_version: '0.3',
  name: 'sqd',
  display_name: 'SQD',
  version,
  description: 'Read-only blockchain data from SQD Portal: EVM, Solana, Bitcoin, Substrate, Hyperliquid.',
  long_description:
    'Query transactions, logs, token transfers, wallets, analytics, time series, and candles across the networks indexed by SQD Portal. No account or API key is required. Every result carries coverage, freshness, pagination, and evidence metadata.',
  author: { name: 'SQD', url: 'https://sqd.ai' },
  repository: { type: 'git', url: 'https://github.com/subsquid-labs/portal-mcp-server' },
  homepage: 'https://sqd.ai',
  documentation: 'https://github.com/subsquid-labs/portal-mcp-server#readme',
  support: 'https://github.com/subsquid-labs/portal-mcp-server/issues',
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/index.js'],
      env: {
        MCP_APP_ENABLED: '${user_config.app_enabled}',
      },
    },
  },
  tools,
  tools_generated: false,
  prompts,
  prompts_generated: false,
  keywords: ['blockchain', 'ethereum', 'solana', 'bitcoin', 'polkadot', 'hyperliquid', 'sqd', 'portal', 'onchain'],
  license: packageJson.license,
  compatibility: {
    claude_desktop: '>=0.10.0',
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=22.0.0' },
  },
  user_config: {
    app_enabled: {
      type: 'boolean',
      title: 'SQD Explorer (beta)',
      description: 'Offer the beta SQD Explorer app to hosts that support MCP Apps.',
      required: false,
      default: false,
    },
  },
}
writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
// Override mcpb pack's default `*.log` exclusion for bundled skill fixtures
// under dist/skills/ (e.g., squid-perf benchmark sample logs). `.mcpbignore`
// itself remains excluded from the packed archive.
writeFileSync(path.join(stage, '.mcpbignore'), '!dist/skills/**\n!dist/skills/**/*.log\n')

// 5. Validate and pack with the official CLI.
const mcpbCli = path.join(root, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js')
const runMcpb = (label, args) => {
  const outcome = spawnSync(process.execPath, [mcpbCli, ...args], { encoding: 'utf8' })
  if (outcome.error) throw outcome.error
  if (outcome.status !== 0) throw new Error(`mcpb ${label} failed: ${outcome.stdout}${outcome.stderr}`)
}
runMcpb('validate', ['validate', path.join(stage, 'manifest.json')])
/* `mcpb pack` rather than shelling out to `zip`. The system binary is not
   everywhere: the Playwright image CI runs the offline gate in does not carry
   it, so packaging failed with ENOENT while every local run passed. The CLI is
   already a dependency and already writes the archive format the format
   defines. */
runMcpb('pack', ['pack', stage, bundlePath])
rmSync(stage, { recursive: true, force: true })

const bytes = statSync(bundlePath).size
if (bytes > SIZE_BUDGET_BYTES) {
  throw new Error(`sqd.mcpb is ${bytes} bytes, above the ${SIZE_BUDGET_BYTES} byte budget`)
}
console.log(`${bundlePath} (${(bytes / 1024 / 1024).toFixed(2)} MB, ${tools.length} tools, ${prompts.length} prompts)`)
