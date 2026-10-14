import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitReplicaHandler } from '../relay/git-replica-handler'
import { createMockDispatcher, type RelayDispatcher } from '../relay/git-handler-test-setup'
import { compareWithRelayReplica, type ReplicaComparisonRequest } from './replica-comparison-service'
import { resetSshRelayCapabilityCacheForTests } from './ssh/ssh-relay-capabilities'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim()
const commit = (cwd: string, msg: string): void => {
  git(cwd, 'commit', '--allow-empty', '-qm', msg)
}

let root: string
let local: string
let remote: string
let d: ReturnType<typeof createMockDispatcher>
let h: GitReplicaHandler
let calls: string[]

function relay(capabilities: string[], tamper?: (method: string, r: unknown) => unknown): ReplicaComparisonRequest {
  return async (method, params) => {
    calls.push(method)
    if (method === 'relay.status') {
      return { capabilities }
    }
    const r = await d.callRequest(method, params)
    return tamper ? tamper(method, r) : r
  }
}

beforeEach(() => {
  resetSshRelayCapabilityCacheForTests()
  calls = []
  root = mkdtempSync(join(tmpdir(), 'x08-'))
  local = join(root, 'local')
  remote = join(root, 'remote')
  git(root, 'init', '-q', '-b', 'main', local)
  commit(local, 'base')
  git(root, 'clone', '-q', local, remote)
  d = createMockDispatcher()
  h = new GitReplicaHandler(d as unknown as RelayDispatcher)
})
afterEach(async () => {
  await h.dispose()
  rmSync(root, { recursive: true, force: true })
})

const run = (request: ReplicaComparisonRequest) =>
  compareWithRelayReplica({
    connectionId: 'c',
    generation: 1,
    request,
    localRepoPath: local,
    remoteRepoPath: remote,
    hostKey: 'gex44',
    now: () => 7
  })

describe('compareWithRelayReplica', () => {
  it('decides behind on transferred objects and releases the export', async () => {
    commit(remote, 'r1')
    commit(remote, 'r2')
    const r = await run(relay(['git.replicaBundle']))
    expect(r.ok).toBe(true)
    if (!r.ok) {
      return
    }
    expect(r.evidence.outcome).toEqual({ ok: true, ancestry: { kind: 'behind', count: 2 } })
    expect(r.evidence.observedTips).toEqual([git(local, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'HEAD')])
    expect(git(local, 'rev-parse', 'refs/orca/replicas/gex44/HEAD')).toBe(git(remote, 'rev-parse', 'HEAD'))
    expect(calls.at(-1)).toBe('git.replicaBundleRelease')
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('orca-replica-recv-'))).toEqual([])
  })

  it('decides same, ahead and diverged', async () => {
    const same = await run(relay(['git.replicaBundle']))
    expect(same.ok && same.evidence.outcome).toEqual({ ok: true, ancestry: { kind: 'same' } })
    commit(local, 'l1')
    const ahead = await run(relay(['git.replicaBundle']))
    expect(ahead.ok && ahead.evidence.outcome).toEqual({ ok: true, ancestry: { kind: 'ahead', count: 1 } })
    commit(remote, 'r1')
    const div = await run(relay(['git.replicaBundle']))
    expect(div.ok && div.evidence.outcome).toMatchObject({
      ok: true,
      ancestry: { kind: 'diverged', aheadCount: 1, behindCount: 1 }
    })
  })

  it('never calls replica methods on a relay without the capability', async () => {
    const r = await run(relay(['git.exec']))
    expect(r).toEqual({ ok: false, reason: 'relay-unsupported', evidence: null })
    expect(calls).toEqual(['relay.status'])
  })

  it('a failed probe reads unsupported', async () => {
    const r = await run(vi.fn().mockRejectedValue(new Error('down')))
    expect(r).toMatchObject({ ok: false, reason: 'relay-unsupported' })
  })

  it('a corrupted chunk is transfer-interrupted, leaves no ref, and still releases', async () => {
    commit(remote, 'r1')
    const bad = relay(['git.replicaBundle'], (m, r) =>
      m === 'git.replicaBundleRead'
        ? { ...(r as object), data: Buffer.from('garbage').toString('base64'), bytesRead: 7 }
        : r
    )
    const r = await run(bad)
    expect(r).toMatchObject({ ok: false, reason: 'transfer-interrupted' })
    expect(git(local, 'for-each-ref', 'refs/orca/replicas')).toBe('')
    expect(calls.at(-1)).toBe('git.replicaBundleRelease')
  })

  it('a relay that lies about heads is bundle-heads-mismatch with no ref left', async () => {
    commit(remote, 'r1')
    const lie = relay(['git.replicaBundle'], (m, r) =>
      m === 'git.replicaBundleExport'
        ? { ...(r as object), heads: [{ ref: 'HEAD', sha: 'a'.repeat(40) }] }
        : r
    )
    const r = await run(lie)
    expect(r).toMatchObject({ ok: false, reason: 'bundle-heads-mismatch' })
    expect(git(local, 'for-each-ref', 'refs/orca/replicas')).toBe('')
  })

  it('a malformed export response is relay-bad-response', async () => {
    const r = await run(relay(['git.replicaBundle'], (m, x) => (m === 'git.replicaBundleExport' ? { nope: 1 } : x)))
    expect(r).toMatchObject({ ok: false, reason: 'relay-bad-response' })
  })
})
