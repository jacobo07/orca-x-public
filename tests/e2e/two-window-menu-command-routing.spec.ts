/**
 * A menu command acts on the window whose menu invoked it.
 *
 * Electron hands every menu click the invoking BrowserWindow. Three handlers in main already use it
 * — the setup guide, the crash report and the feature tour, the last with a comment saying it exists
 * so "multi-window flows route to the right renderer, not global focus". The Terminal commands, the
 * zoom commands and the sidebar toggles used to discard that argument and send to a module-level
 * `mainWindow` instead, which is assigned on every window creation and never on focus. So it named
 * the most recently created window, and a command invoked from any older window landed in the newest.
 *
 * Observed directly rather than through a side effect: the assertion is which renderer received the
 * IPC, because a side effect can also fail to appear for reasons that have nothing to do with routing
 * (no project bound, a broadcast that reaches both windows, a preference that is profile-global).
 *
 * Windows are identified through `electronApp.browserWindow(page)`, never by position in
 * `BrowserWindow.getAllWindows()`. That order is not creation order, and an earlier version of this
 * spec indexed into it — which was invisible while the handler ignored the window argument entirely,
 * because then every invocation went to the same place no matter what was passed.
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

/** Record every terminal menu command this renderer receives. */
async function installRouteProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const received: string[] = []
    ;(window as unknown as { __menuRoute: string[] }).__menuRoute = received
    window.api.ui.onTerminalCommand((command) => {
      received.push(command)
    })
  })
}

async function readRouteProbe(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __menuRoute?: string[] }).__menuRoute ?? [])
}

/**
 * Invoke the first Terminal-menu command as the window that owns `page`.
 *
 * The top-level index is the registered position rather than a translated label — the same identity
 * the strip itself travels on, so this does not break on a Spanish host.
 */
async function invokeNewTerminalAs(electronApp: ElectronApplication, page: Page): Promise<void> {
  const browserWindow = await electronApp.browserWindow(page)
  await electronApp.evaluate(({ Menu }, invokingWindow) => {
    const menu = Menu.getApplicationMenu()
    if (!menu) {
      throw new Error('no application menu registered')
    }
    // File, Edit, Terminal, View, Window, Help — Terminal is the third on non-darwin.
    const terminalMenu = menu.items[2]
    const newTerminal = terminalMenu?.submenu?.items[0]
    if (!newTerminal?.click) {
      throw new Error(`no clickable first item under top-level menu "${terminalMenu?.label}"`)
    }
    // Electron's documented call shape, which is what the handlers are written against.
    ;(newTerminal.click as unknown as (item: unknown, window: unknown, event: unknown) => void)(
      newTerminal,
      invokingWindow,
      {}
    )
  }, browserWindow)
}

test('a terminal menu command acts on the window that invoked it', async ({
  sharedPage,
  electronApp
}) => {
  test.skip(process.platform === 'darwin', 'macOS keeps its native menu bar')
  test.setTimeout(240_000)

  await expect(sharedPage.locator('[data-workspace-activity-rail]')).toBeVisible({ timeout: 60_000 })

  const secondWindow = await Promise.all([
    electronApp.waitForEvent('window', { timeout: 60_000 }),
    sharedPage.evaluate(() => window.api.ui.createWindow())
  ]).then(([page]) => page)
  await secondWindow.waitForLoadState('domcontentloaded')
  await expect
    .poll(async () => getStoreState<boolean>(secondWindow, 'persistedUIReady'), { timeout: 60_000 })
    .toBe(true)

  try {
    await installRouteProbe(sharedPage)
    await installRouteProbe(secondWindow)

    // The first window is not the most recently created one, so this is the case the old singleton
    // got wrong: it delivered to the second window instead.
    await invokeNewTerminalAs(electronApp, sharedPage)
    await expect
      .poll(async () => readRouteProbe(sharedPage), { timeout: 15_000 })
      .toEqual(['newTerminal'])
    expect(
      await readRouteProbe(secondWindow),
      'a command invoked from the first window was delivered to the second'
    ).toEqual([])

    // And the other direction, so this cannot pass by always answering "the first window".
    await invokeNewTerminalAs(electronApp, secondWindow)
    await expect
      .poll(async () => readRouteProbe(secondWindow), { timeout: 15_000 })
      .toEqual(['newTerminal'])
    expect(
      await readRouteProbe(sharedPage),
      'a command invoked from the second window also reached the first'
    ).toEqual(['newTerminal'])
  } finally {
    await secondWindow.close()
  }
})
