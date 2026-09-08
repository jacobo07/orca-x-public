/**
 * The same minimize/restore guarantees, against a packaged Windows build.
 *
 * Every previous result in this area was taken from `electron.launch` over `out/` — a development
 * run. The open hypotheses about restore live in layers that development and packaged builds do not
 * share: GPU/ANGLE initialisation, compositor behaviour, asar-backed resource loading, the packaged
 * process topology and production Electron flags. A development green cannot close a native
 * windowing contract, so this spec is the production boundary those hypotheses have to cross.
 *
 * What the artifact is, and what it therefore cannot prove, is documented once on the launch helper.
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
import { getTerminalContent } from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  readTerminalRendererModes,
  screenshotTerminalSurface,
  scrollingTerminalWorkload
} from './helpers/terminal-presentation-witness'

const MINIMIZED_HOLD_MS = Number(process.env.ORCA_E2E_PACKAGED_HOLD_MS) || 20_000
const RESTORE_SETTLE_MS = 6_000
const MARKER = 'ORCA-PACKAGED'

test('a packaged window keeps its terminal current across minimize and restore @headful', async (
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

  test.setTimeout(MINIMIZED_HOLD_MS + 300_000)

  let run: PackagedOrcaRun | null = null
  try {
    run = await launchPackagedOrca({
      executablePath: executablePath as string,
      repoPath,
      testInfo
    })
    const { app, page, ptyId, runDir } = run

    // Backend — every claim below is about the GPU presentation path. On the DOM fallback the run
    // is INCONCLUSIVE for those claims, so say which side of that gap this artifact stood on.
    const modes = await readTerminalRendererModes(page)
    expect(modes, 'the packaged build exposed no freeze report — setup failure').not.toBeNull()
    expect(
      (modes ?? []).some((mode) => mode.hasWebgl),
      `the packaged build attached no WebGL renderer, so this run is inconclusive for the GPU presentation path: ${JSON.stringify(modes)}`
    ).toBe(true)

    const staged = await runNodeScriptInTerminal(page, ptyId, scrollingTerminalWorkload(MARKER), {
      dir: runDir,
      prefix: 'orca-packaged'
    })

    try {
      await expect
        .poll(async () => (await getTerminalContent(page)).includes(`${MARKER}-`), {
          timeout: 40_000,
          message: 'the workload never reached the packaged terminal — setup failure'
        })
        .toBe(true)

      const pixelsBefore = await screenshotTerminalSurface(page)
      expect(pixelsBefore, 'the packaged terminal surface was not measurable').not.toBeNull()
      const modelBefore = await getTerminalContent(page)

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

      // Precondition — the model advanced. If it did not, the stop is upstream of presentation and
      // this gate must not attribute it here.
      expect(
        await getTerminalContent(page),
        'the packaged terminal model did not advance across the minimize — a delivery or execution stall, inconclusive for presentation'
      ).not.toBe(modelBefore)

      const pixelsAfter = await screenshotTerminalSurface(page)
      expect(pixelsAfter, 'the packaged terminal surface was not measurable').not.toBeNull()
      expect(
        pixelsAfter?.equals(pixelsBefore as Buffer),
        'the restored packaged terminal painted nothing new: its model advanced while minimized but not one pixel of the surface changed — presentation is stale'
      ).toBe(false)
    } finally {
      staged.cleanup()
    }
  } finally {
    await run?.dispose()
  }
})
