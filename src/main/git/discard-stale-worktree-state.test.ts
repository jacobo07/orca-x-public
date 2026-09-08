import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findWindowsGitBinDirectory } from '../windows-git-executable-path'
import {
  discardChanges,
  invalidateGitReadCaches,
  readWorktreeContentIdentity,
  StaleWorktreeStateError
} from './status'

/**
 * Discard is the one repository mutation a paired client can reach whose stale case is
 * unrecoverable.
 *
 * Everything else it can do is undoable from the object graph: a bad commit is still a commit, a
 * rewritten branch is still in the reflog, a removed worktree keeps its branch. Uncommitted bytes
 * are in none of those places. So the question this file asks is the one the request could not
 * previously answer -- what did the user believe they were destroying -- and it asks it against
 * real git, because the failure is in what ends up on disk, not in what a mock was told.
 *
 * Every fixture below is a repository this test created under the OS temp directory and deletes
 * afterwards. Nothing here may ever run against a real worktree.
 */
const tempRoots: string[] = []

/**
 * Git for Windows is often installed without the PATH option, and a bare `git` then fails with
 * ENOENT -- which reads as this suite being broken rather than as a missing binary. The app already
 * solves that at startup; a vitest process does not run that, so borrow the same resolver rather
 * than hardcoding an install path. It has to be the process PATH, because both the fixture commands
 * below and the code under test spawn a bare `git`.
 */
beforeAll(() => {
  const gitBinDirectory = findWindowsGitBinDirectory()
  if (!gitBinDirectory) {
    return
  }
  const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
  process.env[pathKey] = `${gitBinDirectory}${path.delimiter}${process.env[pathKey] ?? ''}`
})

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-discard-stale-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  // Why the fixture pins this: `restore --source=HEAD` writes through the checkout filters, so on a
  // Windows host with autocrlf the bytes that land differ from the bytes committed. That is real
  // behaviour and exactly why the identity below hashes what is ON DISK rather than any git oid --
  // but it would make these assertions about restored content host-dependent, which is noise.
  git(repo, ['config', 'core.autocrlf', 'false'])
  return repo
}

async function write(repo: string, relativePath: string, contents: string): Promise<void> {
  await writeFile(path.join(repo, relativePath), contents)
}

async function read(repo: string, relativePath: string): Promise<string> {
  return readFile(path.join(repo, relativePath), 'utf8')
}

async function exists(repo: string, relativePath: string): Promise<boolean> {
  try {
    await readFile(path.join(repo, relativePath))
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  invalidateGitReadCaches()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('discarding a tracked file against the state the caller saw', () => {
  it('refuses when the file changed after the caller looked at it', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    // What the client rendered, and what the user chose to throw away.
    await write(repo, 'a.txt', 'the edit the user reviewed\n')
    const observed = await readWorktreeContentIdentity(repo, 'a.txt')

    // Somebody else moved on: a desktop window, another editor, a formatter on save.
    await write(repo, 'a.txt', 'work that arrived after the phone last looked\n')

    await expect(discardChanges(repo, 'a.txt', {}, { expectedContent: observed })).rejects.toThrow(
      StaleWorktreeStateError
    )
    // The point of the whole exercise: the newer work is still there.
    expect(await read(repo, 'a.txt')).toBe('work that arrived after the phone last looked\n')
  })

  it('discards when the file is still what the caller saw', async () => {
    // The control that stops "refuse everything" from passing as safety. A discard that cannot
    // discard is not a fixed feature, it is a removed one.
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    await write(repo, 'a.txt', 'a mistake\n')
    const observed = await readWorktreeContentIdentity(repo, 'a.txt')

    await discardChanges(repo, 'a.txt', {}, { expectedContent: observed })
    expect(await read(repo, 'a.txt')).toBe('committed\n')
  })

  it('still discards for a caller that names no expectation', async () => {
    // The in-process desktop caller acts on state it is currently rendering, so it is not the stale
    // observer this guards against. Requiring the token everywhere would break it for no safety.
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    await write(repo, 'a.txt', 'a mistake\n')

    await discardChanges(repo, 'a.txt')
    expect(await read(repo, 'a.txt')).toBe('committed\n')
  })

  it('destroys newer work when nobody names an expectation', async () => {
    /**
     * The defect itself, kept as a test rather than as a memory of one.
     *
     * This is what every discard did before the precondition existed, and what one still does when
     * the caller supplies nothing: the bytes are replaced with HEAD regardless of when the caller
     * last looked. Worth pinning because it is also the mixed-version position -- a request with no
     * expectation gets exactly this -- which is why the RPC layer has to REQUIRE the token from a
     * client capable of sending one, rather than treat it as a nicety.
     */
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    await write(repo, 'a.txt', 'the edit the user reviewed\n')
    await write(repo, 'a.txt', 'work that arrived after the phone last looked\n')

    await discardChanges(repo, 'a.txt')
    expect(await read(repo, 'a.txt')).toBe('committed\n')
  })

  it('does not care who changed the file, only that it changed', async () => {
    // Protection tied to Orca's own event graph would miss an edit made by any other program on the
    // machine. This one is made behind Orca's back entirely.
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    await write(repo, 'a.txt', 'observed\n')
    const observed = await readWorktreeContentIdentity(repo, 'a.txt')
    execFileSync(process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'a.txt'))}, 'edited by something else\\n')`
    ])

    await expect(discardChanges(repo, 'a.txt', {}, { expectedContent: observed })).rejects.toThrow(
      StaleWorktreeStateError
    )
    expect(await read(repo, 'a.txt')).toBe('edited by something else\n')
  })

  it('accepts a rewrite that lands on the same bytes', async () => {
    // Identity is over content, not over events. A file saved twice with the same result is the
    // state the user authorized destroying, and refusing here would be a false conflict.
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    await write(repo, 'a.txt', 'a mistake\n')
    const observed = await readWorktreeContentIdentity(repo, 'a.txt')
    await write(repo, 'a.txt', 'a mistake\n')

    await discardChanges(repo, 'a.txt', {}, { expectedContent: observed })
    expect(await read(repo, 'a.txt')).toBe('committed\n')
  })
})

describe('discarding an untracked file', () => {
  it('refuses when the file changed after the caller looked at it', async () => {
    // The worst case in the whole matrix: an untracked file exists nowhere but the working tree, so
    // a wrong discard here is not recoverable from anything.
    const repo = await createFixtureRepo()
    await write(repo, 'seed.txt', 'seed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    await write(repo, 'notes.txt', 'a scratch file the user saw\n')
    const observed = await readWorktreeContentIdentity(repo, 'notes.txt')
    await write(repo, 'notes.txt', 'an hour of writing that arrived later\n')

    await expect(
      discardChanges(repo, 'notes.txt', {}, { expectedContent: observed })
    ).rejects.toThrow(StaleWorktreeStateError)
    expect(await read(repo, 'notes.txt')).toBe('an hour of writing that arrived later\n')
  })

  it('deletes an untracked file the caller did see', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'seed.txt', 'seed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    await write(repo, 'notes.txt', 'delete me\n')
    const observed = await readWorktreeContentIdentity(repo, 'notes.txt')

    await discardChanges(repo, 'notes.txt', {}, { expectedContent: observed })
    expect(await exists(repo, 'notes.txt')).toBe(false)
  })
})

describe('a discard whose response never arrived', () => {
  it('cannot destroy work created after the first attempt succeeded', async () => {
    /**
     * The sequence generic idempotency gets wrong. The first discard really did apply; only the
     * reply was lost. By the time the client retries, the path holds something new -- and a retry
     * keyed on "same operation id, so replay it" would delete it. The authorization was for the
     * bytes the user reviewed, and those are gone, so the retry has nothing left to authorize.
     */
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])

    await write(repo, 'a.txt', 'the mistake\n')
    const observed = await readWorktreeContentIdentity(repo, 'a.txt')

    await discardChanges(repo, 'a.txt', {}, { expectedContent: observed })
    expect(await read(repo, 'a.txt')).toBe('committed\n')

    // The user starts fresh work at the same path while the client is still retrying.
    await write(repo, 'a.txt', 'new work, typed after the discard landed\n')

    await expect(discardChanges(repo, 'a.txt', {}, { expectedContent: observed })).rejects.toThrow(
      StaleWorktreeStateError
    )
    expect(await read(repo, 'a.txt')).toBe('new work, typed after the discard landed\n')
  })
})

describe('the identity itself', () => {
  it('distinguishes two different contents at the same path', async () => {
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'one\n')
    const first = await readWorktreeContentIdentity(repo, 'a.txt')
    await write(repo, 'a.txt', 'two\n')
    const second = await readWorktreeContentIdentity(repo, 'a.txt')

    expect(first).not.toBe(second)
    // Positive control: an identity function that returned a constant would pass every refusal
    // test above by refusing nothing, and every acceptance test by accepting everything.
    expect(first).toBeTruthy()
  })

  it('gives an absent file its own identity rather than failing', async () => {
    // A file the caller saw as already deleted is a real state to authorize against, and it must
    // not collide with any content.
    const repo = await createFixtureRepo()
    const absent = await readWorktreeContentIdentity(repo, 'never-existed.txt')
    await write(repo, 'a.txt', '')
    const empty = await readWorktreeContentIdentity(repo, 'a.txt')

    expect(absent).toBeTruthy()
    expect(absent).not.toBe(empty)
  })

  it('refuses a path outside the worktree', async () => {
    const repo = await createFixtureRepo()
    await expect(readWorktreeContentIdentity(repo, '../escape.txt')).rejects.toThrow()
  })
})
