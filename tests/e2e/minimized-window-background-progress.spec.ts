/**
 * Minimizing a window must not stop the work running inside it.
 *
 * Main decides terminal delivery policy from which pane is showing a PTY. That claim stays true
 * while the OS minimizes the window around the pane, and past 256KB of undrained bytes the producer
 * flow controller calls node-pty pause() — which stops reading the master fd and blocks the child on
 * write. So the failure this guards is not a rendering artefact: the program actually stops.
 *
 * Evidence is a file the workload appends to, read by the test process. That is deliberate. Anything
 * read through the renderer cannot distinguish "the work stopped" from "the window that would have
 * shown it is minimized", which is the whole question. The terminal is never consulted for progress.
 *
 * The workload emits 16KB per tick because a quiet one cannot fail this test: under the watermark
 * nothing pauses with or without the fix, and a fixture that cannot express the failure reports the
 * same green either way.
 *
 * Preconditions are asserted, not assumed — the workload must be advancing before minimize, and the
 * window must really be minimized. Either one unmet makes the run inconclusive rather than passing.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneIdentitySnapshot } from './helpers/terminal'

/**
 * Each tick appends one line and writes this much stdout.
 *
 * Sized against the 256KB producer watermark, not against volume. What matters is that output
 * outruns the drain once the drain is throttled — at 1/minute it does so within seconds even at
 * 20KB/s. An earlier version wrote 320KB/s, which crossed the watermark no faster and pushed ~105MB
 * through a five-minute hold: the run was OOM-killed, so the load generator became part of the
 * system under test and the gate measured the host instead of the product.
 */
const TICK_CHUNK_CHARS = 2 * 1024
const TICK_INTERVAL_MS = 100
const TOTAL_TICKS = 20_000
/**
 * How long the window stays minimized.
 *
 * Chromium throttles a hidden renderer's timers to 1/second immediately but escalates to *intensive*
 * throttling — 1/minute — only after five minutes hidden. A twenty-second hold sits entirely inside
 * the lenient window, and a check standing there reports the same answer for a fixed and an unfixed
 * build. Overridable so a reproduction hunt can lengthen it without editing the gate.
 */
const MINIMIZED_HOLD_MS = Number(process.env.ORCA_E2E_MINIMIZE_HOLD_MS) || 330_000
/**
 * A third of the ticks a free run manages, so ordinary slowdown is not read as a stall.
 *
 * Measured on Windows 11, headful, local PTY: 246 ticks across a 30s minimize against 300 nominal —
 * 82% of foreground throughput. The floor sits well below that and far above the ~0 a paused
 * producer would yield, which is the distance this gate exists to see. Raising it to an impossible
 * value is what established the measurement works at all: it then failed quoting a real count,
 * rather than passing because nothing was being read.
 */
const MIN_TICKS_WHILE_MINIMIZED = Math.floor(MINIMIZED_HOLD_MS / TICK_INTERVAL_MS / 3)
/** Ticks that prove the workload was alive before we minimized anything. */
const MIN_TICKS_BEFORE_MINIMIZE = 10

function heartbeatWorkload(heartbeatPath: string): string {
  return `
const fs = require('node:fs')
const beat = ${JSON.stringify(heartbeatPath)}
const chunk = 'x'.repeat(${TICK_CHUNK_CHARS})
let tick = 0
const timer = setInterval(() => {
  tick += 1
  fs.appendFileSync(beat, tick + '\\n')
  process.stdout.write(chunk)
  if (tick >= ${TOTAL_TICKS}) {
    clearInterval(timer)
    process.exit(0)
  }
}, ${TICK_INTERVAL_MS})
`
}

function readTickCount(heartbeatPath: string): number {
  if (!existsSync(heartbeatPath)) {
    return 0
  }
  const lines = readFileSync(heartbeatPath, 'utf8').trim().split('\n')
  const last = lines[lines.length - 1]
  const parsed = Number.parseInt(last ?? '', 10)
  return Number.isFinite(parsed) ? parsed : 0
}

// @headful because a headless Electron window has no window manager to honour a minimize: the call
// would no-op, and a check standing on the permissive side of that gap reports the same answer for
// both worlds.
test('a minimized window keeps advancing the work running inside it @headful', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(MINIMIZED_HOLD_MS + 180_000)

  // Arrange — a real terminal in this test's own Electron instance.
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const paneSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = paneSnapshot.panes[0]?.ptyId
  expect(ptyId, 'the fixture must leave a live PTY to measure').toBeTruthy()

  const runDir = path.join(tmpdir(), `orca-minimize-progress-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })
  const heartbeatPath = path.join(runDir, 'heartbeat.log')

  const staged = await runNodeScriptInTerminal(
    orcaPage,
    ptyId as string,
    heartbeatWorkload(heartbeatPath),
    { dir: runDir, prefix: 'orca-minimize-progress' }
  )

  try {
    // Precondition — the workload is actually running. Without this, a minimized run that never
    // started would read exactly like one that was paused.
    await expect
      .poll(() => readTickCount(heartbeatPath), {
        timeout: 30_000,
        message: 'the workload never advanced while visible — setup failure, not a product result'
      })
      .toBeGreaterThanOrEqual(MIN_TICKS_BEFORE_MINIMIZE)

    // Act — minimize for real, through the main process.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.minimize()
    })

    // Precondition — some window managers ignore a programmatic minimize. A run where the window
    // never left the screen proves nothing about minimized execution either way.
    const reallyMinimized = await electronApp.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      return window?.isMinimized() ?? false
    })
    test.skip(
      !reallyMinimized,
      'window manager refused the programmatic minimize — inconclusive, not a pass'
    )

    const ticksAtMinimize = readTickCount(heartbeatPath)
    await new Promise((resolve) => setTimeout(resolve, MINIMIZED_HOLD_MS))
    const ticksWhileMinimized = readTickCount(heartbeatPath) - ticksAtMinimize

    // Assert — measured from the filesystem, never from the terminal.
    expect(
      ticksWhileMinimized,
      `the workload advanced only ${ticksWhileMinimized} ticks across ${MINIMIZED_HOLD_MS}ms minimized`
    ).toBeGreaterThanOrEqual(MIN_TICKS_WHILE_MINIMIZED)

    // Restore, and require more than "the window reappeared": the terminal has to keep advancing
    // afterwards, which a wedged renderer or a producer left paused would not do.
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
        { timeout: 15_000, message: 'the window never left the minimized state' }
      )
      .toBe(false)

    const ticksAfterRestore = readTickCount(heartbeatPath)
    await expect
      .poll(() => readTickCount(heartbeatPath), {
        timeout: 20_000,
        message: 'the workload stopped advancing after the window was restored'
      })
      .toBeGreaterThan(ticksAfterRestore)
  } finally {
    staged.cleanup()
    rmSync(runDir, { recursive: true, force: true })
  }
})
