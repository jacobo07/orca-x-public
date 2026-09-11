import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findWindowsGitBinDirectory } from '../windows-git-executable-path'
import { gitExecFileAsync } from './runner'
import {
  bulkDiscardChanges,
  discardChanges,
  invalidateGitReadCaches,
  readWorktreeContentIdentity
} from './status'

/**
 * What a second writer can do AFTER the precondition passed and BEFORE the bytes disappear.
 *
 * `discard-precondition-ordering.test.ts` proves the other half: a write landing before the check is
 * refused. That is a claim about the past. This is a claim about the interval -- the world can change
 * while you act, and a precondition that was correct when it ran says nothing about what happened
 * after it.
 *
 * Probability is not evidence, so the interleaving is positioned rather than hoped for: the git
 * subprocess boundary is the barrier, and the competing write happens there and then CALLS THROUGH to
 * the real git. Doubling the destruction would leave nothing to inspect, which is the whole question.
 * Because the destructive subcommand only runs when the precondition passed, its invocation is itself
 * proof that the writer landed strictly after validation -- a causal ordering, not a timestamp.
 *
 * Real git, real bytes, disposable repositories under the OS temp directory. Verdicts come from
 * reading the file; status is not evidence about content.
 */
vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runner')>()),
  gitExecFileAsync: vi.fn()
}))

const execMock = vi.mocked(gitExecFileAsync)
const tempRoots: string[] = []
let realExec: typeof gitExecFileAsync

/** Ordered causal log. Proves which phase the writer actually reached, and that it was not serialized. */
let events: string[] = []

beforeAll(async () => {
  const gitBinDirectory = findWindowsGitBinDirectory()
  if (gitBinDirectory) {
    const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
    process.env[pathKey] = `${gitBinDirectory}${path.delimiter}${process.env[pathKey] ?? ''}`
  }
  realExec = (await vi.importActual<typeof import('./runner')>('./runner')).gitExecFileAsync
})

afterEach(async () => {
  invalidateGitReadCaches()
  execMock.mockReset()
  events = []
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-discard-race-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  // autocrlf would make restored content host-dependent; real behaviour, noise here.
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

async function observe(repo: string, relativePaths: string[]): Promise<Map<string, string>> {
  const observed = new Map<string, string>()
  for (const relativePath of relativePaths) {
    observed.set(relativePath, await readWorktreeContentIdentity(repo, relativePath))
  }
  return observed
}

/**
 * Run the real git, logging each invocation, and let `onSubcommand` write into a chosen interval first.
 *
 * The writer runs BEFORE the call-through, so its bytes are on disk by the time the destructive process
 * starts -- the strongest form of the claim: not "a write raced", but "a write had already completed".
 */
function passThroughWithBarrier(
  onSubcommand?: (subcommand: string) => Promise<void>
): void {
  execMock.mockImplementation(async (args: string[], options) => {
    const subcommand = args[0] ?? ''
    if (onSubcommand) {
      await onSubcommand(subcommand)
    }
    events.push(`git:${subcommand}:start`)
    const result = await realExec(args, options)
    events.push(`git:${subcommand}:end`)
    return result
  })
}

function indexOfEvent(name: string): number {
  return events.indexOf(name)
}

describe('a second writer inside the validate-to-effect interval', () => {
  it('loses its bytes when it lands inside the destructive subprocess window for one tracked file', async () => {
    // Characterization, deliberately: the window is a child-process spawn, and no precondition can be
    // atomic against an uncooperative writer on a plain filesystem. What is worth pinning is that the
    // window contains NOTHING BUT the destructive call -- every probe and check stays above validation.
    const repo = await createFixtureRepo()
    await write(repo, 'note.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    await write(repo, 'note.txt', 'the edit the user reviewed\n')
    const observed = await observe(repo, ['note.txt'])

    let bytesOnDiskWhenEffectBegan = ''
    passThroughWithBarrier(async (subcommand) => {
      if (subcommand !== 'restore') {
        return
      }
      await write(repo, 'note.txt', 'work that arrived while the discard was running\n')
      // Positive control: the barrier really placed the writer here, and its write completed.
      bytesOnDiskWhenEffectBegan = await read(repo, 'note.txt')
      events.push('writer:wrote')
    })

    // Resolving at all proves the precondition passed, so the writer landed strictly after validation.
    await expect(
      discardChanges(repo, 'note.txt', {}, { expectedContent: observed.get('note.txt') })
    ).resolves.toBeUndefined()

    expect(bytesOnDiskWhenEffectBegan).toBe('work that arrived while the discard was running\n')
    // No false serialization: the write completed before the destructive process started.
    expect(indexOfEvent('writer:wrote')).toBeGreaterThanOrEqual(0)
    expect(indexOfEvent('writer:wrote')).toBeLessThan(indexOfEvent('git:restore:start'))
    // The measured residue: those bytes are gone.
    expect(await read(repo, 'note.txt')).toBe('committed\n')
    // The bound that IS enforceable, and the regression that matters: only the destruction sits in the
    // interval. A probe or a containment check creeping back below the precondition fails here.
    const subcommands = execMock.mock.calls.map(([args]) => args[0] ?? '')
    expect(subcommands).toEqual(['ls-files', 'restore'])
  })

  it('discards normally through the same barrier when nothing writes', async () => {
    // The control that makes the case above mean something: a harness that had broken the destruction
    // would leave the newer bytes in place and read exactly like a protection working.
    const repo = await createFixtureRepo()
    await write(repo, 'note.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    await write(repo, 'note.txt', 'the edit the user reviewed\n')
    const observed = await observe(repo, ['note.txt'])

    passThroughWithBarrier()

    await expect(
      discardChanges(repo, 'note.txt', {}, { expectedContent: observed.get('note.txt') })
    ).resolves.toBeUndefined()
    expect(await read(repo, 'note.txt')).toBe('committed\n')
  })

  it('leaves bytes written after the effect alone', async () => {
    // The third phase. A write landing after destruction is the new post-operation state, not a loss.
    const repo = await createFixtureRepo()
    await write(repo, 'note.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    await write(repo, 'note.txt', 'the edit the user reviewed\n')
    const observed = await observe(repo, ['note.txt'])

    passThroughWithBarrier()
    await discardChanges(repo, 'note.txt', {}, { expectedContent: observed.get('note.txt') })
    await write(repo, 'note.txt', 'written after the discard finished\n')

    expect(await read(repo, 'note.txt')).toBe('written after the discard finished\n')
  })
})

describe('a second writer between two members of one bulk discard', () => {
  it('keeps back an untracked member that moved while the tracked members were being destroyed', async () => {
    // The interval nobody was watching. Bulk authorizes every member in ONE pass, then destroys in
    // groups: tracked restore first, untracked deletion last. So an untracked member's authorization is
    // already minutes -- or one whole tracked restore -- old when its own destruction runs, and the code
    // re-checks PATH SAFETY at that point without re-checking STATE AUTHORIZATION.
    //
    // Untracked deletion is the worst place for it: there is no object to recover from.
    const repo = await createFixtureRepo()
    await write(repo, 'tracked.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    await write(repo, 'tracked.txt', 'the tracked edit the user reviewed\n')
    await write(repo, 'untracked.txt', 'the draft the user reviewed\n')
    const observed = await observe(repo, ['tracked.txt', 'untracked.txt'])

    passThroughWithBarrier(async (subcommand) => {
      if (subcommand !== 'restore') {
        return
      }
      // Lands after every member was authorized, and after the tracked group's destruction began.
      await write(repo, 'untracked.txt', 'work that arrived mid-discard\n')
      events.push('writer:wrote')
    })

    const result = await bulkDiscardChanges(
      repo,
      ['tracked.txt', 'untracked.txt'],
      {},
      observed
    )

    // No false serialization: the competing write completed before the deletion ran.
    expect(indexOfEvent('writer:wrote')).toBeLessThan(indexOfEvent('git:clean:start'))
    expect(result.discarded).toEqual(['tracked.txt'])
    expect(result.refused).toEqual(['untracked.txt'])
    expect(await read(repo, 'tracked.txt')).toBe('committed\n')
    expect(await read(repo, 'untracked.txt')).toBe('work that arrived mid-discard\n')
  })

  it('destroys both members when nothing writes during the discard', async () => {
    // The negative control for the case above: with nothing moved the whole selection still goes, so
    // "refuses the untracked member" cannot pass by refusing everything.
    const repo = await createFixtureRepo()
    await write(repo, 'tracked.txt', 'committed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    await write(repo, 'tracked.txt', 'the tracked edit the user reviewed\n')
    await write(repo, 'untracked.txt', 'the draft the user reviewed\n')
    const observed = await observe(repo, ['tracked.txt', 'untracked.txt'])

    passThroughWithBarrier()

    const result = await bulkDiscardChanges(repo, ['tracked.txt', 'untracked.txt'], {}, observed)

    expect(result.discarded.sort()).toEqual(['tracked.txt', 'untracked.txt'])
    expect(result.refused).toEqual([])
    expect(await read(repo, 'tracked.txt')).toBe('committed\n')
    expect(await exists(repo, 'untracked.txt')).toBe(false)
  })
})
