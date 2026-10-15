import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCapsule } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'
import { readLocalReplicaFacts } from './replica-local-facts'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim()

let root: string
let repo: string
const ids = { setupId: 's1', hostId: 'local' }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-'))
  repo = join(root, 'repo')
  git(root, 'init', '-q', '-b', 'main', repo)
  git(repo, 'commit', '--allow-empty', '-qm', 'base')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('readLocalReplicaFacts', () => {
  it('a repo with commits is a commit tip on the current branch with a clean worktree', async () => {
    const read = await readLocalReplicaFacts({ ...ids, path: repo })
    expect(read.shallow).toBe(false)
    expect(read.facts).toEqual({
      setupId: 's1',
      hostId: 'local',
      tip: { kind: 'commit', sha: git(repo, 'rev-parse', 'HEAD'), ref: 'refs/heads/main' },
      worktree: { kind: 'clean' }
    })
  })

  it('a detached HEAD is a detached tip', async () => {
    git(repo, 'checkout', '-q', '--detach')
    const read = await readLocalReplicaFacts({ ...ids, path: repo })
    expect(read.facts).toMatchObject({ tip: { kind: 'detached', sha: git(repo, 'rev-parse', 'HEAD') } })
  })

  it('a repo with no commit is unborn', async () => {
    const empty = join(root, 'empty')
    git(root, 'init', '-q', '-b', 'main', empty)
    const read = await readLocalReplicaFacts({ ...ids, path: empty })
    expect(read.facts).toMatchObject({ tip: { kind: 'unborn' } })
  })

  it('a path that is not a repo is a tip unknown with reason not-a-git-repo', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const read = await readLocalReplicaFacts({ ...ids, path: plain })
    expect(read.facts).toMatchObject({ tip: { kind: 'unknown', reason: 'not-a-git-repo' } })
  })

  it('a folder setup is the folder fact and runs no git', async () => {
    const read = await readLocalReplicaFacts({ ...ids, path: join(root, 'does-not-exist'), kind: 'folder' })
    expect(read.facts).toEqual({ kind: 'folder' })
  })

  it('a shallow clone is flagged and never read as complete history', async () => {
    git(repo, 'commit', '--allow-empty', '-qm', 'second')
    const shallow = join(root, 'shallow')
    git(root, 'clone', '-q', '--depth', '1', `file://${repo}`, shallow)
    const read = await readLocalReplicaFacts({ ...ids, path: shallow })
    expect(read.shallow).toBe(true)
    // Control: the full repo it was cloned from is not shallow.
    expect((await readLocalReplicaFacts({ ...ids, path: repo })).shallow).toBe(false)
  })

  it('the worktree fact follows the porcelain: an extra untracked file changes only that count', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a')
    const one = await readLocalReplicaFacts({ ...ids, path: repo })
    writeFileSync(join(repo, 'b.txt'), 'b')
    const two = await readLocalReplicaFacts({ ...ids, path: repo })
    expect(one.facts).toMatchObject({ worktree: { kind: 'dirty', untracked: 1, staged: 0 } })
    expect(two.facts).toMatchObject({ worktree: { kind: 'dirty', untracked: 2, staged: 0 } })
  })

  it('carries a present capsule that was taken at the current tip', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'x')
    const made = await createCapsule(localCapsuleGit, repo)
    expect(made.kind).toBe('created')
    const read = await readLocalReplicaFacts({ ...ids, path: repo })
    expect(read.facts).toMatchObject({
      capsule: { kind: 'present', baseTip: git(repo, 'rev-parse', 'HEAD'), partial: false }
    })
    // Control: no capsule, no capsule fact.
    const bare = join(root, 'bare')
    git(root, 'init', '-q', '-b', 'main', bare)
    git(bare, 'commit', '--allow-empty', '-qm', 'b')
    expect((await readLocalReplicaFacts({ ...ids, path: bare })).facts).not.toHaveProperty('capsule')
  })
})
