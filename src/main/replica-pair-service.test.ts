import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMockDispatcher, type RelayDispatcher } from '../relay/git-handler-test-setup'
import { GitReplicaHandler } from '../relay/git-replica-handler'
import type { ProjectHostSetup } from '../shared/project-types'
import { createReplicaPairService, replicaHostKey } from './replica-pair-service'
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

const setup = (over: Partial<ProjectHostSetup> & Pick<ProjectHostSetup, 'id' | 'hostId' | 'path'>): ProjectHostSetup => ({
  projectId: 'p1',
  repoId: `repo-${over.id}`,
  displayName: over.id,
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...over
})

function sshSession(capabilities: string[]) {
  return {
    getMultiplexer: () => ({
      isDisposed: () => false,
      request: async (method: string, params?: Record<string, unknown>) => {
        calls.push(method)
        if (method === 'relay.status') {
          return { capabilities }
        }
        return d.callRequest(method, params ?? {})
      }
    }),
    getGeneration: () => 1
  }
}

function service(capabilities: string[], setups: ProjectHostSetup[]) {
  return createReplicaPairService({
    listProjectHostSetups: () => setups,
    sshSession: sshSession(capabilities),
    now: () => 7
  })
}

const localSetup = () => setup({ id: 'anchor', hostId: 'local', path: local, createdAt: 1 })
const sshSetup = () => setup({ id: 'box', hostId: 'ssh:gex44', connectionId: 'gex44', path: remote, createdAt: 2 })

beforeEach(() => {
  resetSshRelayCapabilityCacheForTests()
  calls = []
  root = mkdtempSync(join(tmpdir(), 'rps-'))
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

async function pairOf(svc: ReturnType<typeof service>) {
  const res = await svc.compare({ projectId: 'p1' })
  expect(res.status).toBe('ok')
  if (res.status !== 'ok') {
    throw new Error('expected ok')
  }
  expect(res.pairs).toHaveLength(1)
  return res.pairs[0]
}

describe('createReplicaPairService.compare over the real relay handler', () => {
  it('the setup holding two more commits reads as the anchor behind by 2, with both observed tips', async () => {
    commit(remote, 'r1')
    commit(remote, 'r2')
    const pair = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(pair).toMatchObject({
      setupId: 'box',
      anchorSetupId: 'anchor',
      hostId: 'ssh:gex44',
      relation: { kind: 'behind', count: 2 },
      healthy: false
    })
    expect(pair.relation).toMatchObject({ observedTips: [git(local, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'HEAD')] })
    expect(pair.remoteTip).toBe(git(remote, 'rev-parse', 'HEAD'))
  })

  it('the setup behind the anchor reads as the anchor ahead', async () => {
    commit(local, 'l1')
    const pair = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(pair.relation).toMatchObject({ kind: 'ahead', count: 1 })
    expect(pair.healthy).toBe(false)
  })

  it('both moved is diverged with the merge base', async () => {
    const base = git(local, 'rev-parse', 'HEAD')
    commit(local, 'l1')
    commit(remote, 'r1')
    const pair = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(pair.relation).toMatchObject({ kind: 'diverged', mergeBase: base, aheadCount: 1, behindCount: 1 })
  })

  it('equal tips are same but not healthy while the remote worktree is not read', async () => {
    const pair = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(pair.relation.kind).toBe('same')
    expect(pair.healthy).toBe(false)
  })

  it('a relay without git.replicaBundle is unknown relay-too-old and nothing healthy; control: the capable relay compares', async () => {
    commit(remote, 'r1')
    const old = await pairOf(service(['git.exec'], [localSetup(), sshSetup()]))
    expect(old.relation).toEqual({ kind: 'unknown', reason: 'relay-too-old' })
    expect(old.healthy).toBe(false)
    expect(old.remoteTip).toBeUndefined()
    expect(calls).toEqual(['relay.status'])

    resetSshRelayCapabilityCacheForTests()
    const capable = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(capable.relation.kind).toBe('behind')
  })

  it('keeps each host in its own ref namespace under the anchor', async () => {
    commit(remote, 'r1')
    await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(git(local, 'rev-parse', `refs/orca/replicas/${replicaHostKey('ssh:gex44')}/HEAD`)).toBe(
      git(remote, 'rev-parse', 'HEAD')
    )
  })

  it('a shallow anchor never decides ancestry: unknown shallow; control: the full anchor decides', async () => {
    commit(local, 'second')
    const shallow = join(root, 'shallow')
    git(root, 'clone', '-q', '--depth', '1', `file://${local}`, shallow)
    commit(remote, 'r1')
    const shallowAnchor = setup({ id: 'anchor', hostId: 'local', path: shallow, createdAt: 1 })
    const pair = await pairOf(service(['git.replicaBundle'], [shallowAnchor, sshSetup()]))
    expect(pair.relation).toEqual({ kind: 'unknown', reason: 'shallow' })
    resetSshRelayCapabilityCacheForTests()
    const full = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(full.relation.kind).not.toBe('unknown')
  })

  it('answers not-found for an unknown project and for a setup outside the project', async () => {
    const svc = service(['git.replicaBundle'], [localSetup(), sshSetup()])
    await expect(svc.compare({ projectId: 'nope' })).resolves.toEqual({ status: 'not-found', reason: 'unknown-project' })
    await expect(svc.compare({ projectId: 'p1', setupId: 'nope' })).resolves.toEqual({
      status: 'not-found',
      reason: 'unknown-setup'
    })
    // Control: a setup of the project compares.
    const ok = await svc.compare({ projectId: 'p1', setupId: 'box' })
    expect(ok).toMatchObject({ status: 'ok', pairs: [{ setupId: 'box' }] })
  })
})

describe('replicaHostKey', () => {
  it('matches the ref-safe pattern', () => {
    expect(replicaHostKey('ssh:gex44')).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(replicaHostKey('ssh:we%20ird host/../x')).toMatch(/^[A-Za-z0-9._-]+$/)
  })
})
