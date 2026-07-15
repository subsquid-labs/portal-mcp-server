#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const REPOSITORY = 'https://github.com/subsquid-labs/skills'
const TARGET_ROOT = resolve('plugins/portal/skills')
const METADATA_PATH = resolve('plugins/portal/skills-upstream.json')
const SKILLS = [
  { source: 'portal', target: 'portal' },
  { source: 'pipes-sdk', target: 'pipes-sdk' },
]

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  let mode
  let source = process.env.SQD_SKILLS_REPO || '../skills'

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--write' || arg === '--check') mode = arg.slice(2)
    else if (arg === '--source') source = argv[++index]
    else fail(`Unknown argument: ${arg}`)
  }

  if (!mode) fail('Choose exactly one mode: --write or --check')
  if (!source) fail('--source requires a path')
  return { mode, source: resolve(source) }
}

function listFiles(root, current = root) {
  if (!existsSync(current)) return []
  return readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.name !== '.DS_Store')
    .flatMap((entry) => {
      const path = resolve(current, entry.name)
      return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)]
    })
    .sort()
}

function compareDirectories(source, target) {
  const sourceFiles = listFiles(source)
  const targetFiles = listFiles(target)
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) return false

  return sourceFiles.every((file) => readFileSync(resolve(source, file)).equals(readFileSync(resolve(target, file))))
}

function readVersion(skillPath) {
  const content = readFileSync(resolve(skillPath, 'SKILL.md'), 'utf8')
  const match = content.match(/^\s*version:\s*["']?([^"'\n]+)["']?\s*$/m)
  if (!match) fail(`Could not read metadata.version from ${skillPath}/SKILL.md`)
  return match[1].trim()
}

function upstreamTree(sourceRoot, source) {
  try {
    return execFileSync('git', ['-C', sourceRoot, 'rev-parse', `HEAD:${source}`], { encoding: 'utf8' }).trim()
  } catch {
    fail(`Could not resolve the upstream tree for ${source} from ${sourceRoot}`)
  }
}

function expectedMetadata(sourceRoot) {
  return {
    repository: REPOSITORY,
    skills: SKILLS.map(({ source, target }) => ({
      source,
      target,
      version: readVersion(resolve(sourceRoot, source)),
      tree: upstreamTree(sourceRoot, source),
    })),
  }
}

function writeBundle(sourceRoot) {
  for (const { source, target } of SKILLS) {
    const sourcePath = resolve(sourceRoot, source)
    const targetPath = resolve(TARGET_ROOT, target)
    if (!existsSync(resolve(sourcePath, 'SKILL.md'))) fail(`Missing upstream skill: ${sourcePath}/SKILL.md`)
    rmSync(targetPath, { recursive: true, force: true })
    mkdirSync(dirname(targetPath), { recursive: true })
    cpSync(sourcePath, targetPath, { recursive: true })
  }

  writeFileSync(METADATA_PATH, `${JSON.stringify(expectedMetadata(sourceRoot), null, 2)}\n`)
  console.log(`Synced ${SKILLS.length} plugin skills from ${sourceRoot}`)
}

function checkBundle(sourceRoot) {
  const mismatches = SKILLS.filter(
    ({ source, target }) => !compareDirectories(resolve(sourceRoot, source), resolve(TARGET_ROOT, target)),
  )

  let metadataMatches = false
  if (existsSync(METADATA_PATH) && statSync(METADATA_PATH).isFile()) {
    const actual = JSON.parse(readFileSync(METADATA_PATH, 'utf8'))
    metadataMatches = JSON.stringify(actual) === JSON.stringify(expectedMetadata(sourceRoot))
  }

  if (mismatches.length > 0 || !metadataMatches) {
    const names = mismatches.map(({ target }) => target).join(', ') || 'metadata'
    fail(`Bundled plugin skills are stale (${names}). Run npm run sync:plugin-skills -- --source ${sourceRoot}`)
  }

  console.log(`Bundled plugin skills match ${sourceRoot}`)
}

const { mode, source } = parseArgs(process.argv.slice(2))
if (mode === 'write') writeBundle(source)
else checkBundle(source)
