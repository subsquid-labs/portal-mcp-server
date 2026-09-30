import assert from 'node:assert/strict'
import { test } from 'node:test'

import { reportRelease } from './report-linear-release.mjs'
import { publicationWorkflows, resolvePublishedRelease } from './resolve-published-release.mjs'

const repository = 'example/server'
const tag = 'v1.2.3'
const sha = 'a'.repeat(40)
const run = {
  id: 20,
  event: 'push',
  head_branch: tag,
  head_sha: sha,
  head_repository: { full_name: repository },
  status: 'completed',
  conclusion: 'success',
}
const automatic = { eventName: 'workflow_run', event: { workflow_run: run }, repository }
const manual = { eventName: 'workflow_dispatch', event: {}, repository, tag }

function publicationApi({ runs = {}, commit = sha, release = {} } = {}) {
  return async (endpoint) => {
    if (endpoint.includes('/commits/')) {
      assert.ok(endpoint.endsWith(encodeURIComponent(`refs/tags/${tag}`)))
      return { sha: commit }
    }
    if (endpoint.includes('/releases/tags/')) {
      return {
        tag_name: tag,
        draft: false,
        assets: ['sqd.mcpb', 'sqd.tar.gz'].map((name) => ({ name, state: 'uploaded', size: 100 })),
        ...release,
      }
    }
    const workflow = publicationWorkflows.find((name) => endpoint.includes(`/${name}/runs?`))
    assert.ok(workflow, endpoint)
    assert.ok(endpoint.includes(`head_sha=${commit}`))
    return { workflow_runs: runs[workflow] ?? [structuredClone(run)] }
  }
}

test('requires all publication channels at the exact tag and commit', async () => {
  assert.deepEqual(await resolvePublishedRelease(automatic, publicationApi()), { ready: true, tag, sha })
  for (const workflow of publicationWorkflows) {
    for (const replacement of [
      [],
      [{ ...run, conclusion: 'failure' }],
      [{ ...run, status: 'in_progress', conclusion: null }],
      [{ ...run, head_branch: 'main' }],
      [{ ...run, head_sha: 'b'.repeat(40) }],
      [{ ...run, head_repository: { full_name: 'another/server' } }],
      [{ ...run, event: 'workflow_dispatch' }],
    ]) {
      assert.deepEqual(
        await resolvePublishedRelease(automatic, publicationApi({ runs: { [workflow]: replacement } })),
        { ready: false },
      )
    }
  }
})

test('a newer failed publication cannot be hidden by an older success', async () => {
  const api = publicationApi({
    runs: { 'docker-build.yml': [run, { ...run, id: 21, conclusion: 'failure' }] },
  })
  assert.deepEqual(await resolvePublishedRelease(automatic, api), { ready: false })
})

test('ignores edge builds, failed triggers, forks, and non-push runs before reading publication', async () => {
  const noApi = () => assert.fail('ineligible events must not query publication')
  for (const change of [
    { head_branch: 'main' },
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { event: 'workflow_dispatch' },
    { head_repository: { full_name: 'another/server' } },
  ]) {
    assert.deepEqual(
      await resolvePublishedRelease({ ...automatic, event: { workflow_run: { ...run, ...change } } }, noApi),
      { ready: false },
    )
  }
})

test('rejects a moved tag and invalid tag inputs', async () => {
  await assert.rejects(resolvePublishedRelease(automatic, publicationApi({ commit: 'b'.repeat(40) })), /no longer/)
  for (const invalid of ['main', '../v1.2.3', 'v1.2.3\nready=true', 'v1.2.3;echo surprise']) {
    await assert.rejects(resolvePublishedRelease({ ...manual, tag: invalid }, publicationApi()), /version tag/)
  }
})

test('manual previews require a published version too', async () => {
  assert.deepEqual(await resolvePublishedRelease(manual, publicationApi()), { ready: true, tag, sha })
  await assert.rejects(
    resolvePublishedRelease(manual, publicationApi({ runs: { 'docker-build.yml': [] } })),
    /Publication is not complete/,
  )
})

test('rejects drafts and missing or unfinished release assets', async () => {
  for (const release of [
    { draft: true },
    { tag_name: 'v9.9.9' },
    { assets: [] },
    { assets: [{ name: 'sqd.mcpb', state: 'uploaded', size: 100 }] },
    { assets: ['sqd.mcpb', 'sqd.tar.gz'].map((name) => ({ name, state: 'new', size: 100 })) },
    { assets: ['sqd.mcpb', 'sqd.tar.gz'].map((name) => ({ name, state: 'uploaded', size: 0 })) },
  ]) {
    await assert.rejects(resolvePublishedRelease(manual, publicationApi({ release })))
  }
})

function report({ dryRun, baseRef, failCommand, checkoutSha = sha, releaseTag = tag } = {}) {
  const commands = []
  const env = {
    LINEAR_ACCESS_KEY: 'test-placeholder',
    RELEASE_TAG: releaseTag,
    RELEASE_SHA: sha,
    GITHUB_REPOSITORY: repository,
    BASE_REF: baseRef ?? '',
  }
  if (dryRun !== undefined) env.DRY_RUN = dryRun
  let status = 0
  let message
  try {
    message = reportRelease(env, (command, args) => {
      if (command === 'git') return checkoutSha
      assert.equal(command, 'linear-release')
      commands.push(args)
      if (args[0] === failCommand) throw new Error('PRIVATE_TRACKER_ERROR')
      return 'PRIVATE_TRACKER_RESPONSE'
    })
  } catch (error) {
    status = 1
    message = error.message
  }
  assert.doesNotMatch(message, /PRIVATE_TRACKER|test-placeholder/)
  return { status, commands }
}

test('defaults to a read-only preview and passes the scan base as one argument', () => {
  const result = report({ baseRef: 'v1.2.2' })
  assert.equal(result.status, 0)
  assert.equal(result.commands.length, 1)
  assert.equal(result.commands[0][0], 'sync')
  assert.ok(result.commands[0].includes('--dry-run'))
  assert.ok(result.commands[0].includes('--base-ref=v1.2.2'))
})

test('successful reporting syncs and completes the same explicit version', () => {
  const result = report({ dryRun: 'false' })
  assert.equal(result.status, 0)
  assert.deepEqual(
    result.commands.map(([command]) => command),
    ['sync', 'complete'],
  )
  for (const command of result.commands) {
    assert.ok(command.includes('--release-version=1.2.3'))
    assert.ok(!command.includes('--dry-run'))
  }
})

test('never completes a failed sync and reports command failures without private output', () => {
  for (const failCommand of ['sync', 'complete']) {
    const result = report({ dryRun: 'false', failCommand })
    assert.notEqual(result.status, 0)
    assert.equal(result.commands.length, failCommand === 'sync' ? 1 : 2)
  }
})

test('rejects a mismatched checkout and invalid dry-run flag before accessing Linear', () => {
  for (const options of [{ checkoutSha: 'b'.repeat(40) }, { dryRun: 'yes' }]) {
    const result = report(options)
    assert.notEqual(result.status, 0)
    assert.equal(result.commands.length, 0)
  }
})

test('uses the package version while preserving the GitHub tag in names and links', () => {
  for (const version of ['0.8.5', '1.2.3-rc.1', '1.2.3+build.4']) {
    const result = report({ dryRun: 'false', releaseTag: `v${version}` })
    assert.equal(result.status, 0)
    for (const args of result.commands) assert.ok(args.includes(`--release-version=${version}`))
    assert.ok(result.commands[0].includes(`--name=v${version}`))
    assert.ok(
      result.commands[0].includes(`--link=GitHub release=https://github.com/${repository}/releases/tag/v${version}`),
    )
  }
  const invalid = report({ releaseTag: 'main' })
  assert.equal(invalid.status, 1)
  assert.equal(invalid.commands.length, 0)
})
