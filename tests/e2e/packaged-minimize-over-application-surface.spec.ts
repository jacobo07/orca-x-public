/**
 * H1, adjudicated in packaged Windows reality: does the terminal get its presentation recovery at
 * the transition that makes it usable again?
 *
 * The question this spec exists to settle is a timing one, and it is easy to ask wrongly. The
 * window-wake hook installs nothing while a pane is not presentation-eligible, and the hide path
 * deliberately suspends rendering when an application surface takes over — hidden terminals release
 * GPU contexts because Chromium's budget for them is small. So "no wake fired while the window was
 * restored behind Automations" is the architecture working, not a defect. Demanding a wake there
 * would be demanding it betray its own design.
 *
 * The contract is the later transition. By the time the user is looking at the terminal again, the
 * recovery that reattaches the renderer and repaints must have happened. This walks the two
 * transitions separately and reads Orca's own production breadcrumbs at each, so the answer is which
 * owner ran and when — not a black-box before-and-after pair that cannot tell a deferred recovery
 * from an absent one.
 *
 * Eligibility is measured rather than assumed: suspension releases the pane's WebGL renderer, so the
 * per-pane diagnostics say whether the pane really was made ineligible by the navigation. If it was
 * not, the premise of the recovery assertion does not hold in this configuration and the spec says
 * so instead of inventing a failure.
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
import { getStoreState } from './helpers/store'
import { getTerminalContent, waitForPaneIdentitySnapshot } from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  breadcrumbsSince,
  describeRecoveries,
  readTerminalRecoveryBreadcrumbs,
  readTerminalRendererModes,
  screenshotTerminalSurface,
  scrollingTerminalWorkload,
  type TerminalRecoveryBreadcrumb
} from './helpers/terminal-presentation-witness'

const MINIMIZED_HOLD_MS = Number(process.env.ORCA_E2E_PACKAGED_HOLD_MS) || 20_000
const RESTORE_SETTLE_MS = 6_000
const RETURN_SETTLE_MS = 4_000
/** Long enough that a live surface running a 120 ms workload must repaint several times. */
const LIVENESS_SAMPLE_GAP_MS = 1_500
const MARKER = 'ORCA-H1'

test('a packaged terminal is current when the user returns to it after a minimize @headful', async (
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

  test.setTimeout(MINIMIZED_HOLD_MS + 360_000)

  // Why these are logged and not only annotated: annotations surface on a failing test, and the
  // question this spec exists to answer is answered by a passing one. A green that cannot say which
  // recovery ran, at which transition, has measured nothing about H1.
  const note = (type: string, description: string): void => {
    testInfo.annotations.push({ type, description })
    console.error(`[h1] ${type} — ${description}`)
  }
  const record = (name: string, crumbs: TerminalRecoveryBreadcrumb[]): void => {
    note(
      'h1-breadcrumbs',
      `${name}: ${describeRecoveries(crumbs).join(', ') || '(no recovery crumbs)'}`
    )
    console.error(`[h1] all crumbs at ${name}: ${crumbs.map((crumb) => crumb.kind).join(', ')}`)
  }

  let run: PackagedOrcaRun | null = null
  try {
    run = await launchPackagedOrca({
      executablePath: executablePath as string,
      repoPath,
      testInfo
    })
    const { app, page, ptyId, runDir } = run

    const modesAtStart = await readTerminalRendererModes(page)
    expect(modesAtStart, 'the packaged build exposed no freeze report — setup failure').not.toBeNull()
    expect(
      (modesAtStart ?? []).some((mode) => mode.hasWebgl),
      `the packaged build attached no WebGL renderer, so this run is inconclusive for the presentation path: ${JSON.stringify(modesAtStart)}`
    ).toBe(true)

    const staged = await runNodeScriptInTerminal(page, ptyId, scrollingTerminalWorkload(MARKER), {
      dir: runDir,
      prefix: 'orca-h1'
    })

    try {
      await expect
        .poll(async () => (await getTerminalContent(page)).includes(`${MARKER}-`), {
          timeout: 40_000,
          message: 'the workload never reached the packaged terminal — setup failure'
        })
        .toBe(true)

      const modelAtStart = await getTerminalContent(page)
      const pixelsAtStart = await screenshotTerminalSurface(page)
      expect(pixelsAtStart, 'the packaged terminal surface was not measurable').not.toBeNull()
      const crumbsAtStart = await readTerminalRecoveryBreadcrumbs(page)
      expect(
        crumbsAtStart,
        'the packaged build published no breadcrumb stream, so this run cannot say which recovery ran — setup failure'
      ).not.toBeNull()

      // ── Leave the workspace for an application surface, the way the user does ──
      await page.locator('[data-workspace-activity="automations"]').click()
      await expect
        .poll(async () => getStoreState<string>(page, 'activeView'), {
          timeout: 20_000,
          message: 'the packaged app never navigated to the application surface — setup failure'
        })
        .toBe('automations')

      const modesWhileHidden = await readTerminalRendererModes(page)
      // The premise of the recovery contract below: was the pane actually made ineligible? Read the
      // deferral flag, not the renderer attachment — suspension keeps a recently hidden pane's
      // renderer on purpose so switching back never presents a DOM-fallback frame, so attachment
      // stays true for a correctly suspended pane and reading it would skip the contract entirely.
      const paneWasSuspended =
        (modesWhileHidden ?? []).length > 0 &&
        (modesWhileHidden ?? []).every((mode) => mode.webglAttachmentDeferred)
      note(
        'h1-eligibility',
        `while the application surface was showing, suspended=${paneWasSuspended}: ${JSON.stringify(modesWhileHidden)}`
      )
      const crumbsOnLeaving = await readTerminalRecoveryBreadcrumbs(page)

      // ── Minimize and restore, with the application surface still in front ──
      await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        window?.minimize()
      })
      const reallyMinimized = await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        return window?.isMinimized() ?? false
      })
      test.skip(
        !reallyMinimized,
        'window manager refused the programmatic minimize — inconclusive, not a pass'
      )

      await new Promise((resolve) => setTimeout(resolve, MINIMIZED_HOLD_MS))

      await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        window?.restore()
        window?.focus()
      })
      await expect
        .poll(
          async () =>
            app.evaluate(({ BrowserWindow }) => {
              const [window] = BrowserWindow.getAllWindows()
              return window?.isMinimized() ?? true
            }),
          { timeout: 25_000, message: 'the packaged window never left the minimized state' }
        )
        .toBe(false)
      await new Promise((resolve) => setTimeout(resolve, RESTORE_SETTLE_MS))

      // Transition A: the window is back, the terminal is still behind the application surface.
      const crumbsAfterRestore = await readTerminalRecoveryBreadcrumbs(page)
      const transitionA = breadcrumbsSince(crumbsOnLeaving, crumbsAfterRestore)
      record('transition A (window restored, terminal still hidden)', transitionA)

      // ── The route back to work ──
      await expect(
        page.locator('[data-activity-bar-item="explorer"]'),
        'Explorer was not reachable on the application surface after the window came back'
      ).toBeVisible({ timeout: 20_000 })
      await page.locator('[data-activity-bar-item="explorer"]').click()
      await expect
        .poll(async () => getStoreState<string>(page, 'activeView'), {
          timeout: 20_000,
          message: 'Explorer did not return the content area to the workspace'
        })
        .toBe('terminal')
      await new Promise((resolve) => setTimeout(resolve, RETURN_SETTLE_MS))

      // Transition B: the terminal is usable again. This is where the contract lives.
      const crumbsAfterReturn = await readTerminalRecoveryBreadcrumbs(page)
      const transitionB = breadcrumbsSince(crumbsAfterRestore, crumbsAfterReturn)
      record('transition B (terminal presentation-eligible again)', transitionB)

      // Same session, not a new one: recovering presentation must never cost the running work.
      const paneAfter = await waitForPaneIdentitySnapshot(page, 1)
      expect(
        paneAfter.panes[0]?.ptyId,
        'the packaged app came back with a different PTY — the session was replaced, not recovered'
      ).toBe(ptyId)

      // The runtime kept working while all of this happened. If it did not, the stop is upstream of
      // presentation and nothing below may be attributed there.
      expect(
        await getTerminalContent(page),
        'the terminal model did not advance across the journey — a delivery or execution stall, inconclusive for presentation'
      ).not.toBe(modelAtStart)

      if (paneWasSuspended) {
        // The contract, asserted only where its premise was measured to hold: a pane that was made
        // ineligible must be eligible again once the user is looking at it.
        const modesOnReturn = await readTerminalRendererModes(page)
        note('h1-eligibility', `once the terminal was showing again: ${JSON.stringify(modesOnReturn)}`)
        expect(
          (modesOnReturn ?? []).every((mode) => !mode.webglAttachmentDeferred),
          `the pane was suspended behind the application surface and was still suspended once the terminal was showing again: ${JSON.stringify(modesOnReturn)}; recoveries at that transition: ${describeRecoveries(transitionB).join(', ') || 'none'}`
        ).toBe(true)
        expect(
          (modesOnReturn ?? []).some((mode) => mode.hasWebgl),
          `the terminal came back with no GPU renderer attached: ${JSON.stringify(modesOnReturn)}`
        ).toBe(true)
        expect(
          describeRecoveries(transitionB).length,
          'the terminal became presentation-eligible again with no recovery recorded at that transition, so nothing reattached or repainted the surface'
        ).toBeGreaterThan(0)
      } else {
        note(
          'h1-eligibility',
          'the pane was never marked presentation-ineligible behind the application surface, so the recovery contract has no premise here and was not asserted'
        )
      }

      // Presentation, measured two ways. Against the pre-journey frame: the surface is showing the
      // work that happened meanwhile. Against itself a moment later: the surface is live, not a
      // correct-looking still frame left over from one repaint.
      const pixelsOnReturn = await screenshotTerminalSurface(page)
      expect(pixelsOnReturn, 'the terminal surface was not measurable after the return').not.toBeNull()
      expect(
        pixelsOnReturn?.equals(pixelsAtStart as Buffer),
        'the terminal shows exactly what it showed before the journey: its model advanced but the surface never repainted'
      ).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, LIVENESS_SAMPLE_GAP_MS))
      const pixelsStillLater = await screenshotTerminalSurface(page)
      expect(pixelsStillLater, 'the terminal surface was not measurable on the liveness sample').not.toBeNull()
      expect(
        pixelsStillLater?.equals(pixelsOnReturn as Buffer),
        'the surface repainted once on return and then froze: a running workload changed nothing over the sample window'
      ).toBe(false)
    } finally {
      staged.cleanup()
    }
  } finally {
    await run?.dispose()
  }
})
