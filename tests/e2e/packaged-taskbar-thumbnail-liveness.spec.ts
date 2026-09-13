/**
 * The taskbar preview, judged where the user sees it.
 *
 * Every earlier result in this area was taken from the supply side: a demand arrived, a bitmap was
 * supplied, the HRESULT was zero. A preview can be frozen with all three looking healthy, because
 * none of them is a pixel anybody saw -- and a count of demands served says nothing about whether
 * the served content ever changed. So this gate reads DWM's own thumbnail of the window, which is
 * the surface the taskbar flyout composites.
 *
 * Two claims, deliberately separate, because a perfectly current partial image and a complete frozen
 * one are different defects with different fixes and only one of them is usually what was reported:
 *
 *   SPATIAL  -- the thumbnail fills the box it was given, leaving no region DWM never drew over.
 *   TEMPORAL -- while a real terminal advances and the window stays minimized, the thumbnail changes.
 *
 * The minimized precondition is asserted at the START and the END of the sampling window. A run that
 * silently lost it produces exactly the reading a dead preview produces, and the honest verdict for
 * that is inconclusive rather than either a pass or a failure.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  launchPackagedOrca,
  PACKAGED_ORCA_APP_DIR,
  resolvePackagedOrcaExecutable,
  type PackagedOrcaRun
} from './helpers/packaged-orca-app'
import {
  countDistinctFrames,
  nativeWindowHandleToNumber,
  sampleDwmThumbnail
} from './helpers/dwm-thumbnail-mirror'
import { getTerminalContent } from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { scrollingTerminalWorkload } from './helpers/terminal-presentation-witness'

const MARKER = 'ORCA-THUMB'
const SAMPLE_FRAMES = 6
const SAMPLE_INTERVAL_MS = 3_000

test('a minimized packaged window keeps its taskbar thumbnail whole and current @headful', async (
  // oxlint-disable-next-line no-empty-pattern -- this spec owns its own launch and opts out of the app fixture.
  {},
  testInfo
) => {
  test.skip(process.platform !== 'win32', 'the taskbar thumbnail is a Windows surface')
  const executablePath = resolvePackagedOrcaExecutable()
  test.skip(
    executablePath === null,
    `no packaged Windows artifact at ${PACKAGED_ORCA_APP_DIR} — build it before this gate can say anything`
  )
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'global setup did not produce a seeded test repo')

  test.setTimeout(SAMPLE_FRAMES * SAMPLE_INTERVAL_MS + 420_000)

  let run: PackagedOrcaRun | null = null
  try {
    run = await launchPackagedOrca({ executablePath: executablePath as string, repoPath, testInfo })
    const { app, page, ptyId, runDir } = run

    const staged = await runNodeScriptInTerminal(page, ptyId, scrollingTerminalWorkload(MARKER), {
      dir: runDir,
      prefix: 'orca-thumbnail'
    })

    try {
      // Precondition: the terminal is actually producing. A thumbnail that never changes because
      // nothing happened is not the defect this gate is about, and must not be reported as it.
      await expect
        .poll(async () => (await getTerminalContent(page)).includes(`${MARKER}-`), {
          timeout: 40_000,
          message: 'the workload never reached the packaged terminal — setup failure'
        })
        .toBe(true)
      const modelBefore = await getTerminalContent(page)

      const hwnd = nativeWindowHandleToNumber(
        Buffer.from(
          await app.evaluate(({ BrowserWindow }) => {
            const [window] = BrowserWindow.getAllWindows()
            return Array.from(window?.getNativeWindowHandle() ?? [])
          })
        )
      )
      expect(hwnd, 'the packaged window surrendered no native handle — setup failure').toBeGreaterThan(0)

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

      const sample = sampleDwmThumbnail({
        hwnd,
        frames: SAMPLE_FRAMES,
        intervalMs: SAMPLE_INTERVAL_MS,
        outDir: path.join(testInfo.outputPath(), 'taskbar-thumbnail')
      })
      test.skip(sample === null, 'the DWM thumbnail mirror could not run — setup failure')
      const measured = sample as NonNullable<typeof sample>

      test.skip(
        measured.registerHresult !== 0,
        `DWM refused to mirror the window (hresult ${measured.registerHresult}) — inconclusive`
      )
      // The window has to have been iconic for the whole sampling window, or a frozen reading is
      // just a window that came back and this run says nothing either way.
      test.skip(
        !(measured.iconicAtStart && measured.iconicAtEnd) ||
          measured.frames.some((frame) => !frame.iconic),
        'the window did not stay minimized across the sample — inconclusive, not a failure'
      )
      expect(
        measured.frames.length,
        'the mirror produced no frames, so neither claim below was evaluated'
      ).toBe(SAMPLE_FRAMES)

      // Which surface was measured. A blank thumbnail has two causes that look identical here and
      // are fixed in different files, so the verdict says which one it is rather than leaving the
      // reader to run the whole gate again to find out.
      const first = measured.frames[0]
      const servedFrom =
        first && first.sourceWidth <= 256 && first.sourceHeight <= 256
          ? `served from the app's own iconic bitmap (${first.sourceWidth}x${first.sourceHeight}), ` +
            'so anything wrong with it was drawn by captureWindowImage/answer'
          : `composited by DWM from the window surface (${first?.sourceWidth}x${first?.sourceHeight}), ` +
            'so the takeover is not engaged and the window itself is what looks like this'

      // SPATIAL, half one. Mirror background surviving into a frame is a region DWM never covered.
      const worstUnpainted = Math.max(...measured.frames.map((frame) => frame.unpaintedPct))
      expect(
        worstUnpainted,
        `the thumbnail left ${worstUnpainted}% of its box undrawn — the window does not fill its own preview`
      ).toBeLessThan(1)

      // SPATIAL, half two — the half that matches the reported defect, which the check above is
      // blind to because black is a colour DWM did draw. Thresholds bracketed by measurement on the
      // development gate: a solid-black minimized window scores 30 quantised colours and 92.05%
      // near-black, a correct one 79-109 colours and 0%. See the sibling spec for the full account.
      const poorestFrame = measured.frames.reduce((worst, frame) =>
        frame.distinctColours < worst.distinctColours ? frame : worst
      )
      const blankest = measured.frames.reduce((worst, frame) =>
        frame.nearBlackPct > worst.nearBlackPct ? frame : worst
      )
      expect(
        poorestFrame.distinctColours,
        `the taskbar thumbnail carries almost no colour (${poorestFrame.distinctColours} quantised, ` +
          `${poorestFrame.nearBlackPct}% near-black) — it is a blank rectangle, not a picture of the ` +
          `window. It was ${servedFrom}`
      ).toBeGreaterThan(48)
      expect(
        blankest.nearBlackPct,
        `the taskbar thumbnail is ${blankest.nearBlackPct}% near-black over ` +
          `${blankest.distinctColours} quantised colours — the window is not in its own preview. ` +
          `It was ${servedFrom}`
      ).toBeLessThan(85)

      // TEMPORAL. The terminal advanced, the window stayed minimized: the picture must have moved.
      expect(
        await getTerminalContent(page),
        'the terminal model did not advance while minimized — a delivery stall, inconclusive for the preview'
      ).not.toBe(modelBefore)
      const distinct = countDistinctFrames(measured.frames)
      expect(
        distinct,
        `the taskbar thumbnail never changed across ${SAMPLE_FRAMES} samples spanning ` +
          `${(SAMPLE_FRAMES * SAMPLE_INTERVAL_MS) / 1000}s while the terminal advanced and the window ` +
          `stayed minimized: ${JSON.stringify(measured.frames.map((frame) => frame.hash))}`
      ).toBeGreaterThan(1)
    } finally {
      staged.cleanup()
      await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        window?.restore()
      })
    }
  } finally {
    await run?.dispose()
  }
})
