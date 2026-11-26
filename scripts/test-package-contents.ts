#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { digestClientCandidate } from './lib/client-candidate-digest.mjs'

type PackedFile = {
  path: string
}

type PackResult = {
  filename: string
  files: PackedFile[]
  size: number
  unpackedSize: number
}

function fail(message: string): never {
  throw new Error(message)
}

function parsePackOutput(raw: string): PackResult {
  const parsed = JSON.parse(raw) as PackResult[]
  const result = parsed[0]
  if (!result || !Array.isArray(result.files)) {
    fail('npm pack output did not include a file list')
  }
  return result
}

async function assertCandidateDigestCoversNestedRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'sqd-candidate-digest-'))
  try {
    const manifests = join(root, 'candidate')
    const runtime = join(root, 'dist')
    await mkdir(join(runtime, 'helpers'), { recursive: true })
    await mkdir(manifests, { recursive: true })
    await writeFile(join(manifests, 'manifest.json'), '{"name":"SQD"}\n')
    await writeFile(join(runtime, 'index.js'), "import './helpers/evidence.js'\n")
    await writeFile(join(runtime, 'helpers/evidence.js'), 'export const rows = 0\n')
    await writeFile(join(root, 'package.json'), '{"version":"0.8.3"}\n')
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')

    const input = {
      projectRoot: root,
      manifestRoot: manifests,
      manifestFiles: ['manifest.json'],
      runtimeRoot: runtime,
      runtimeMetadataFiles: [join(root, 'package.json'), join(root, 'package-lock.json')],
    }
    const before = await digestClientCandidate(input)
    await writeFile(join(runtime, 'helpers/evidence.js'), 'export const rows = 5\n')
    const after = await digestClientCandidate(input)

    if (before.packageSha256 === after.packageSha256) {
      fail('Client candidate digest ignored a changed nested runtime module')
    }
    if (before.runtimeFileCount !== 2 || before.hashedFileCount !== 5) {
      fail('Client candidate digest did not cover the complete first-party runtime set')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await assertCandidateDigestCoversNestedRuntime()

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_loglevel: 'silent',
  },
})

const pack = parsePackOutput(raw)
const files = pack.files.map((file) => file.path).sort()
const fileSet = new Set(files)

const requiredFiles = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'dist/licenses/lightweight-charts-LICENSE.txt',
  'dist/index.js',
  'dist/http.js',
  'dist/server.js',
  'dist/skills/portal/SKILL.md',
  'dist/skills/pipes-sdk/SKILL.md',
  'dist/skills/migrate-to-portal/SKILL.md',
  'dist/skills/squid-perf/SKILL.md',
]

const forbiddenPrefixes = ['src/', 'scripts/', 'plans/', '.github/', 'grafana/', 'node_modules/']
const forbiddenFiles = [
  '.dockerignore',
  '.mise.toml',
  'Dockerfile',
  'biome.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
]

const errors: string[] = []

for (const file of requiredFiles) {
  if (!fileSet.has(file)) {
    errors.push(`Missing required package file: ${file}`)
  }
}

for (const file of files) {
  if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
    errors.push(`Forbidden package path: ${file}`)
  }
  if (forbiddenFiles.includes(file)) {
    errors.push(`Forbidden package file: ${file}`)
  }
  if (file.endsWith('.map')) {
    errors.push(`Forbidden package source map: ${file}`)
  }
}

if (errors.length > 0) {
  console.error(`Package content check failed for ${pack.filename}:`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `Package contents OK: ${pack.filename} includes ${files.length} files (${Math.round(pack.unpackedSize / 1024)} KiB unpacked)`,
)
