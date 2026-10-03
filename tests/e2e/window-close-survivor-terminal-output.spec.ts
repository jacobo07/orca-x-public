/**
 * Closing a newer window must not stop an older window's terminal from receiving output (R-05).
 *
 * The PTY delivery machine is bound per window registration, so after the newest window closes its
 * `mainWindow.isDestroyed()` guard used to read true for every other window's PTY. The close is
 * proven first (station controls from main), and a side effect proves the PTY still ran input, so a
 * missing output line afterwards is a delivery drop rather than a refused write.
 */

import { existsSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getStoreState, waitForActiveWorktree } from './helpers/store'
import {
  discoverActivePtyId,
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { probeDirectWriteOutput } from './helpers/terminal-fresh-output-probes'

type WindowRow = { webContentsId: number; destroyed: boolean }

async function readWindows(electronApp: ElectronApplication): Promise<WindowRow[]> {
  return electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      webContentsId: win.isDestroyed() ? -1 : win.webContents.id,
      destroyed: win.isDestroyed()
    }))
  )
}

test("closing a newer window keeps an older window's terminal output", async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForPaneCount(orcaPage, 1, 30_000)
  const ptyId = await discoverActivePtyId(orcaPage)
  expect(await probeDirectWriteOutput(orcaPage, ptyId, 'R05_BASELINE')).toBe(true)
  const survivor = await electronApp.browserWindow(orcaPage)
  const survivorId = await electronApp.evaluate((_electron, win) => win.webContents.id, survivor)

  const secondPage = await Promise.all([
    electronApp.waitForEvent('window', { timeout: 60_000 }),
    orcaPage.evaluate(() => window.api.ui.createWindow())
  ]).then(([page]) => page)
  await secondPage.waitForLoadState('domcontentloaded')
  await expect
    .poll(async () => getStoreState<boolean>(secondPage, 'persistedUIReady'), { timeout: 60_000 })
    .toBe(true)
  expect((await readWindows(electronApp)).filter((w) => !w.destroyed)).toHaveLength(2)
  // Control while both windows live: isolates the close as the cause of any later miss.
  expect(await probeDirectWriteOutput(orcaPage, ptyId, 'R05_TWO_WINDOWS')).toBe(true)

  await secondPage.close()
  await expect
    .poll(async () => (await readWindows(electronApp)).filter((w) => !w.destroyed), {
      timeout: 30_000,
      message: 'HARNESS: the second window never finished closing'
    })
    .toEqual([{ webContentsId: survivorId, destroyed: false }])

  // Why a side effect: it proves input still ran in A's PTY, so a missing line next is delivery.
  const nonce = randomBytes(6).toString('hex')
  const sentinel = join(tmpdir(), `r05-${nonce}.txt`)
  try {
    await sendToTerminal(orcaPage, ptyId, `echo ${nonce} > "${sentinel}"\r`)
    await expect
      .poll(() => existsSync(sentinel), {
        timeout: 15_000,
        message: "HARNESS: A's PTY never ran input after the close"
      })
      .toBe(true)
  } finally {
    rmSync(sentinel, { force: true })
  }

  expect(
    await probeDirectWriteOutput(orcaPage, ptyId, 'R05_AFTER_CLOSE'),
    "R-05 [USER_VISIBLE]: closing the newer window dropped the older window's terminal output"
  ).toBe(true)
})
