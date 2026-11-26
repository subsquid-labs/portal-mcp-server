import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'plugins/portal/skills')
const outputRoot = path.join(root, 'dist/skills')

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })

const entries = await readdir(sourceRoot, { withFileTypes: true })
const copied = []

for (const entry of entries) {
  if (!entry.isDirectory()) continue
  await cp(path.join(sourceRoot, entry.name), path.join(outputRoot, entry.name), {
    recursive: true,
    dereference: true,
  })
  copied.push(entry.name)
}

copied.sort()
console.log(`Copied ${copied.length} MCP skills to ${outputRoot}: ${copied.join(', ')}`)
