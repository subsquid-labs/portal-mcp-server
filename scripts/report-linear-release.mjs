import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function runCommand(command, args) {
  // Tracker responses can contain private issue details. Capture both streams
  // without logging them, writing them to disk, or attaching them as artifacts.
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 150_000,
    maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error('Reporting command failed')
  return result.stdout
}

export function reportRelease(env, run = runCommand) {
  for (const name of ['LINEAR_ACCESS_KEY', 'RELEASE_TAG', 'RELEASE_SHA', 'GITHUB_REPOSITORY']) {
    if (!env[name]) throw new Error(`${name} is required`)
  }
  if (run('git', ['rev-parse', 'HEAD']).trim() !== env.RELEASE_SHA) {
    throw new Error('Release checkout does not match the verified publication')
  }
  const dryRun = env.DRY_RUN ?? 'true'
  if (!['true', 'false'].includes(dryRun)) throw new Error('DRY_RUN must be true or false')

  const args = [`--release-version=${env.RELEASE_TAG}`, '--quiet', '--timeout=120']
  const syncArgs = [`--name=${env.RELEASE_TAG}`, '--no-branch-ref-detection']
  if (env.BASE_REF) syncArgs.push(`--base-ref=${env.BASE_REF}`)
  syncArgs.push(`--link=GitHub release=https://github.com/${env.GITHUB_REPOSITORY}/releases/tag/${env.RELEASE_TAG}`)

  try {
    if (dryRun === 'true') {
      run('linear-release', ['sync', ...args, ...syncArgs, '--dry-run'])
      return 'Release reporting preview passed. No tracker changes were made.'
    }
    run('linear-release', ['sync', ...args, ...syncArgs])
    run('linear-release', ['complete', ...args])
    return 'Published version reported successfully.'
  } catch {
    throw new Error('Release reporting failed; tracker output was withheld from public logs')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(reportRelease(process.env))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
