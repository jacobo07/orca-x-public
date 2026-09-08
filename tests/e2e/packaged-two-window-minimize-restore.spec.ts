/**
 * Minimize and restore with two packaged windows open, where only one of them goes away.
 *
 * The single-window runs cannot see the failure this is for. When the only window is minimized the
 * whole application is hidden, so a recovery keyed on an app-level signal — "something got focus",
 * "the app became visible" — behaves the same as one keyed on the window. With a second window
 * staying visible and focused the two come apart: the app never stops being active, so an app-level
 * trigger never fires for the window that actually went away, and its surface can come back stale
 * while every global reading says the application is healthy.
 *
 * Both windows run their own workload, so the run also says the surviving window was not disturbed —
 * a fix that recovers window A by repainting everything would show up here as B losing its session
 * or its identity.
 *
 * Each window owns a worktree of its own, because that is the only two-window topology the product
 * has. A worktree binds to at most one window (`src/main/window/workspace-window-registry.ts`), and
 * an earlier version of this spec activated A's worktree in B by setting it on the store directly —
 * which skips the claim and put both windows on one PTY. Everything measured in that state described
 * a configuration the product refuses, so it could not be read as the product's behaviour. The
 * refusal is asserted below rather than assumed, so the topology this spec depends on is the one the
 * product actually enforces.
 */

import { existsSync, readFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  launchPackagedOrca,
  PACKAGED_ORCA_APP_DIR,
  resolvePackagedOrcaExecutable,
  type PackagedOrcaRun
} from './helpers/packaged-orca-app'
import {
  ensureTerminalVisible,
  getStoreState,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  readTerminalRendererModes,
  screenshotTerminalSurface,
  scrollingTerminalWorkload
} from './helpers/terminal-presentation-witness'

const MINIMIZED_HOLD_MS = Number(process.env.ORCA_E2E_PACKAGED_HOLD_MS) || 20_000
const RESTORE_SETTLE_MS = 6_000

test('a packaged window recovers on restore while a second window stays visible @headful', async (
  // oxlint-disable-next-line no-empty-pattern -- this spec owns its own launch and opts out of the app fixture.
  {},
  testInfo
) => {
  const executablePath = resolvePackagedOrcaExecutable()
  test.skip(
    executablePath === null,
    `no packaged Windows artifact at ${PACKAGED_ORCA_APP_DIR} — build it before this gate can say anything`
  )
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'global setup did not produce a seeded test repo')

  test.setTimeout(MINIMIZED_HOLD_MS + 480_000)

  let run: PackagedOrcaRun | null = null
  try {
    run = await launchPackagedOrca({
      executablePath: executablePath as string,
      repoPath,
      testInfo
    })
    const { app, page: pageA, ptyId: ptyIdA, runDir } = run

    // Which native window is A, decided before B exists. Identity by id, not by ordering or title:
    // ordering is an implementation detail and a title can be changed by the page itself.
    const windowIdsBefore = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.id)
    )
    expect(windowIdsBefore, 'the packaged app did not start with exactly one window').toHaveLength(1)
    const windowIdA = windowIdsBefore[0]

    const worktreeIdA = await waitForActiveWorktree(pageA)
    // From the worktree rather than from `activeRepoId`: a packaged launch can have an active
    // worktree while that pointer is still null, and reading it there reports "no repository" for a
    // window that plainly has one.
    const repoIdA = await pageA.evaluate((worktreeId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available in window A')
      }
      const state = store.getState()
      for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo)) {
        if ((worktrees ?? []).some((worktree) => worktree.id === worktreeId)) {
          return repoId
        }
      }
      return state.activeRepoId ?? null
    }, worktreeIdA)
    expect(repoIdA, 'window A has no active repository to branch a second worktree from').toBeTruthy()

    // Window A takes the binding for what it is showing. In the product this happens on the way in —
    // the launcher claims before it navigates, and a window restoring a saved session claims what it
    // restores. This harness has neither: the packaged profile is seeded with onboarding only, so
    // there is no session to restore, and the workspace is established by driving the store. Without
    // this the registry would hold no owner for A's worktree, and the refusal asserted below would be
    // measuring the harness's shortcut rather than the product's rule.
    const claimA = await pageA.evaluate(
      async ({ repoId, worktreeId }) =>
        (await window.api.ui.claimWorkspace({ repoId, worktreeId })).outcome,
      { repoId: repoIdA as string, worktreeId: worktreeIdA }
    )
    expect(
      ['claimed', 'already-owned-by-this-window'],
      'window A could not take the workspace it is showing — setup failure'
    ).toContain(claimA)

    // A second worktree, created by the window that owns the repository. B claims this one; nothing
    // else in this spec would give B a project it is entitled to hold.
    const worktreeIdB = await pageA.evaluate(async (repoId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available in window A')
      }
      const created = await store.getState().createWorktree(repoId, `e2e-two-window-${Date.now()}`)
      await store.getState().fetchWorktrees(repoId)
      return created.worktree.id
    }, repoIdA as string)
    expect(worktreeIdB, 'no second worktree was created — setup failure').toBeTruthy()
    expect(worktreeIdB, 'the second worktree is the same one window A already holds').not.toBe(
      worktreeIdA
    )

    const pageB = await Promise.all([
      app.waitForEvent('window', { timeout: 60_000 }),
      pageA.evaluate(() => window.api.ui.createWindow())
    ]).then(([opened]) => opened)
    await pageB.waitForLoadState('domcontentloaded')
    await expect
      .poll(async () => getStoreState<boolean>(pageB, 'persistedUIReady'), {
        timeout: 60_000,
        message: 'the second packaged window never finished hydrating — setup failure'
      })
      .toBe(true)
    await waitForSessionReady(pageB)

    const windowIdsAfter = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.id)
    )
    expect(
      windowIdsAfter.filter((id) => id !== windowIdA),
      'a second native window did not appear — setup failure'
    ).toHaveLength(1)

    // The contract this spec's topology rests on, asserted in the packaged app rather than assumed
    // from the source. If a second window could take A's worktree, both windows would resolve one
    // terminal tab and one PTY, and every per-window reading below would be describing one session
    // painted twice.
    const refusedClaim = await pageB.evaluate(
      async ({ repoId, worktreeId }) =>
        (await window.api.ui.claimWorkspace({ repoId, worktreeId })).outcome,
      { repoId: repoIdA as string, worktreeId: worktreeIdA }
    )
    expect(
      refusedClaim,
      'a second window was allowed to claim the worktree window A already owns, so the one-window-per-worktree rule no longer holds and a shared-PTY window is reachable'
    ).toBe('owned-by-another-window')

    // B takes the worktree that is free, through the same claim the launcher uses.
    const acceptedClaim = await pageB.evaluate(
      async ({ repoId, worktreeId }) =>
        (await window.api.ui.claimWorkspace({ repoId, worktreeId })).outcome,
      { repoId: repoIdA as string, worktreeId: worktreeIdB }
    )
    expect(acceptedClaim, 'window B could not claim a worktree nobody owns — setup failure').toBe(
      'claimed'
    )

    await pageB.evaluate(
      async ({ repoId, worktreeId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available in window B')
        }
        const state = store.getState()
        state.setActiveRepo(repoId)
        await state.fetchWorktrees(repoId)
        store.getState().setActiveWorktree(worktreeId)
        store.getState().setActiveView('terminal')
        if ((store.getState().tabsByWorktree[worktreeId] ?? []).length === 0) {
          await store.getState().openNewTerminalTabInActiveWorkspace()
        }
      },
      { repoId: repoIdA as string, worktreeId: worktreeIdB }
    )
    await expect
      .poll(async () => getStoreState<string | null>(pageB, 'activeWorktreeId'), {
        timeout: 60_000,
        message: 'window B never activated the worktree it claimed — setup failure'
      })
      .toBe(worktreeIdB)
    await ensureTerminalVisible(pageB)
    await waitForActiveTerminalManager(pageB)

    const paneB = await waitForPaneIdentitySnapshot(pageB, 1)
    const ptyIdB = paneB.panes[0]?.ptyId
    expect(ptyIdB, 'the second packaged window left no live PTY to measure').toBeTruthy()

    // Re-read A's identity rather than trusting the one captured at launch: creating a worktree and
    // a second window touches state A also holds, and a pane recreated in between leaves the
    // launch-time id naming a session that no longer exists — a write to it then reaches nothing and
    // reads, wrongly, as "the terminal stopped working".
    const paneARefreshed = await waitForPaneIdentitySnapshot(pageA, 1)
    const livePtyIdA = paneARefreshed.panes[0]?.ptyId
    expect(
      livePtyIdA,
      'window A no longer reports a live PTY after the second window opened'
    ).toBeTruthy()
    if (livePtyIdA !== ptyIdA) {
      console.error(`[two-window] window A's pty changed while B was set up: ${ptyIdA} -> ${livePtyIdA}`)
    }
    console.error(`[two-window] A pty=${livePtyIdA} worktree=${worktreeIdA}`)
    console.error(`[two-window] B pty=${ptyIdB} worktree=${worktreeIdB}`)
    expect(
      ptyIdB,
      'both windows resolved the same PTY despite owning different worktrees, so these are two views of one session and the per-window readings below mean nothing'
    ).not.toBe(livePtyIdA)

    for (const [label, page] of [
      ['A', pageA],
      ['B', pageB]
    ] as const) {
      const modes = await readTerminalRendererModes(page)
      expect(
        (modes ?? []).some((mode) => mode.hasWebgl),
        `window ${label} attached no WebGL renderer, so this run is inconclusive for the presentation path: ${JSON.stringify(modes)}`
      ).toBe(true)
    }

    // One workload per session, each with its own marker, so "this window is showing its own stream"
    // is a claim about identity and not only about motion.
    const stagedA = await runNodeScriptInTerminal(
      pageA,
      livePtyIdA as string,
      scrollingTerminalWorkload('WIN-A'),
      { dir: runDir, prefix: 'orca-two-window-a' }
    )
    const stagedB = await runNodeScriptInTerminal(
      pageB,
      ptyIdB as string,
      scrollingTerminalWorkload('WIN-B'),
      { dir: runDir, prefix: 'orca-two-window-b' }
    )

    try {
      const sawMarker = async (page: typeof pageA, marker: string): Promise<boolean> =>
        (await getTerminalContent(page)).includes(`${marker}-`)

      // Both streams have to be running before anything is minimized, or a stale surface after the
      // restore cannot be told from a workload that never started.
      await expect
        .poll(async () => (await sawMarker(pageA, 'WIN-A')) && (await sawMarker(pageB, 'WIN-B')), {
          timeout: 90_000,
          message:
            'one of the two workloads never appeared in its own window, so it never ran or its PTY is dead — setup failure, and inconclusive for anything below'
        })
        .toBe(true)

      // Neither window is showing the other's stream. A crossed binding would make every reading
      // below describe the wrong window while looking perfectly healthy.
      expect(
        await sawMarker(pageA, 'WIN-B'),
        "window A is showing window B's workload, so terminal output is reaching a window that does not own it"
      ).toBe(false)
      expect(
        await sawMarker(pageB, 'WIN-A'),
        "window B is showing window A's workload, so terminal output is reaching a window that does not own it"
      ).toBe(false)

      const modelBeforeA = await getTerminalContent(pageA)
      const modelBeforeB = await getTerminalContent(pageB)
      const pixelsBeforeA = await screenshotTerminalSurface(pageA)
      const pixelsBeforeB = await screenshotTerminalSurface(pageB)
      expect(pixelsBeforeA, 'window A surface was not measurable').not.toBeNull()
      expect(pixelsBeforeB, 'window B surface was not measurable').not.toBeNull()

      // Only A goes away. B stays visible and takes focus, which is what keeps the application
      // active throughout and separates a per-window trigger from an app-level one.
      await app.evaluate(({ BrowserWindow }, targetId) => {
        BrowserWindow.fromId(targetId)?.minimize()
      }, windowIdA)
      await pageB.bringToFront()

      const stateDuringHold = await app.evaluate(({ BrowserWindow }, targetId) => {
        const windows = BrowserWindow.getAllWindows()
        return {
          targetMinimized: BrowserWindow.fromId(targetId)?.isMinimized() ?? false,
          othersVisible: windows.filter((w) => w.id !== targetId && w.isVisible()).length
        }
      }, windowIdA)
      test.skip(
        !stateDuringHold.targetMinimized,
        'window manager refused the programmatic minimize — inconclusive, not a pass'
      )
      test.skip(
        stateDuringHold.othersVisible === 0,
        'the second window was not visible during the hold, so this run is the single-window case again — inconclusive'
      )

      await new Promise((resolve) => setTimeout(resolve, MINIMIZED_HOLD_MS))

      await app.evaluate(({ BrowserWindow }, targetId) => {
        const window = BrowserWindow.fromId(targetId)
        window?.restore()
        window?.focus()
      }, windowIdA)
      await expect
        .poll(
          async () =>
            app.evaluate(({ BrowserWindow }, targetId) => {
              return BrowserWindow.fromId(targetId)?.isMinimized() ?? true
            }, windowIdA),
          { timeout: 25_000, message: 'window A never left the minimized state' }
        )
        .toBe(false)
      await new Promise((resolve) => setTimeout(resolve, RESTORE_SETTLE_MS))

      // A: the window that actually went away.
      expect(
        await getTerminalContent(pageA),
        'window A stopped advancing while it was minimized — a delivery or execution stall, inconclusive for presentation'
      ).not.toBe(modelBeforeA)
      const pixelsAfterA = await screenshotTerminalSurface(pageA)
      expect(pixelsAfterA, 'window A surface was not measurable after the restore').not.toBeNull()
      expect(
        pixelsAfterA?.equals(pixelsBeforeA as Buffer),
        'window A came back showing exactly what it showed before: its model advanced while minimized but the surface never repainted, and the other window staying active is what would hide that'
      ).toBe(false)

      // B: never minimized, and must be no worse for A's journey.
      expect(
        await getTerminalContent(pageB),
        'window B stopped advancing while window A was minimized'
      ).not.toBe(modelBeforeB)
      const pixelsAfterB = await screenshotTerminalSurface(pageB)
      expect(pixelsAfterB, 'window B surface was not measurable').not.toBeNull()
      expect(
        pixelsAfterB?.equals(pixelsBeforeB as Buffer),
        'window B stopped painting while window A was minimized and restored'
      ).toBe(false)

      // Neither session was replaced. A recovery that costs a window its PTY is not a recovery.
      expect(
        (await waitForPaneIdentitySnapshot(pageA, 1)).panes[0]?.ptyId,
        'window A came back with a different PTY'
      ).toBe(livePtyIdA)
      expect(
        (await waitForPaneIdentitySnapshot(pageB, 1)).panes[0]?.ptyId,
        'window B lost its PTY while window A was minimized'
      ).toBe(ptyIdB)
    } finally {
      stagedA.cleanup()
      stagedB.cleanup()
    }
  } finally {
    await run?.dispose()
  }
})
