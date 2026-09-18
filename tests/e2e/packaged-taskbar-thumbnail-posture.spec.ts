/**
 * The taskbar takeover must follow the window's posture, and the visible half had no gate.
 *
 * Every existing taskbar gate measures a MINIMIZED window, because that is the state the custom
 * bitmap exists for. So a build that forced the iconic representation for the window's whole life —
 * the behaviour this repo shipped until `a49dfe9fb` — passed all of them: it is only wrong in the
 * state nothing looked at. Measured on the installed artifact on 2026-09-14, a visible Orca window
 * was serving DWM a 250x148 bitmap while every other application on the same desktop, Cursor
 * included, was composited from its own 1920x1140 surface. That is what the user sees in the taskbar
 * flyout, in Alt+Tab, in Task View and in Peek: a small stale still where the window should be.
 *
 * So the claim here is not "the thumbnail looks right". It is narrower and stronger, and it is the
 * one no supply-side counter can make: WHICH SURFACE IS WINDOWS SERVING. While the window is
 * visible the answer must be the window itself — at which point there is nothing left for Orca to
 * get wrong, because the preview is DWM compositing the real thing, exactly as it does for Cursor.
 *
 * Three postures rather than one, because a single reading cannot distinguish a takeover correctly
 * released from a takeover that never engaged, and those need opposite fixes. Both edges are
 * asserted, so a fix that simply disabled the feature fails the middle one.
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
import { nativeWindowHandleToNumber } from './helpers/dwm-thumbnail-mirror'
import {
  classifyThumbnailPosture,
  readDwmThumbnailSource,
  type DwmThumbnailPosture
} from './helpers/dwm-thumbnail-source'

const POSTURE_TIMEOUT_MS = 20_000

/**
 * A posture reading is polled rather than taken once: the two transitions are asynchronous on both
 * sides. Engaging needs DWM to demand a bitmap and the app to answer it, and until that first supply
 * a window that will be served from a bitmap still reports its own rect — an early reading describes
 * a moment the verdict is not about.
 */
async function expectPosture(
  hwnd: number,
  expected: DwmThumbnailPosture,
  when: string
): Promise<void> {
  let last: ReturnType<typeof readDwmThumbnailSource> = null
  await expect
    .poll(
      () => {
        last = readDwmThumbnailSource(hwnd)
        return last ? classifyThumbnailPosture(last) : 'unreadable'
      },
      {
        timeout: POSTURE_TIMEOUT_MS,
        message:
          `${when}: Windows should be serving the ${expected} for this window. ` +
          `Last reading: ${JSON.stringify(last)}`
      }
    )
    .toBe(expected)
}

test('a packaged window hands its thumbnail back to DWM whenever it is not minimized @headful', async (// oxlint-disable-next-line no-empty-pattern -- this spec owns its own launch and opts out of the app fixture.
{}, testInfo) => {
  test.skip(process.platform !== 'win32', 'the taskbar thumbnail is a Windows surface')
  const executablePath = resolvePackagedOrcaExecutable()
  test.skip(
    executablePath === null,
    `no packaged Windows artifact at ${PACKAGED_ORCA_APP_DIR} — build it before this gate can say anything`
  )
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'global setup did not produce a seeded test repo')

  test.setTimeout(420_000)

  let run: PackagedOrcaRun | null = null
  try {
    run = await launchPackagedOrca({ executablePath: executablePath as string, repoPath, testInfo })
    const { app } = run

    const hwnd = nativeWindowHandleToNumber(
      Buffer.from(
        await app.evaluate(({ BrowserWindow }) => {
          const [window] = BrowserWindow.getAllWindows()
          return Array.from(window?.getNativeWindowHandle() ?? [])
        })
      )
    )
    expect(
      hwnd,
      'the packaged window surrendered no native handle — setup failure'
    ).toBeGreaterThan(0)

    // The instrument has to be able to return the other answer before its answers mean anything.
    const baseline = readDwmThumbnailSource(hwnd)
    test.skip(
      baseline === null,
      'the thumbnail-source probe could not run — setup failure, not a verdict'
    )

    await expectPosture(hwnd, 'window-surface', 'while the window is visible')

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

    // The other pole. Without it, a fix that simply never engaged the takeover would satisfy both
    // visible assertions and silently delete the only state the custom bitmap exists for.
    await expectPosture(hwnd, 'supplied-bitmap', 'while the window is minimized')

    await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      window?.restore()
    })
    const reallyRestored = await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows()
      return !(window?.isMinimized() ?? true)
    })
    test.skip(!reallyRestored, 'window manager refused the programmatic restore — inconclusive')

    await expectPosture(hwnd, 'window-surface', 'after the window is restored')
  } finally {
    await run?.dispose()
  }
})
