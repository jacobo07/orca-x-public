import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findWindowsGitBinDirectory } from '../windows-git-executable-path'
import { invalidateGitReadCaches, readWorktreeContentIdentity } from '../git/status'
import { RuntimeGitCommands } from './orca-runtime-git'
import { RpcDispatcher } from './rpc/dispatcher'
import { GIT_METHODS } from './rpc/methods/git'
import type { OrcaRuntimeService } from './orca-runtime'

/**
 * The discard contract as a paired client actually reaches it: through the RPC dispatcher, into the
 * runtime git commands, onto a real repository's disk.
 *
 * The host primitive is proved elsewhere (`git/discard-stale-worktree-state.test.ts`). What that
 * file cannot tell us is whether the product can reach it -- an enforcement no request can carry is
 * a defect wearing the costume of a feature. So this suite deliberately starts one layer above the
 * primitive and uses no mock for anything below the dispatcher.
 *
 * Every repository here is created under the OS temp directory by these tests and removed
 * afterwards. Nothing may ever run against a real worktree.
 */
const tempRoots: string[] = []

beforeAll(() => {
  // Git for Windows is commonly installed without the PATH option; the app fixes this at startup and
  // a vitest process does not run that. Borrow the app's own resolver rather than an install path.
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
  const root = await mkdtemp(path.join(tmpdir(), 'orca-discard-rpc-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  // Restore writes through the checkout filters, so autocrlf would make restored bytes
  // host-dependent. That is real behaviour -- and exactly why the identity hashes on-disk bytes --
  // but it is noise in these assertions.
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

/**
 * The real dispatcher and the real runtime git commands, over a real worktree.
 *
 * Only the two host lookups are supplied: which worktree a selector names, and the settings bag the
 * AI paths read. Nothing on the discard path is stubbed.
 */
function dispatcherForRepo(repo: string): RpcDispatcher {
  const commands = new RuntimeGitCommands({
    resolveRuntimeGitTarget: async () =>
      ({ worktree: { id: 'wt-1', path: repo, git: {} } }) as never,
    getRuntimeSettings: () => ({}) as never
  })
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    discardRuntimeGitPath: commands.discardRuntimeGitPath.bind(commands)
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: GIT_METHODS })
}

function discardRequest(params: Record<string, unknown>) {
  return { id: 'req-1', authToken: 'tok', method: 'git.discard', params }
}

afterEach(async () => {
  invalidateGitReadCaches()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('a client can only discard the state it says it saw', () => {
  it('refuses a tracked discard whose stated state is no longer on disk', async () => {
    // Arrange: the client reads the file, and the world moves on afterwards. The second edit is the
    // work at risk -- it exists nowhere but the working tree.
    const repo = await createFixtureRepo()
    await write(repo, 'notes.ts', 'committed\n')
    git(repo, ['add', 'notes.ts'])
    git(repo, ['commit', '-qm', 'seed'])
    await write(repo, 'notes.ts', 'what the client saw\n')
    const observed = await readWorktreeContentIdentity(repo, 'notes.ts')
    await write(repo, 'notes.ts', 'work done after the client looked away\n')

    // Act
    const response = await dispatcherForRepo(repo).dispatch(
      discardRequest({ worktree: 'id:wt-1', filePath: 'notes.ts', expectedContent: observed })
    )

    // Assert: the newer work survives, and the caller is told why rather than being told nothing.
    expect(await read(repo, 'notes.ts')).toBe('work done after the client looked away\n')
    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).toContain('stale_worktree_state')
  })

  it('refuses to delete an untracked file that is no longer the one the client saw', async () => {
    // Arrange: untracked is the harder half -- the bytes are in no object anywhere, so a wrong
    // deletion is unrecoverable by any means.
    const repo = await createFixtureRepo()
    await write(repo, 'scratch.ts', 'draft the client saw\n')
    const observed = await readWorktreeContentIdentity(repo, 'scratch.ts')
    await write(repo, 'scratch.ts', 'draft rewritten since\n')

    // Act
    const response = await dispatcherForRepo(repo).dispatch(
      discardRequest({ worktree: 'id:wt-1', filePath: 'scratch.ts', expectedContent: observed })
    )

    // Assert
    expect(await exists(repo, 'scratch.ts')).toBe(true)
    expect(await read(repo, 'scratch.ts')).toBe('draft rewritten since\n')
    expect(response).toMatchObject({ ok: false })
  })

  it('applies a discard whose stated state is still the one on disk', async () => {
    // The gate is only worth having if it lets the ordinary case through: a client acting on fresh
    // information must not meet a conflict.
    const repo = await createFixtureRepo()
    await write(repo, 'notes.ts', 'committed\n')
    git(repo, ['add', 'notes.ts'])
    git(repo, ['commit', '-qm', 'seed'])
    await write(repo, 'notes.ts', 'unsaved edit\n')
    const observed = await readWorktreeContentIdentity(repo, 'notes.ts')

    const response = await dispatcherForRepo(repo).dispatch(
      discardRequest({ worktree: 'id:wt-1', filePath: 'notes.ts', expectedContent: observed })
    )

    expect(response).toMatchObject({ ok: true })
    expect(await read(repo, 'notes.ts')).toBe('committed\n')
  })

  it('does not destroy an edit made after a lost response, when the client retries', async () => {
    // The race the precondition exists for. The first discard applied; its response never arrived;
    // the user typed something new; the client retried the request it still holds. "Discard is
    // idempotent" is true of the operation and false of the world.
    const repo = await createFixtureRepo()
    await write(repo, 'notes.ts', 'committed\n')
    git(repo, ['add', 'notes.ts'])
    git(repo, ['commit', '-qm', 'seed'])
    await write(repo, 'notes.ts', 'first edit\n')
    const observed = await readWorktreeContentIdentity(repo, 'notes.ts')
    const dispatcher = dispatcherForRepo(repo)
    const request = discardRequest({
      worktree: 'id:wt-1',
      filePath: 'notes.ts',
      expectedContent: observed
    })

    // Act: first application succeeds, the response is lost, new work appears, the old request is
    // replayed verbatim.
    expect(await dispatcher.dispatch(request)).toMatchObject({ ok: true })
    await write(repo, 'notes.ts', 'work created after the first discard\n')
    const retry = await dispatcher.dispatch(request)

    // Assert
    expect(await read(repo, 'notes.ts')).toBe('work created after the first discard\n')
    expect(retry).toMatchObject({ ok: false })
  })

  it('protects a tracked deletion the client saw from a file someone recreated since', async () => {
    // Discard of a tracked deletion RESTORES from HEAD, so the stale case overwrites rather than
    // deletes -- a shape a modified-file-only reading of this feature would have missed entirely.
    const repo = await createFixtureRepo()
    await write(repo, 'notes.ts', 'committed\n')
    git(repo, ['add', 'notes.ts'])
    git(repo, ['commit', '-qm', 'seed'])
    await rm(path.join(repo, 'notes.ts'))
    const observed = await readWorktreeContentIdentity(repo, 'notes.ts')
    await write(repo, 'notes.ts', 'recreated with new content\n')

    const response = await dispatcherForRepo(repo).dispatch(
      discardRequest({ worktree: 'id:wt-1', filePath: 'notes.ts', expectedContent: observed })
    )

    expect(await read(repo, 'notes.ts')).toBe('recreated with new content\n')
    expect(response).toMatchObject({ ok: false })
  })

  it('still discards when the caller states nothing, which is what an old client sends', async () => {
    // Not an endorsement -- a record. This is the mixed-version position at the host: a request with
    // no stated observation carries no authorization to protect, and the policy that governs it is
    // negotiated above this layer. Pinned so a change to it has to be deliberate.
    const repo = await createFixtureRepo()
    await write(repo, 'notes.ts', 'committed\n')
    git(repo, ['add', 'notes.ts'])
    git(repo, ['commit', '-qm', 'seed'])
    await write(repo, 'notes.ts', 'newer work\n')

    const response = await dispatcherForRepo(repo).dispatch(
      discardRequest({ worktree: 'id:wt-1', filePath: 'notes.ts' })
    )

    expect(response).toMatchObject({ ok: true })
    expect(await read(repo, 'notes.ts')).toBe('committed\n')
  })
})
