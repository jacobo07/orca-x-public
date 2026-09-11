// @vitest-environment happy-dom

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { discardChanges, getStatus, invalidateGitReadCaches } from '../../../../../../main/git/status'
import { findWindowsGitBinDirectory } from '../../../../../../main/windows-git-executable-path'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

/**
 * Can the desktop user authorize a discard against state A and have it destroy newer state B?
 *
 * The mobile answer was yes, and the fix was a precondition the host checks. The desktop was left out
 * of that with the argument that it is local -- same machine, same process tree, low latency. This
 * file exists because that argument is about transport and the question is about time. There are three
 * windows between what the user saw and what git destroys, and the middle one is a modal waiting on a
 * human, which no amount of locality shortens.
 *
 * So the producer of state B here is the filesystem itself, written to directly, outside every store,
 * cache, watcher and editor buffer Orca owns. That is the case a local client cannot design away: an
 * external editor, a formatter on save, a build step, an agent session, a second Orca window.
 *
 * What is real: the two Source Control hooks the UI actually composes, a git repository this test
 * created, the main-process discard, and the bytes on disk afterwards. What is replaced: the IPC hop,
 * whose job is to carry the arguments it is given -- so the transport mock forwards whatever the hooks
 * hand it and nothing more. A hook that states nothing therefore reaches the real host stating nothing,
 * which is exactly the production shape.
 *
 * Every fixture is a repository under the OS temp directory, deleted afterwards. Nothing here may ever
 * run against a real worktree.
 */

const hostMocks = vi.hoisted(() => ({
  /** Calls the real main-process discard, forwarding the precondition the renderer supplied. */
  discardRuntimeGitPath: vi.fn(),
  bulkDiscardRuntimeGitPaths: vi.fn(),
  bulkUnstageRuntimeGitPaths: vi.fn(),
  stageRuntimeGitPath: vi.fn(),
  unstageRuntimeGitPath: vi.fn()
}))

// React needs to be told it is inside a test environment or every act() call warns and the batching
// this file depends on is not guaranteed.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/runtime/runtime-git-client', () => hostMocks)

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => undefined
}))

vi.mock('@/components/editor/editor-autosave', () => ({
  // The editor-side race is separately handled and separately tested; these are the awaits that sit
  // between the confirm and the destruction, so they stay in the path as real awaits.
  requestEditorSaveQuiesce: async () => {},
  notifyEditorExternalFileChange: () => {}
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: { activeRuntimeEnvironmentId: null } }) }
}))

const tempRoots: string[] = []

/**
 * Git for Windows is often installed without the PATH option, and a bare `git` then fails with ENOENT
 * -- which reads as this suite being broken rather than as a missing binary. The app resolves this at
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

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-desktop-discard-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  // Why the fixture pins this: `restore --source=HEAD` writes through the checkout filters, so with
  // autocrlf on a Windows host the restored bytes differ from the committed ones. Real behaviour, and
  // the reason the identity hashes what is on disk -- but it would make these assertions about
  // restored content host-dependent, which is noise.
  git(repo, ['config', 'core.autocrlf', 'false'])
  return repo
}

async function write(repo: string, relativePath: string, contents: string): Promise<void> {
  await writeFile(path.join(repo, relativePath), contents)
}

async function read(repo: string, relativePath: string): Promise<string> {
  return readFile(path.join(repo, relativePath), 'utf8')
}

async function commitFile(repo: string, relativePath: string, contents: string): Promise<void> {
  await write(repo, relativePath, contents)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
}

let root: Root | null = null
let surface: DiscardSurface | null = null
/** The promise the transport returned, so an assertion can wait for the host instead of guessing. */
let inFlightDiscard: Promise<void> | null = null

afterEach(async () => {
  if (root) {
    const current = root
    await act(async () => current.unmount())
    root = null
  }
  surface = null
  inFlightDiscard = null
  invalidateGitReadCaches()
  vi.clearAllMocks()
  await Promise.all(tempRoots.splice(0).map((each) => rm(each, { recursive: true, force: true })))
})

/** Route the renderer's transport at the real main-process discard, forwarding what it was given. */
function wireRealDiscard(repo: string): void {
  hostMocks.discardRuntimeGitPath.mockImplementation(
    (
      _context: unknown,
      filePath: string,
      precondition?: { expectedContent?: string | null }
    ): Promise<void> => {
      const running = discardChanges(repo, filePath, {}, precondition)
      inFlightDiscard = running.then(
        () => {},
        () => {}
      )
      return running
    }
  )
}

/**
 * Wait for the destruction the confirm dispatched, and refuse to proceed if there wasn't one.
 *
 * A discard that was never attempted and a discard that was refused leave identical bytes on disk. So
 * a consequence assertion taken before the host ran reports "your work survived" for the wrong reason
 * -- which is exactly what the first draft of this file did: the stale case passed while the fresh
 * control proved nothing had run yet. The precondition is that something reached the transport, and
 * when it did not that is inconclusive, which has to be loud rather than green.
 */
async function settleDiscard(): Promise<void> {
  for (let attempt = 0; attempt < 300 && !inFlightDiscard; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  const running = inFlightDiscard
  if (!running) {
    throw new Error('the confirm never reached the discard transport, so nothing was observed')
  }
  await act(async () => {
    await running
  })
}

type DiscardSurface = {
  requestDiscardEntry: (entry: GitStatusEntry) => void
  confirmPendingDiscard: () => void
}

/**
 * The two real hooks, composed the way the panel composes them. Imported lazily so the module mocks
 * above are installed before either hook's import graph is evaluated.
 */
async function renderDiscardSurface(worktreePath: string): Promise<DiscardSurface> {
  const [{ useSourceControlEntryMutations }, { useSourceControlDiscardConfirmation }] =
    await Promise.all([import('./use-entry-mutations'), import('./use-discard-confirmation')])

  function Probe(): null {
    const mutations = useSourceControlEntryMutations({
      activeRepoSettings: null,
      activeWorktreeId: 'wt-1',
      worktreePath,
      refreshActiveGitStatusAfterMutation: async () => {}
    })
    const confirmation = useSourceControlDiscardConfirmation({
      activeRepoSettings: null,
      activeWorktreeId: 'wt-1',
      worktreePath,
      grouped: { staged: [], unstaged: [], untracked: [] },
      isExecutingBulk: false,
      setIsExecutingBulk: () => {},
      clearSelection: () => {},
      discardMany: mutations.discardMany,
      discardSingle: mutations.discardSingle,
      refreshActiveGitStatusAfterMutation: async () => {}
    })
    surface = {
      requestDiscardEntry: confirmation.requestDiscardEntry,
      confirmPendingDiscard: confirmation.confirmPendingDiscard
    }
    return null
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const created = createRoot(container)
  root = created
  await act(async () => created.render(createElement(Probe)))
  if (!surface) {
    throw new Error('discard surface did not render')
  }
  // Why a forwarder rather than the object captured above: requesting a confirmation re-renders the
  // probe, and the confirm handler from the previous render closes over a pending state that is still
  // null -- so calling it returns silently, nothing is dispatched, and a consequence assertion then
  // reads a file nobody touched. Always call the latest closure.
  const current = (): DiscardSurface => {
    if (!surface) {
      throw new Error('discard surface was unmounted')
    }
    return surface
  }
  return {
    requestDiscardEntry: (entry) => current().requestDiscardEntry(entry),
    confirmPendingDiscard: () => current().confirmPendingDiscard()
  }
}

/** The row the panel rendered, read through the real status path the panel reads through. */
async function observedEntry(repo: string, relativePath: string): Promise<GitStatusEntry> {
  const status = await getStatus(repo, { worktreeContentIdentity: true })
  const entry = status.entries.find((candidate) => candidate.path === relativePath)
  if (!entry) {
    const rows = status.entries.map((candidate) => candidate.path).join(', ')
    throw new Error(`no status row for ${relativePath}; rows: ${rows}`)
  }
  return entry
}

describe('a desktop discard authorized against one state and executed against another', () => {
  it('keeps work that arrived after the user opened the confirmation', async () => {
    const repo = await createFixtureRepo()
    await commitFile(repo, 'note.txt', 'committed\n')

    // What the panel rendered, and the state the user chose to throw away.
    await write(repo, 'note.txt', 'the edit the user reviewed\n')
    const entry = await observedEntry(repo, 'note.txt')
    wireRealDiscard(repo)

    const rendered = await renderDiscardSurface(repo)
    await act(async () => rendered.requestDiscardEntry(entry))

    // The window this test is about: the dialog is open, and something outside Orca writes. Not the
    // editor, not a store, not a watcher -- the file, directly, the way a formatter or a second tool
    // would. The user has seen none of this and is about to press a button that says Discard.
    await write(repo, 'note.txt', 'work that landed while the dialog was open\n')

    await act(async () => {
      rendered.confirmPendingDiscard()
    })
    await settleDiscard()

    expect(await read(repo, 'note.txt')).toBe('work that landed while the dialog was open\n')
  })

  it('still discards when nothing moved, so the protection is not a disabled button', async () => {
    const repo = await createFixtureRepo()
    await commitFile(repo, 'note.txt', 'committed\n')
    await write(repo, 'note.txt', 'the edit the user reviewed\n')
    const entry = await observedEntry(repo, 'note.txt')
    wireRealDiscard(repo)

    const rendered = await renderDiscardSurface(repo)
    await act(async () => rendered.requestDiscardEntry(entry))
    await act(async () => {
      rendered.confirmPendingDiscard()
    })
    await settleDiscard()

    expect(await read(repo, 'note.txt')).toBe('committed\n')
  })

  it('states the content it observed when it asks the host to destroy it', async () => {
    // The consequence assertions above are the point, but each can pass for two reasons -- the
    // precondition held, or the host was never told anything to hold it to. This names which, so a
    // regression that silently stops sending the observed state cannot hide behind a surviving file.
    const repo = await createFixtureRepo()
    await commitFile(repo, 'note.txt', 'committed\n')
    await write(repo, 'note.txt', 'the edit the user reviewed\n')
    const entry = await observedEntry(repo, 'note.txt')
    hostMocks.discardRuntimeGitPath.mockImplementation((): Promise<void> => {
      inFlightDiscard = Promise.resolve()
      return inFlightDiscard
    })

    const rendered = await renderDiscardSurface(repo)
    await act(async () => rendered.requestDiscardEntry(entry))
    await act(async () => {
      rendered.confirmPendingDiscard()
    })
    await settleDiscard()

    expect(hostMocks.discardRuntimeGitPath).toHaveBeenCalledWith(expect.anything(), 'note.txt', {
      expectedContent: entry.worktreeContentId
    })
  })
})
