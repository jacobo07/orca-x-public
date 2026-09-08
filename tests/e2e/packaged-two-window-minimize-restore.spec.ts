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
 * MARKED fixme: this cannot reach its own subject yet, because setting it up uncovered something
 * before the minimize. Opening a second window on the same worktree leaves both windows resolving
 * one terminal tab and one PTY, and in that state the packaged app measured:
 *
 *   A pty === B pty                            (one session, two surfaces)
 *   write from A  → nothing: bare prompt, zero pending bytes, one listener, document visible
 *   the same bytes written from B → 4000 chars and the marker appears
 *   stream reached A=false B=true              (A also stops receiving)
 *
 * So window A goes inert in both directions while still showing a plausible live prompt. The
 * runtime is healthy throughout — which is the shape of the freeze this whole area is chasing,
 * reached by a different trigger.
 *
 * What is NOT established, and why nothing is being fixed on the strength of it. Per-window PTY
 * input ownership is deliberate (`src/main/ipc/pty-multi-window-input-ownership.test.ts`), and its
 * contract is that the owning window may write. The PTY here was spawned by A, so the reading
 * inverts that — either ownership transferred when B adopted the session, or two windows sharing
 * one session is not a supported state and this setup drove the app into it. Deciding between those
 * needs the intended product contract, not another test. Shipping a fix without it would be
 * guessing at which of two designs is the real one.
 *
 * Reachability is the open question worth answering first: a user opening a second window on the
 * same project is ordinary, and terminal tab state is known to be profile-global here, so this may
 * need no test harness at all to reproduce.
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
import { establishSeededWorkspace } from './helpers/seeded-workspace-precondition'
import {
  getTerminalContent,
  sendToTerminal,
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

test.fixme('a packaged window recovers on restore while a second window stays visible @headful', async (
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

  test.setTimeout(MINIMIZED_HOLD_MS + 420_000)

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

    const windowIdsAfter = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.id)
    )
    expect(
      windowIdsAfter.filter((id) => id !== windowIdA),
      'a second native window did not appear — setup failure'
    ).toHaveLength(1)

    // B gets its own workspace and terminal, so "B was undisturbed" is a claim about a live session
    // rather than about an empty window.
    await waitForSessionReady(pageB)
    await establishSeededWorkspace({ page: pageB, testRepoPath: repoPath, testInfo })
    await waitForActiveWorktree(pageB)
    await ensureTerminalVisible(pageB)
    await waitForActiveTerminalManager(pageB)
    const paneB = await waitForPaneIdentitySnapshot(pageB, 1)
    const ptyIdB = paneB.panes[0]?.ptyId
    expect(ptyIdB, 'the second packaged window left no live PTY to measure').toBeTruthy()
    // Measured, not asserted: opening a second window on the same worktree resolves the same
    // terminal tab, so both windows attach to one PTY. That is this app's behaviour rather than a
    // contract this spec is entitled to invent, and it makes the differential sharper rather than
    // weaker — one model painted onto two surfaces, only one of which went away. If A comes back
    // stale while B shows the same model painted fresh, the divergence can only be presentation.
    // Re-read A's identity here rather than trusting the one captured at launch. Establishing a
    // workspace in B touches state both windows share, and a pane recreated in between leaves the
    // launch-time id naming a session that no longer exists — a write to it then reaches nothing
    // and reads, wrongly, as "the terminal stopped working".
    const paneARefreshed = await waitForPaneIdentitySnapshot(pageA, 1)
    const livePtyIdA = paneARefreshed.panes[0]?.ptyId
    expect(livePtyIdA, 'window A no longer reports a live PTY after the second window opened').toBeTruthy()
    if (livePtyIdA !== ptyIdA) {
      console.error(`[two-window] window A's pty changed while B was set up: ${ptyIdA} -> ${livePtyIdA}`)
    }

    const sessionsAreShared = ptyIdB === livePtyIdA
    console.error(`[two-window] A pty=${livePtyIdA}`)
    console.error(`[two-window] B pty=${ptyIdB}`)
    console.error(`[two-window] shared=${sessionsAreShared}`)
    testInfo.annotations.push({
      type: 'two-window-sessions',
      description: sessionsAreShared
        ? 'both windows attached to one PTY, so model readings are common and only the pixel readings are per-window'
        : 'the windows hold independent PTYs'
    })

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

    // One workload per distinct session. Starting a second script inside a shared PTY would put two
    // writers on one shell rather than giving each window a stream of its own.
    const stagedA = await runNodeScriptInTerminal(
      pageA,
      livePtyIdA as string,
      scrollingTerminalWorkload('WIN-A'),
      { dir: runDir, prefix: 'orca-two-window-a' }
    )
    const stagedB = sessionsAreShared
      ? null
      : await runNodeScriptInTerminal(pageB, ptyIdB as string, scrollingTerminalWorkload('WIN-B'), {
          dir: runDir,
          prefix: 'orca-two-window-b'
        })

    try {
      // Before asserting anything, ask the delivery fabric what happened. It separates the two
      // readings a bare "no marker" cannot: bytes produced but not processed by a renderer is a
      // binding that moved, no bytes at all is a write that never reached a live shell.
      await new Promise((resolve) => setTimeout(resolve, 8_000))
      for (const [label, page] of [
        ['A', pageA],
        ['B', pageB]
      ] as const) {
        const delivery = await page.evaluate(async () => {
          const build = (
            window as unknown as {
              __orcaTerminalFreezeReport?: () => Promise<{
                renderer?: { ptyDataListenerCount?: unknown; documentVisibilityState?: unknown }
                main?: unknown
              }>
            }
          ).__orcaTerminalFreezeReport
          if (typeof build !== 'function') {
            return 'no freeze report'
          }
          const report = await build()
          return JSON.stringify({
            listeners: report?.renderer?.ptyDataListenerCount ?? null,
            visibility: report?.renderer?.documentVisibilityState ?? null,
            main: report?.main ?? null
          }).slice(0, 1500)
        })
        const content = await getTerminalContent(page)
        console.error(
          `[two-window] ${label} content=${content.length} chars tail=${JSON.stringify(content.slice(-80))}`
        )
        console.error(`[two-window] ${label} delivery=${delivery}`)
      }

      const markerFor = { A: 'WIN-A', B: sessionsAreShared ? 'WIN-A' : 'WIN-B' } as const
      const sawMarker = async (page: typeof pageA, marker: string): Promise<boolean> =>
        (await getTerminalContent(page)).includes(`${marker}-`)

      // If A's write produced nothing, re-send the identical command from B before concluding
      // anything. Both windows address the same PTY by the same id, so a command that runs from one
      // window and not the other localises the loss to the writing window rather than the session:
      // input authority moved when the second window attached, and the first window's terminal went
      // quietly dead to typing. Sending the same bytes twice is safe — the shell is at a prompt.
      if (sessionsAreShared && !(await sawMarker(pageA, markerFor.A))) {
        console.error('[two-window] A produced nothing; re-sending the same command from B')
        await sendToTerminal(pageB, livePtyIdA as string, `${stagedA.command}\r`)
        await new Promise((resolve) => setTimeout(resolve, 8_000))
        const afterB = await getTerminalContent(pageB)
        console.error(
          `[two-window] after writing from B: B content=${afterB.length} chars sawMarker=${afterB.includes(`${markerFor.A}-`)}`
        )
      }

      // Which windows the stream actually reaches, asked of both rather than demanded of one. The
      // write goes to the PTY by id over IPC, so it is focus-independent and reaches the process
      // regardless; what is in question is which renderers are still bound to receive its output.
      // A window that has silently lost that binding is a finding, and one this must be able to
      // report rather than mislabel as "the workload never started".
      await expect
        .poll(
          async () =>
            (await sawMarker(pageA, markerFor.A)) || (await sawMarker(pageB, markerFor.B)),
          {
            timeout: 60_000,
            message:
              'neither window received the workload, so it never ran or the PTY is dead — setup failure, and inconclusive for anything below'
          }
        )
        .toBe(true)

      const reached = {
        A: await sawMarker(pageA, markerFor.A),
        B: await sawMarker(pageB, markerFor.B)
      }
      console.error(`[two-window] stream reached A=${reached.A} B=${reached.B}`)
      testInfo.annotations.push({
        type: 'two-window-delivery',
        description: `stream reached A=${reached.A} B=${reached.B} (shared session=${sessionsAreShared})`
      })
      expect(
        reached.A,
        `opening a second window on the same worktree left window A no longer showing its own terminal stream (B is showing it: ${reached.B}). The write reaches the PTY by id, so this is a renderer binding that moved rather than a process that stopped`
      ).toBe(true)

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
      stagedB?.cleanup()
    }
  } finally {
    await run?.dispose()
  }
})
