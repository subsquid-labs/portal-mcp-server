#!/usr/bin/env node
// Build the generated Explorer bundle when it is missing or older than any of
// its inputs. `src/generated/` is not tracked in git, so every entry point that
// imports the bundle from source (dev, typecheck, the tsx-based tests) runs this
// first; `npm run build` always regenerates it unconditionally.
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputs = ['src/generated/activity-explorer.generated.ts', 'src/generated/activity-explorer.version.ts'].map(
  (file) => path.join(root, file),
)
const inputRoots = ['src/app-ui'].map((dir) => path.join(root, dir))
const inputFiles = [
  'scripts/build-activity-explorer.mjs',
  'scripts/compact-stylesheet-plugin.mjs',
  'scripts/generate-app-compat-manifest.mjs',
  'package.json',
  'package-lock.json',
].map((file) => path.join(root, file))

function mtime(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

function newestInput() {
  let newest = 0
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (!entry.name.endsWith('.test.ts')) newest = Math.max(newest, mtime(full) ?? 0)
    }
  }
  for (const dir of inputRoots) visit(dir)
  for (const file of inputFiles) newest = Math.max(newest, mtime(file) ?? 0)
  return newest
}

const outputTimes = outputs.map(mtime)
const missing = outputTimes.some((time) => time === undefined)
const stale = !missing && Math.min(...outputTimes) < newestInput()

if (!missing && !stale) {
  process.exit(0)
}

console.log(`[ensure-app-bundle] ${missing ? 'bundle missing' : 'bundle older than its inputs'}, running build:app`)
const result = spawnSync('npm', ['run', '--silent', 'build:app'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
