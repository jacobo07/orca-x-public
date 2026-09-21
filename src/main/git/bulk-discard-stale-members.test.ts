import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findWindowsGitBinDirectory } from '../windows-git-executable-path'
import { bulkDiscardChanges, invalidateGitReadCaches, readWorktreeContentIdentity } from './status'

/**
 * What happens to the other nineteen files when one of the twenty moved.
 *
 * The single-path discard is fenced and the bulk one is not, and "bulk" here is not a corner: it is what
 * the area headers, the multi-select bar and every collapsed directory row in Source Control call. A user
 * selects rows they are looking at and authorizes destroying THOSE states -- so the authorization is per
 * item, and one token for the whole snapshot would make an unrelated row's movement refuse the other
 * nineteen, which is both more annoying and less true.
 *
 * The contract is the one the product already has rather than a new one: the per-file path already
 * completes past a failure, collects what it could not do, and surfaces it. So a member whose content
 * moved is kept back and reported, and the rest are discarded. Not all-or-nothing, which would let one
 * stale row block nineteen safe ones for no gain in safety.
 *
 * Real git, real bytes, real disposable repositories under the OS temp directory. Nothing here may ever
 * run against a real worktree.
 */
const tempRoots: string[] = []

/**
 * Git for Windows is often installed without the PATH option, and a bare `git` then fails with ENOENT --
 * which reads as this suite being broken rather than as a missing binary. The app resolves this at
 * startup; a vitest process does not run that, so borrow the same resolver.
 */
beforeAll(() => {
  const gitBinDirectory = findWindowsGitBinDirectory()
  if (!gitBinDirectory) {
    return
  }
  const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
  process.env[pathKey] = `${gitBinDirectory}${path.delimiter}${process.env[pathKey] ?? ''}`
})

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-bulk-discard-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  // `restore --source=HEAD` writes through the checkout filters, so autocrlf would make assertions about
  // restored content host-dependent. Real behaviour, and exactly why the identity hashes what is on disk
  // -- but noise here.
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

/** What the client observed for each of these paths, the way a status snapshot would have stamped it. */
async function observe(repo: string, relativePaths: string[]): Promise<Map<string, string>> {
  const observed = new Map<string, string>()
  for (const relativePath of relativePaths) {
    observed.set(relativePath, await readWorktreeContentIdentity(repo, relativePath))
  }
  return observed
}

afterEach(async () => {
  invalidateGitReadCaches()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('discarding many paths against the states the caller saw', () => {
  it('keeps back only the member that moved', async () => {
    const repo = await createFixtureRepo()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await write(repo, name, `committed ${name}\n`)
    }
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await write(repo, name, `the edit the user reviewed ${name}\n`)
    }

    const observed = await observe(repo, ['a.txt', 'b.txt', 'c.txt'])
    // One of the three moves after the user looked. The other two did not.
    await write(repo, 'b.txt', 'work that arrived after the user looked\n')

    const result = await bulkDiscardChanges(repo, ['a.txt', 'b.txt', 'c.txt'], {}, observed)

    expect(result.discarded.sort()).toEqual(['a.txt', 'c.txt'])
    expect(result.refused).toEqual(['b.txt'])
    expect(await read(repo, 'a.txt')).toBe('committed a.txt\n')
    expect(await read(repo, 'c.txt')).toBe('committed c.txt\n')
    expect(await read(repo, 'b.txt')).toBe('work that arrived after the user looked\n')
  })

  it('keeps back an untracked member that moved, and deletes the ones that did not', async () => {
    // Untracked discard deletes the file outright, so there is nothing in any object to recover from.
    const repo = await createFixtureRepo()
    await write(repo, 'keep.txt', 'anchor\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    await write(repo, 'new-a.txt', 'draft a\n')
    await write(repo, 'new-b.txt', 'draft b\n')

    const observed = await observe(repo, ['new-a.txt', 'new-b.txt'])
    await write(repo, 'new-b.txt', 'draft b, continued after the user looked\n')

    const result = await bulkDiscardChanges(repo, ['new-a.txt', 'new-b.txt'], {}, observed)

    expect(result.discarded).toEqual(['new-a.txt'])
    expect(result.refused).toEqual(['new-b.txt'])
    expect(await exists(repo, 'new-a.txt')).toBe(false)
    expect(await read(repo, 'new-b.txt')).toBe('draft b, continued after the user looked\n')
  })

  it('discards everything when nothing moved', async () => {
    // The control. A protection that refused everything would satisfy the assertions above.
    const repo = await createFixtureRepo()
    for (const name of ['a.txt', 'b.txt']) {
      await write(repo, name, `committed ${name}\n`)
    }
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    for (const name of ['a.txt', 'b.txt']) {
      await write(repo, name, `the edit the user reviewed ${name}\n`)
    }

    const observed = await observe(repo, ['a.txt', 'b.txt'])
    const result = await bulkDiscardChanges(repo, ['a.txt', 'b.txt'], {}, observed)

    expect(result.discarded.sort()).toEqual(['a.txt', 'b.txt'])
    expect(result.refused).toEqual([])
    expect(await read(repo, 'a.txt')).toBe('committed a.txt\n')
    expect(await read(repo, 'b.txt')).toBe('committed b.txt\n')
  })

  it('refuses the whole call when a path was not described at all', async () => {
    // Partial authorization is the same hole one level up: destroying the unstated paths would be exactly
    // the unprotected operation, performed inside the protected one. A caller error, so it raises rather
    // than reporting a per-file conflict the user cannot act on.
    const repo = await createFixtureRepo()
    for (const name of ['a.txt', 'b.txt']) {
      await write(repo, name, `committed ${name}\n`)
    }
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    for (const name of ['a.txt', 'b.txt']) {
      await write(repo, name, `edited ${name}\n`)
    }

    const observed = await observe(repo, ['a.txt'])

    await expect(bulkDiscardChanges(repo, ['a.txt', 'b.txt'], {}, observed)).rejects.toThrow(
      /b\.txt/
    )
    // Nothing was destroyed, including the path that was properly described.
    expect(await read(repo, 'a.txt')).toBe('edited a.txt\n')
    expect(await read(repo, 'b.txt')).toBe('edited b.txt\n')
  })

  it('keeps back a member whose file became unreadable rather than guessing', async () => {
    // A directory where the caller saw a file: the read cannot prove a match, and the safe answer to
    // "I cannot tell" is never "destroy it".
    const repo = await createFixtureRepo()
    await write(repo, 'a.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    await write(repo, 'a.txt', 'edited\n')
    const observed = await observe(repo, ['a.txt'])
    observed.set('gone.txt', 'sha256:something-the-caller-claims-it-saw')

    const result = await bulkDiscardChanges(repo, ['a.txt', 'gone.txt'], {}, observed)

    expect(result.discarded).toEqual(['a.txt'])
    expect(result.refused).toEqual(['gone.txt'])
  })
})
