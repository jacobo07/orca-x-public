/**
 * The taskbar preview, judged where the user sees it — against a development launch.
 *
 * The packaged sibling of this spec is the stronger gate and is the one that will close the
 * question. This one exists because the addon resolves in a development launch too (that is what
 * `f4d51c253` fixed), so the same path can be exercised without a repackage — and a repackage is
 * currently the blocker, not the subject.
 *
 * What it therefore cannot say: nothing here is evidence about the packaged GPU stack, asar-backed
 * resource loading, or the production process topology. A green here is a green about the mechanism,
 * not about the shipped artifact.
 *
 * Two properties are asserted apart, because a current partial image and a complete frozen one are
 * different defects and only one of them is usually what was reported:
 *
 *   SPATIAL  — the thumbnail covers the box DWM gave it.
 *   TEMPORAL — while a real terminal advances and the window stays minimized, the picture moves.
 *
 * The minimized precondition is checked at the start, at the end, and per frame. A run that lost it
 * produces exactly the reading a dead preview produces, and the honest verdict for that is
 * inconclusive.
 */

import type { TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  countDistinctFrames,
  nativeWindowHandleToNumber,
  sampleDwmThumbnail
} from './helpers/dwm-thumbnail-mirror'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { scrollingTerminalWorkload } from './helpers/terminal-presentation-witness'

const MARKER = 'ORCA-THUMB-DEV'
const SAMPLE_FRAMES = 6
const SAMPLE_INTERVAL_MS = 3_000

test('a minimized window keeps its taskbar thumbnail whole and current @headful', async (
  { orcaPage, electronApp },
  testInfo: TestInfo
) => {
  test.skip(process.platform !== 'win32', 'the taskbar thumbnail is a Windows surface')
  test.setTimeout(SAMPLE_FRAMES * SAMPLE_INTERVAL_MS + 300_000)

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = snapshot.panes[0]?.ptyId
  expect(ptyId, 'no live PTY to measure — setup failure').toBeTruthy()

  const staged = await runNodeScriptInTerminal(
    orcaPage,
    ptyId as string,
    scrollingTerminalWorkload(MARKER),
    { dir: testInfo.outputPath(), prefix: 'orca-thumbnail-dev' }
  )

  try {
    // Precondition: the terminal is producing. A thumbnail that never changes because nothing
    // happened is not this defect, and must not be reported as it.
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(`${MARKER}-`), {
        timeout: 40_000,
        message: 'the workload never reached the terminal — setup failure'
      })
      .toBe(true)
    const modelBefore = await getTerminalContent(orcaPage)

    const hwnd = nativeWindowHandleToNumber(
      Buffer.from(
        await electronApp.evaluate(({ BrowserWindow }) => {
          const [window] = BrowserWindow.getAllWindows()
          return Array.from(window?.getNativeWindowHandle() ?? [])
        })
      )
    )
    expect(hwnd, 'the window surrendered no native handle — setup failure').toBeGreaterThan(0)

    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.minimize()
    })
    const reallyMinimized = await electronApp.evaluate(({ BrowserWindow }) => {
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
      outDir: testInfo.outputPath('taskbar-thumbnail')
    })
    test.skip(sample === null, 'the DWM thumbnail mirror could not run — setup failure')
    const measured = sample as NonNullable<typeof sample>

    test.skip(
      measured.registerHresult !== 0,
      `DWM refused to mirror the window (hresult ${measured.registerHresult}) — inconclusive`
    )
    test.skip(
      !(measured.iconicAtStart && measured.iconicAtEnd) ||
        measured.frames.some((frame) => !frame.iconic),
      'the window did not stay minimized across the sample — inconclusive, not a failure'
    )
    expect(
      measured.frames.length,
      'the mirror produced no frames, so neither claim below was evaluated'
    ).toBe(SAMPLE_FRAMES)

    // What DWM thinks it is showing. A source sized to the shell's thumbnail box rather than to the
    // window means the iconic representation is in force and the preview is capped there.
    console.log(
      `[taskbar-thumbnail] dwm source ${measured.sourceWidth}x${measured.sourceHeight}, ` +
        `frames ${JSON.stringify(measured.frames)}`
    )

    // SPATIAL, half one. Mirror background surviving into a frame is a region DWM never covered.
    const worstUnpainted = Math.max(...measured.frames.map((frame) => frame.unpaintedPct))
    expect(
      worstUnpainted,
      `the thumbnail left ${worstUnpainted}% of its box undrawn — the window does not fill its own preview`
    ).toBeLessThan(1)

    // SPATIAL, half two — and the half that matches the reported defect.
    //
    // The check above cannot fail on an all-black thumbnail, because black is a colour DWM did draw.
    //
    // Both thresholds are bracketed by measurement on both sides, not chosen. A minimized window
    // showing a solid black page scored 30 quantised colours and 92.05% near-black; this window,
    // correct, scores 79-109 colours and 0% near-black. A first attempt put the colour floor at 24
    // and would have PASSED the blank control -- the control caught it, which is the whole reason
    // for driving a failing branch rather than reasoning about one.
    //
    // Two indicators rather than one, and either may condemn: colour count is the theme-proof
    // measure (a dark window is still full of text, chrome and edges), while the near-black fraction
    // catches a uniform surface whose few chrome pixels happen to lift its palette over the floor.
    const poorestFrame = measured.frames.reduce((worst, frame) =>
      frame.distinctColours < worst.distinctColours ? frame : worst
    )
    const blankest = measured.frames.reduce((worst, frame) =>
      frame.nearBlackPct > worst.nearBlackPct ? frame : worst
    )
    expect(
      poorestFrame.distinctColours,
      `the taskbar thumbnail carries almost no colour (${poorestFrame.distinctColours} quantised, ` +
        `${poorestFrame.nearBlackPct}% near-black) — it is a blank rectangle, not a picture of the window`
    ).toBeGreaterThan(48)
    expect(
      blankest.nearBlackPct,
      `the taskbar thumbnail is ${blankest.nearBlackPct}% near-black over ` +
        `${blankest.distinctColours} quantised colours — the window is not in its own preview`
    ).toBeLessThan(85)

    // TEMPORAL. The terminal advanced and the window stayed minimized, so the picture must have moved.
    expect(
      await getTerminalContent(orcaPage),
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
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.restore()
    })
  }
})
