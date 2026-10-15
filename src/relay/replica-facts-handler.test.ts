import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMockDispatcher, type MockDispatcher } from './git-handler-test-setup'
import type { RelayDispatcher } from './dispatcher'
import { ReplicaFactsHandler, SYNC_RELAY_CAPABILITIES } from './replica-facts-handler'

const g = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString()

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).sort()
}

describe('ReplicaFactsHandler', () => {
  let repo: string
  let d: MockDispatcher
  const facts = (repoPath: unknown): Promise<unknown> =>
    d.callRequest('sync.replicaFacts', { repoPath })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'replica-facts-'))
    g(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a'), 'a')
    writeFileSync(join(repo, 'b'), 'b')
    g(repo, 'add', '.')
    g(repo, 'commit', '-qm', 'one')
    d = createMockDispatcher()
    void new ReplicaFactsHandler(d as unknown as RelayDispatcher)
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('advertises exactly sync.v1', () => {
    expect([...SYNC_RELAY_CAPABILITIES]).toEqual(['sync.v1'])
  })

  it('relay.status advertises sync.v1 once, beside the replica bundle capability', () => {
    const relay = readFileSync(join(__dirname, 'relay.ts'), 'utf8')
    const status = relay.slice(relay.indexOf("onRequest('relay.status'"))
    const list = status.slice(0, status.indexOf('],'))
    expect(list.match(/\.\.\.SYNC_RELAY_CAPABILITIES/g)).toHaveLength(1)
    expect(list).toContain('...REPLICA_BUNDLE_RELAY_CAPABILITIES')
    expect(relay).toContain('new ReplicaFactsHandler(dispatcher)')
  })

  it('reads a clean repository as clean', async () => {
    expect(await facts(repo)).toEqual({ worktree: { kind: 'clean' } })
  })

  it('counts staged, unstaged, untracked and unmerged paths', async () => {
    // Unmerged: two branches editing the same line.
    g(repo, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(repo, 'b'), 'side')
    g(repo, 'commit', '-qam', 'side')
    g(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'b'), 'main')
    g(repo, 'commit', '-qam', 'main')
    expect(() => g(repo, 'merge', 'side')).toThrow()
    writeFileSync(join(repo, 'a'), 'edited-unstaged')
    writeFileSync(join(repo, 'staged'), 's')
    g(repo, 'add', 'staged')
    writeFileSync(join(repo, 'untracked'), 'u')
    expect(await facts(repo)).toEqual({
      worktree: { kind: 'dirty', staged: 1, unstaged: 1, untracked: 1, unmerged: 1 }
    })
  })

  it('control: a repository with the extra files removed reads clean again', async () => {
    writeFileSync(join(repo, 'untracked'), 'u')
    expect(await facts(repo)).toMatchObject({ worktree: { kind: 'dirty', untracked: 1 } })
    rmSync(join(repo, 'untracked'))
    expect(await facts(repo)).toEqual({ worktree: { kind: 'clean' } })
  })

  it('reads a directory that is not a repository as unknown not-a-git-repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'replica-facts-plain-'))
    try {
      expect(await facts(plain)).toEqual({
        worktree: { kind: 'unknown', reason: 'not-a-git-repo' }
      })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it.each([['relative/path'], [''], [undefined], [42], [null]])(
    'rejects repoPath %j',
    async (value) => {
      await expect(facts(value)).rejects.toThrow('replica: repoPath must be an absolute path')
    }
  )

  it('does not write to the repository: index bytes and the .git listing are unchanged', async () => {
    // A touched-but-identical file makes the index stat data stale, so a refresh would rewrite it.
    writeFileSync(join(repo, 'a'), 'a')
    const future = new Date(Date.now() + 5_000)
    execFileSync('touch', ['-d', future.toISOString(), join(repo, 'a')])
    const gitDir = join(repo, '.git')
    const indexBefore = readFileSync(join(gitDir, 'index'))
    const listBefore = listFiles(gitDir)
    expect(await facts(repo)).toEqual({ worktree: { kind: 'clean' } })
    expect(readFileSync(join(gitDir, 'index')).equals(indexBefore)).toBe(true)
    expect(listFiles(gitDir)).toEqual(listBefore)
    expect(existsSync(join(gitDir, 'index.lock'))).toBe(false)
  })

  it('reads output beyond the buffer cap as unknown, never a truncated clean', async () => {
    for (let i = 0; i < 400; i++) {
      writeFileSync(join(repo, `untracked-${'x'.repeat(240)}-${i}`), '')
    }
    d = createMockDispatcher()
    void new ReplicaFactsHandler(d as unknown as RelayDispatcher, { maxStatusBytes: 1024 })
    expect(await facts(repo)).toEqual({
      worktree: { kind: 'unknown', reason: 'status-output-too-large' }
    })
  })
})
