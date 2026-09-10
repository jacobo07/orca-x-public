import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findWindowsGitBinDirectory } from '../windows-git-executable-path'
import { getStatus, invalidateGitReadCaches } from './status'

/**
 * What the status payload says about the bytes a discard would destroy.
 *
 * The interesting assertions here are the ones about what the identity can tell apart, because the
 * cheaper candidates cannot. Status hands out HEAD and index oids for free, and the entry already
 * carries added/removed line counts -- all three stay constant across an edit that replaces one line
 * with a different line of the same length, which is precisely the edit that loses work.
 */
const tempRoots: string[] = []

beforeAll(() => {
  const gitBinDirectory = findWindowsGitBinDirectory()
  if (!gitBinDirectory) {
    return
  }
  const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
  process.env[pathKey] = `${gitBinDirectory}${path.delimiter}${process.env[pathKey] ?? ''}`
})

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-status-identity-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  return repo
}

async function write(repo: string, relativePath: string, contents: string): Promise<void> {
  await writeFile(path.join(repo, relativePath), contents)
}

async function identityOf(repo: string, relativePath: string): Promise<string | undefined> {
  invalidateGitReadCaches()
  const status = await getStatus(repo, { worktreeContentIdentity: true })
  return status.entries.find((entry) => entry.path === relativePath)?.worktreeContentId
}

afterEach(async () => {
  invalidateGitReadCaches()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('status can say what a discard would destroy', () => {
  it('stamps changed entries only when the caller asks', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'a.ts', 'committed\n')
    git(repo, ['add', 'a.ts'])
    git(repo, ['commit', '-qm', 'seed'])
    await write(repo, 'a.ts', 'edited\n')

    const withoutAsking = await getStatus(repo)
    invalidateGitReadCaches()
    const asked = await getStatus(repo, { worktreeContentIdentity: true })

    // Absent means "not computed" -- the whole reason the field is optional.
    expect(withoutAsking.entries[0]?.worktreeContentId).toBeUndefined()
    expect(asked.entries[0]?.worktreeContentId).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('changes when the content changes but the index and the line counts do not', async () => {
    // The falsification of the cheap candidates, as an assertion rather than an argument. Both edits
    // are one line replacing one line, staged once and then edited again, so HEAD oid, index oid and
    // added/removed are identical across the pair.
    const repo = await createFixtureRepo()
    await write(repo, 'a.ts', 'one\n')
    git(repo, ['add', 'a.ts'])
    git(repo, ['commit', '-qm', 'seed'])
    await write(repo, 'a.ts', 'two\n')
    git(repo, ['add', 'a.ts'])

    await write(repo, 'a.ts', 'AAA\n')
    invalidateGitReadCaches()
    const first = await getStatus(repo, { worktreeContentIdentity: true })
    const firstEntry = first.entries.find((entry) => entry.area === 'unstaged')

    await write(repo, 'a.ts', 'BBB\n')
    invalidateGitReadCaches()
    const second = await getStatus(repo, { worktreeContentIdentity: true })
    const secondEntry = second.entries.find((entry) => entry.area === 'unstaged')

    expect(firstEntry?.added).toBe(secondEntry?.added)
    expect(firstEntry?.removed).toBe(secondEntry?.removed)
    expect(first.head).toBe(second.head)
    expect(firstEntry?.worktreeContentId).toBeDefined()
    expect(firstEntry?.worktreeContentId).not.toBe(secondEntry?.worktreeContentId)
  })

  it('gives an untracked file an identity too', async () => {
    // Untracked is where a wrong discard is least recoverable, so it must not be the case that
    // falls through: nothing in the object graph describes these bytes.
    const repo = await createFixtureRepo()
    await write(repo, 'scratch.ts', 'never committed\n')

    expect(await identityOf(repo, 'scratch.ts')).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('agrees with itself when nothing changed', async () => {
    // A gate that produced a new value per read would reject every legitimate discard.
    const repo = await createFixtureRepo()
    await write(repo, 'a.ts', 'stable\n')

    expect(await identityOf(repo, 'a.ts')).toBe(await identityOf(repo, 'a.ts'))
  })

  it('reports a tracked deletion as absent rather than omitting it', async () => {
    // Absent is a state a user can have observed and authorized discarding. Collapsing it into
    // "no identity" would leave the deleted-and-recreated case unprotected.
    const repo = await createFixtureRepo()
    await write(repo, 'a.ts', 'committed\n')
    git(repo, ['add', 'a.ts'])
    git(repo, ['commit', '-qm', 'seed'])
    await rm(path.join(repo, 'a.ts'))

    expect(await identityOf(repo, 'a.ts')).toBe('absent')
  })
})
