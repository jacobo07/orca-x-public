// Test rig for the pair service's sync, divergence and reconcile suites: two real git repos, a fake SSH relay served
// by the real replica handler, and the byte-identity probes the three suites share. Imported by tests only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockDispatcher, type RelayDispatcher } from '../relay/git-handler-test-setup'
import { GitReplicaHandler } from '../relay/git-replica-handler'
import type { ProjectHostSetup } from '../shared/project-types'
import {
  createReplicaPairService,
  type ReplicaPairService,
  type ReplicaPairServiceDeps
} from './replica-pair-service'
import { createReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'
import { resetSshRelayCapabilityCacheForTests } from './ssh/ssh-relay-capabilities'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim()

export function commitFile(cwd: string, name: string, body: string): string {
  writeFileSync(join(cwd, name), body)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-qm', `add ${name}`)
  return git(cwd, 'rev-parse', 'HEAD')
}

export const porcelain = (repo: string): string => git(repo, 'status', '--porcelain=v1', '-uall')

/** Every file outside .git with its content hash, so "the working tree is byte-identical" is a string comparison. */
export function fileHashes(repo: string): string {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') {
        continue
      }
      const full = join(dir, name)
      if (lstatSync(full).isDirectory()) {
        walk(full)
      } else {
        out.push(
          `${full.slice(repo.length)}:${createHash('sha1').update(readFileSync(full)).digest('hex')}`
        )
      }
    }
  }
  walk(repo)
  return out.join('\n')
}

export function plantStash(repo: string): void {
  const stash = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'someone else wip')
  git(repo, 'update-ref', '--create-reflog', '-m', 'On main: someone else wip', 'refs/stash', stash)
}

export function stashState(repo: string): string {
  const sha = (p: string): string =>
    existsSync(p) ? createHash('sha1').update(readFileSync(p)).digest('hex') : 'absent'
  const head = (() => {
    try {
      return git(repo, 'rev-parse', '--verify', '-q', 'refs/stash')
    } catch {
      return 'no-stash'
    }
  })()
  return `${head}|${sha(join(repo, '.git', 'refs', 'stash'))}|${sha(join(repo, '.git', 'logs', 'refs', 'stash'))}`
}

/** HEAD, branch ref, porcelain, file hashes and the planted stash: the state a non-moving operation must leave alone. */
export function anchorState(repo: string): string {
  return [
    git(repo, 'rev-parse', 'HEAD'),
    git(repo, 'symbolic-ref', 'HEAD'),
    git(repo, 'rev-parse', git(repo, 'symbolic-ref', 'HEAD')),
    porcelain(repo),
    fileHashes(repo),
    stashState(repo)
  ].join('\n--\n')
}

export const refNames = (repo: string, prefix: string): string[] =>
  git(repo, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean)

export function setupOf(
  over: Partial<ProjectHostSetup> & Pick<ProjectHostSetup, 'id' | 'hostId' | 'path'>
): ProjectHostSetup {
  return {
    projectId: 'p1',
    repoId: `repo-${over.id}`,
    displayName: over.id,
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

export type MethodTrap = { entered: Promise<void>; release: () => void }

export type PairRig = {
  root: string
  /** The anchor (local) worktree. */
  local: string
  /** The replica on the fake SSH host, reachable only through the relay. */
  remote: string
  setups: ProjectHostSetup[]
  /** Every relay method received, in order. */
  relayLog: string[]
  guard: ReturnType<typeof createReplicaWorktreeMutationGuard>
  /** Mutable: the connection generation the fake SSH layer reports. */
  state: { generation: number; muxAvailable: boolean; failOn: ((method: string) => unknown) | null }
  /** Holds the next relay call of this method until released; `entered` resolves when it is waiting. */
  trap(method: string): MethodTrap
  service(over?: Partial<ReplicaPairServiceDeps>): ReplicaPairService
  dispose(): Promise<void>
}

export function createPairRig(): PairRig {
  resetSshRelayCapabilityCacheForTests()
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
  const root = mkdtempSync(join(tmpdir(), 'orca-pair-rig-'))
  // Why: the bundle scratch directory lands under os.tmpdir(); a private one keeps parallel suites apart.
  const scratch = join(root, 'scratch')
  mkdirSync(scratch)
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = scratch
  const local = join(root, 'local')
  const remote = join(root, 'remote')
  git(root, 'init', '-q', '-b', 'main', local)
  commitFile(local, 'a.txt', 'a\n')
  git(root, 'clone', '-q', local, remote)

  const d = createMockDispatcher()
  const replica = new GitReplicaHandler(d as unknown as RelayDispatcher)
  const relayLog: string[] = []
  const traps = new Map<string, { enter: () => void; gate: Promise<void> }>()
  const state: PairRig['state'] = { generation: 1, muxAvailable: true, failOn: null }

  const request = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    relayLog.push(method)
    if (method === 'relay.status') {
      return { capabilities: ['git.replicaBundle'] }
    }
    const trap = traps.get(method)
    if (trap) {
      traps.delete(method)
      trap.enter()
      await trap.gate
    }
    const failure = state.failOn?.(method)
    if (failure) {
      throw failure
    }
    return d.callRequest(method, params ?? {})
  }

  const rig: PairRig = {
    root,
    local,
    remote,
    relayLog,
    state,
    guard: createReplicaWorktreeMutationGuard(),
    setups: [
      setupOf({ id: 'anchor', hostId: 'local', path: local, createdAt: 1 }),
      setupOf({ id: 'box', hostId: 'ssh:gex44', connectionId: 'gex44', path: remote, createdAt: 2 })
    ],
    trap(method) {
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => (enter = resolve))
      const gate = new Promise<void>((resolve) => (release = resolve))
      // Why: `entered` resolves when the relay call actually arrives, the only honest "the operation is mid-flight".
      traps.set(method, { enter, gate })
      return { entered, release }
    },
    service(over = {}) {
      return createReplicaPairService({
        listProjectHostSetups: () => rig.setups,
        sshSession: {
          getMultiplexer: () =>
            state.muxAvailable ? { isDisposed: () => false, request } : undefined,
          getGeneration: () => state.generation
        },
        readRemoteWorktreeFact: async () => ({ kind: 'clean' }),
        mutationGuard: rig.guard,
        now: () => 7,
        ...over
      })
    },
    async dispose() {
      await replica.dispose()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
  return rig
}
