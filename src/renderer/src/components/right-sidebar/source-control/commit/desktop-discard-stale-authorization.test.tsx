// @vitest-environment happy-dom

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DiscardObservedStateRequiredError,
  StaleWorktreeStateError
} from '../../../../../../shared/stale-worktree-state'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

/**
 * What the desktop hands the host when a user authorizes a discard.
 *
 * The mobile discard was fenced and the desktop was left out, on the argument that it is local -- same
 * machine, same process tree, low latency. That argument is about transport and the question is about
 * time. Three windows separate the row the user read from the bytes git destroys, and the middle one is
 * a modal waiting on a human, which no amount of locality shortens. The producer of the newer state
 * needs none of Orca's machinery either: an external editor, a formatter on save, a build step, an
 * agent session, a second window.
 *
 * Scope, stated rather than implied. This file is about the half the renderer owns: that the observed
 * state travels from the row the user acted on, through a confirmation dialog that used to drop it, to
 * the transport -- and that a refusal comes back as a refusal. It deliberately does NOT import the
 * main-process discard: the renderer project is not allowed to, and the first draft's doing so turned
 * one boundary violation into twenty-one typecheck errors. The consequence on disk is proven where the
 * destruction lives, against real git, in src/main/git/discard-stale-worktree-state.test.ts, and
 * end-to-end through the running app in the e2e suite.
 *
 * The sharpest assertion here is the third one: the file is changed AFTER the row is captured, and the
 * identity the transport receives is still the one from the row. That is what distinguishes stating
 * what the user saw from re-reading the file at confirm time -- the second would silently authorize
 * destroying work the user never looked at, which is the race rather than the protection.
 */

const hostMocks = vi.hoisted(() => ({
  discardRuntimeGitPath: vi.fn(),
  bulkDiscardRuntimeGitPaths: vi.fn(),
  bulkUnstageRuntimeGitPaths: vi.fn(),
  stageRuntimeGitPath: vi.fn(),
  unstageRuntimeGitPath: vi.fn(),
  DISCARD_HOST_CANNOT_CHECK_MESSAGE: 'host too old'
}))

const toastMocks = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn() }))

// React warns on every act() and stops guaranteeing the batching this file depends on unless it is
// told it is in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/runtime/runtime-git-client', () => hostMocks)
vi.mock('sonner', () => ({ toast: toastMocks }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
vi.mock('@/components/editor/editor-autosave', () => ({
  // The editor-side race is separately handled and separately tested; these are two of the awaits that
  // sit between the confirm and the destruction, so they stay in the path as real awaits.
  requestEditorSaveQuiesce: async () => {},
  notifyEditorExternalFileChange: () => {}
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: { activeRuntimeEnvironmentId: null } }) }
}))

const tempRoots: string[] = []

/** A real directory with real bytes, so the identities below are of something rather than of a string. */
async function createFixtureWorktree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-desktop-discard-'))
  tempRoots.push(root)
  return root
}

/** The same definition both hosts use, kept here rather than imported so this file pulls in no
 *  filesystem module from shared just to build a fixture. */
async function contentIdentity(worktree: string, relativePath: string): Promise<string> {
  const bytes = await readFile(path.join(worktree, relativePath))
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function write(worktree: string, relativePath: string, contents: string): Promise<void> {
  await writeFile(path.join(worktree, relativePath), contents)
}

let root: Root | null = null
let surface: DiscardSurface | null = null
/** The promise the transport returned, so an assertion can wait for the dispatch instead of guessing. */
let inFlightDiscard: Promise<void> | null = null

afterEach(async () => {
  if (root) {
    const current = root
    await act(async () => current.unmount())
    root = null
  }
  surface = null
  inFlightDiscard = null
  vi.clearAllMocks()
  await Promise.all(tempRoots.splice(0).map((each) => rm(each, { recursive: true, force: true })))
})

function resolveTransportWith(outcome: 'accepts' | 'refuses-as-stale' | 'refuses-as-old-host'): void {
  hostMocks.discardRuntimeGitPath.mockImplementation((): Promise<void> => {
    const running =
      outcome === 'accepts'
        ? Promise.resolve()
        : Promise.reject(
            outcome === 'refuses-as-stale'
              ? new StaleWorktreeStateError('note.txt')
              : new Error(hostMocks.DISCARD_HOST_CANNOT_CHECK_MESSAGE)
          )
    inFlightDiscard = running.then(
      () => {},
      () => {}
    )
    return running
  })
}

/**
 * Wait for the dispatch the confirm produced, and refuse to proceed if there wasn't one.
 *
 * A discard that was never attempted and a discard that was refused look identical from outside. So an
 * assertion taken before the dispatch reports the right answer for the wrong reason -- which is exactly
 * what the first draft of this file did, passing its stale case while a sibling control proved nothing
 * had run. Not-attempted is inconclusive and has to be loud rather than green.
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
  // null -- so calling it returns silently, nothing is dispatched, and an assertion then reads a world
  // nobody touched. Always call the latest closure.
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

function row(overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return { path: 'note.txt', status: 'modified', area: 'unstaged', ...overrides }
}

/** Request, then confirm, the way a user does: two separate acts with a dialog in between. */
async function discardThroughDialog(
  worktreePath: string,
  entry: GitStatusEntry,
  betweenRequestAndConfirm?: () => Promise<void>
): Promise<void> {
  const rendered = await renderDiscardSurface(worktreePath)
  await act(async () => rendered.requestDiscardEntry(entry))
  await betweenRequestAndConfirm?.()
  await act(async () => {
    rendered.confirmPendingDiscard()
  })
  await settleDiscard()
}

describe('what the desktop tells the host it is authorizing the destruction of', () => {
  it('states the content the row was rendered from', async () => {
    const worktree = await createFixtureWorktree()
    await write(worktree, 'note.txt', 'the edit the user reviewed\n')
    const observed = await contentIdentity(worktree, 'note.txt')
    resolveTransportWith('accepts')

    await discardThroughDialog(worktree, row({ worktreeContentId: observed }))

    expect(hostMocks.discardRuntimeGitPath).toHaveBeenCalledWith(expect.anything(), 'note.txt', {
      expectedContent: observed
    })
  })

  it('still states the observed content after the file has moved underneath it', async () => {
    // The distinction that matters. Re-reading at confirm time would hand the host the NEW identity,
    // the host would find it unchanged, and the discard would destroy work the user never saw -- a
    // refresh-then-discard wearing the costume of a precondition. So the value must be the old one.
    const worktree = await createFixtureWorktree()
    await write(worktree, 'note.txt', 'the edit the user reviewed\n')
    const observed = await contentIdentity(worktree, 'note.txt')
    resolveTransportWith('accepts')

    await discardThroughDialog(worktree, row({ worktreeContentId: observed }), async () => {
      // Outside every store, cache, watcher and editor buffer Orca owns: the file, directly.
      await write(worktree, 'note.txt', 'work that landed while the dialog was open\n')
    })

    const stated = await contentIdentity(worktree, 'note.txt')
    expect(stated).not.toBe(observed)
    expect(hostMocks.discardRuntimeGitPath).toHaveBeenCalledWith(expect.anything(), 'note.txt', {
      expectedContent: observed
    })
  })

  it('tells the user it could not tell, in different words from a conflict', async () => {
    const worktree = await createFixtureWorktree()
    await write(worktree, 'note.txt', 'whatever\n')
    hostMocks.discardRuntimeGitPath.mockImplementation((): Promise<void> => {
      const running = Promise.reject(new DiscardObservedStateRequiredError('note.txt'))
      inFlightDiscard = running.then(
        () => {},
        () => {}
      )
      return running
    })

    await discardThroughDialog(worktree, row())

    const said = String(toastMocks.message.mock.calls[0]?.[0] ?? '')
    expect(said).toContain('could not tell')
    // The opposite of a conflict: this file did NOT change, so saying it did would send the user hunting
    // for work that was never at risk instead of refreshing.
    expect(said).not.toContain('changed after you opened it')
  })

  it('passes absence as absence rather than guessing, when the row carries no identity', async () => {
    // A capped listing, an unreadable file, a host that does not stamp. Absence must travel as absence:
    // inventing a value here would authorize destroying whatever happens to be on disk. The transport
    // refuses it outright -- proven in runtime-git-discard-observed-state.test.ts -- and this pins that
    // the hook does not paper over the gap on the way there.
    const worktree = await createFixtureWorktree()
    await write(worktree, 'note.txt', 'whatever\n')
    resolveTransportWith('accepts')

    await discardThroughDialog(worktree, row())

    expect(hostMocks.discardRuntimeGitPath).toHaveBeenCalledWith(
      expect.anything(),
      'note.txt',
      undefined
    )
  })

  it('tells the user their newer work was kept when the host refuses', async () => {
    // This path used to swallow every rejection, because every rejection used to be a real failure. A
    // refusal is not one: the file moved and nothing was destroyed, which is the outcome the user would
    // have chosen. Silence here reads as a successful discard of work that is still there.
    const worktree = await createFixtureWorktree()
    await write(worktree, 'note.txt', 'the edit the user reviewed\n')
    resolveTransportWith('refuses-as-stale')

    await discardThroughDialog(worktree, row({ worktreeContentId: 'sha256:whatever' }))

    expect(toastMocks.message).toHaveBeenCalledTimes(1)
    const said = String(toastMocks.message.mock.calls[0]?.[0] ?? '')
    expect(said).toContain('changed after you opened it')
    // The user authorized destroying something they looked at. How that was recorded is not their
    // problem, and a hash in this sentence would be a defect rather than detail.
    expect(said).not.toMatch(/sha256|oid|[0-9a-f]{16}/)
  })

  it('says nothing when the rejection is an ordinary failure', async () => {
    // The quiet control. A handler that announced every rejection would pass the test above while
    // turning real errors into reassuring notices about work being safe.
    const worktree = await createFixtureWorktree()
    await write(worktree, 'note.txt', 'the edit the user reviewed\n')
    hostMocks.discardRuntimeGitPath.mockImplementation((): Promise<void> => {
      const running = Promise.reject(new Error('EPERM: operation not permitted'))
      inFlightDiscard = running.then(
        () => {},
        () => {}
      )
      return running
    })

    await discardThroughDialog(worktree, row({ worktreeContentId: 'sha256:whatever' }))

    expect(toastMocks.message).not.toHaveBeenCalled()
  })
})
