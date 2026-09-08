/**
 * Restoring a minimized window must leave the terminal showing what it has already parsed.
 *
 * The sibling spec (minimized-window-background-progress) measured that the *work* keeps running
 * while minimized, and it does. This one measures the layer after that: whether the pixels catch up
 * on restore. Those are different owners and they fail independently — a terminal can hold current
 * content in its model and present a stale surface, which is what "frozen after restore" looks like
 * from the outside while every process involved is healthy.
 *
 * Three witnesses, one per ownership boundary, so a failure names the first layer that stopped:
 *
 *   CHILD    a heartbeat file the workload appends to, read by the test process
 *   MODEL    xterm's own buffer via the SerializeAddon the PaneManager already loads
 *   PIXELS   a screenshot of the terminal surface
 *
 * Read in that order they localize the fault: child stopped is an execution stall; child advanced
 * but model did not is a delivery/parse stall; model advanced but pixels did not is a presentation
 * stall. Only the third is this spec's subject — the first two are asserted as preconditions, so a
 * run that hits them reports INCONCLUSIVE rather than blaming presentation for someone else's stop.
 *
 * Why the screenshot is clipped to the top of the surface: a blinking cursor repaints one cell, so
 * a full-surface comparison would differ on every run whether or not the content advanced, and a
 * check that cannot return "stale" is not a check. The workload scrolls, so the top rows turn over
 * completely while the cursor stays at the bottom, outside the clip.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

/** Enough rows per tick that a hold turns the visible surface over many times. */
const TICK_INTERVAL_MS = 120
const TOTAL_TICKS = 20_000
/**
 * How long the window stays minimized.
 *
 * Deliberately shorter than the background-progress spec's five-plus minutes. That one had to cross
 * Chromium's intensive-throttling threshold because its subject was whether work keeps running.
 * This subject is what happens at the restore transition, which does not need deep throttling to
 * occur — so the default buys repetition instead of depth. Overridable for a longer hunt.
 */
const MINIMIZED_HOLD_MS = Number(process.env.ORCA_E2E_PRESENTATION_HOLD_MS) || 45_000
/** Ticks that prove the workload was alive before we minimized anything. */
const MIN_TICKS_BEFORE_MINIMIZE = 8
/** Settle window for the restore path's own recovery (refit, WebGL reattach, reveal present). */
const RESTORE_SETTLE_MS = 4_000

function scrollingWorkload(heartbeatPath: string): string {
  return `
const fs = require('node:fs')
const beat = ${JSON.stringify(heartbeatPath)}
let tick = 0
const timer = setInterval(() => {
  tick += 1
  fs.appendFileSync(beat, tick + '\\n')
  // A distinct, wide line per tick: the surface must visibly turn over, and the model text must
  // differ from any earlier sample by content rather than only by length.
  process.stdout.write('ORCA-PRESENT-' + tick + ' ' + '='.repeat(60) + '\\n')
  if (tick >= ${TOTAL_TICKS}) {
    clearInterval(timer)
    process.exit(0)
  }
}, ${TICK_INTERVAL_MS})
`
}

/** Fills the surface, then exits — leaving a full, static screen with the cursor at the bottom. */
function burstThenQuietWorkload(): string {
  return `
for (let i = 1; i <= 200; i += 1) {
  process.stdout.write('ORCA-QUIET-' + i + ' ' + '='.repeat(60) + '\\n')
}
`
}

function readTickCount(heartbeatPath: string): number {
  if (!existsSync(heartbeatPath)) {
    return 0
  }
  const lines = readFileSync(heartbeatPath, 'utf8').trim().split('\n')
  const parsed = Number.parseInt(lines[lines.length - 1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The pixel witness: the upper part of the terminal surface, where scrolled content lives and the
 * cursor does not. Returns null when the surface cannot be measured, which is a setup failure and
 * must not be reported as a presentation result.
 */
async function screenshotTerminalSurface(page: Page): Promise<Buffer | null> {
  const surface = page.locator('.xterm-screen').first()
  const box = await surface.boundingBox()
  if (!box || box.width < 40 || box.height < 40) {
    return null
  }
  return surface.screenshot({
    clip: {
      x: box.x,
      y: box.y,
      width: box.width,
      // Why 55%: keeps the cursor row and the newest lines out of the sample, so a blinking cursor
      // cannot manufacture the difference this assertion is looking for.
      height: Math.floor(box.height * 0.55)
    }
  })
}

// @headful because a headless window has no window manager to honour minimize(): the call no-ops,
// and a check standing on the permissive side of that gap reports the same answer for both worlds.
test('a restored window shows the output it parsed while minimized @headful', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(MINIMIZED_HOLD_MS + 240_000)

  // Arrange — a real terminal in this test's own Electron instance.
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const paneSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = paneSnapshot.panes[0]?.ptyId
  expect(ptyId, 'the fixture must leave a live PTY to measure').toBeTruthy()

  const runDir = path.join(tmpdir(), `orca-restore-presentation-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })
  const heartbeatPath = path.join(runDir, 'heartbeat.log')

  const staged = await runNodeScriptInTerminal(orcaPage, ptyId as string, scrollingWorkload(heartbeatPath), {
    dir: runDir,
    prefix: 'orca-restore-presentation'
  })

  try {
    // Precondition — CHILD is advancing. Without this a minimized run that never started would
    // read exactly like one whose presentation froze.
    await expect
      .poll(() => readTickCount(heartbeatPath), {
        timeout: 30_000,
        message: 'the workload never advanced while visible — setup failure, not a product result'
      })
      .toBeGreaterThanOrEqual(MIN_TICKS_BEFORE_MINIMIZE)

    // Precondition — the surface is measurable before we depend on comparing it.
    const pixelsBefore = await screenshotTerminalSurface(orcaPage)
    expect(
      pixelsBefore,
      'the terminal surface could not be measured before minimize — setup failure'
    ).not.toBeNull()
    const modelBefore = await getTerminalContent(orcaPage)
    expect(modelBefore, 'the terminal model was empty before minimize — setup failure').not.toBe('')

    // Act — minimize for real, through the main process.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.minimize()
    })

    // Precondition — some window managers ignore a programmatic minimize. A run where the window
    // never left the screen proves nothing about restore either way.
    const reallyMinimized = await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      return window?.isMinimized() ?? false
    })
    test.skip(
      !reallyMinimized,
      'window manager refused the programmatic minimize — inconclusive, not a pass'
    )

    await new Promise((resolve) => setTimeout(resolve, MINIMIZED_HOLD_MS))

    // Restore, and wait for the window to actually be back before measuring anything.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.restore()
      window?.focus()
    })
    await expect
      .poll(
        async () =>
          electronApp.evaluate(({ BrowserWindow }) => {
            const [window] = BrowserWindow.getAllWindows()
            return window?.isMinimized() ?? true
          }),
        { timeout: 20_000, message: 'the window never left the minimized state' }
      )
      .toBe(false)

    // Give the restore path its own recovery a settled chance to run. Sampling before it does would
    // describe a moment the verdict is not about.
    await new Promise((resolve) => setTimeout(resolve, RESTORE_SETTLE_MS))

    // Precondition — MODEL advanced. If it did not, the failure is upstream of presentation and
    // this spec is not the instrument that should judge it.
    const modelAfter = await getTerminalContent(orcaPage)
    expect(
      modelAfter,
      'the terminal model did not advance across the minimize — a delivery or parse stall, not a presentation one; inconclusive here'
    ).not.toBe(modelBefore)

    // Assert — PIXELS advanced. The model holds output the surface has never shown if these match.
    const pixelsAfter = await screenshotTerminalSurface(orcaPage)
    expect(
      pixelsAfter,
      'the terminal surface could not be measured after restore — setup failure'
    ).not.toBeNull()
    expect(
      pixelsAfter?.equals(pixelsBefore as Buffer),
      'the restored terminal painted nothing new: its model advanced while minimized but not one pixel of the surface changed — presentation is stale'
    ).toBe(false)
  } finally {
    staged.cleanup()
    rmSync(runDir, { recursive: true, force: true })
  }
})

/**
 * Positive control for the pixel witness.
 *
 * Everything above rests on "identical screenshots mean the surface did not advance". That claim is
 * only worth something if the same comparison reports a difference when the surface *does* advance.
 * This runs the identical measurement over a window that was never minimized: it must see change.
 * If this ever goes red the witness has stopped witnessing, and the main assertion's green above is
 * not evidence of anything.
 */
test('the pixel witness can tell an advancing terminal from a stale one @headful', async ({
  orcaPage
}) => {
  test.setTimeout(180_000)

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const paneSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = paneSnapshot.panes[0]?.ptyId
  expect(ptyId, 'the fixture must leave a live PTY to measure').toBeTruthy()

  const runDir = path.join(tmpdir(), `orca-presentation-control-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })
  const heartbeatPath = path.join(runDir, 'heartbeat.log')

  const staged = await runNodeScriptInTerminal(orcaPage, ptyId as string, scrollingWorkload(heartbeatPath), {
    dir: runDir,
    prefix: 'orca-presentation-control'
  })

  try {
    await expect
      .poll(() => readTickCount(heartbeatPath), {
        timeout: 30_000,
        message: 'the workload never advanced — setup failure, not a product result'
      })
      .toBeGreaterThanOrEqual(MIN_TICKS_BEFORE_MINIMIZE)

    const first = await screenshotTerminalSurface(orcaPage)
    expect(first, 'the terminal surface could not be measured — setup failure').not.toBeNull()

    // Same clip, same comparison, same settle — the only removed variable is the minimize.
    await new Promise((resolve) => setTimeout(resolve, RESTORE_SETTLE_MS))

    const second = await screenshotTerminalSurface(orcaPage)
    expect(second, 'the terminal surface could not be measured — setup failure').not.toBeNull()
    expect(
      second?.equals(first as Buffer),
      'a visibly scrolling terminal produced byte-identical screenshots: the pixel witness is blind, so the minimize assertion it backs proves nothing'
    ).toBe(false)
  } finally {
    staged.cleanup()
    rmSync(runDir, { recursive: true, force: true })
  }
})

/**
 * The other half of the witness self-test, and the half that actually protects the main assertion.
 *
 * The control above proves the comparison can report "changed". But the minimize test *passes* on
 * "changed", so a witness that reported "changed" unconditionally — cursor blink, antialiasing
 * jitter, a repainting status line inside the clip — would leave that test incapable of ever
 * failing while looking perfectly healthy. Only a quiet surface returning byte-identical samples
 * proves the comparison has a reachable "stale" verdict at all.
 *
 * The workload fills the screen and exits, so the sampled region holds settled content and the
 * cursor sits below the clip.
 */
test('the pixel witness reports no change when the surface is quiet @headful', async ({
  orcaPage
}) => {
  test.setTimeout(180_000)

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const paneSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = paneSnapshot.panes[0]?.ptyId
  expect(ptyId, 'the fixture must leave a live PTY to measure').toBeTruthy()

  const runDir = path.join(tmpdir(), `orca-presentation-quiet-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })

  const staged = await runNodeScriptInTerminal(orcaPage, ptyId as string, burstThenQuietWorkload(), {
    dir: runDir,
    prefix: 'orca-presentation-quiet'
  })

  try {
    // Precondition — the burst reached the surface, so the sampled region holds settled content
    // rather than the empty rows a fresh terminal starts with.
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes('ORCA-QUIET-200'), {
        timeout: 30_000,
        message: 'the burst never reached the terminal model — setup failure, not a product result'
      })
      .toBe(true)
    // Let the burst finish painting before the first sample; comparing against a mid-paint frame
    // would report motion that is the workload's, not the witness's noise floor.
    await new Promise((resolve) => setTimeout(resolve, RESTORE_SETTLE_MS))

    const first = await screenshotTerminalSurface(orcaPage)
    expect(first, 'the terminal surface could not be measured — setup failure').not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, RESTORE_SETTLE_MS))
    const second = await screenshotTerminalSurface(orcaPage)
    expect(second, 'the terminal surface could not be measured — setup failure').not.toBeNull()

    expect(
      second?.equals(first as Buffer),
      'a quiet terminal produced differing screenshots: the witness has a noise floor above zero, so "the pixels changed" cannot be trusted to mean the surface advanced'
    ).toBe(true)
  } finally {
    staged.cleanup()
    rmSync(runDir, { recursive: true, force: true })
  }
})
