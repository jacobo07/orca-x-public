/**
 * Force Reload recovers a window whose renderer no longer answers, by replacing the renderer
 * process — and leaves a responsive window, a cancelled confirm and every other window alone.
 *
 * The renderer is hung for real (`for (;;)` on its main thread), so the in-place reload Force used
 * to do cannot help it. Observation after the replacement runs from MAIN: a crashed renderer severs
 * Playwright's CDP session for that window even though main loads a new one.
 *
 * The native confirm is stubbed at Electron's `dialog` boundary and every call is recorded, so the
 * spec asserts what the user is asked (Cancel default) as well as what happens after the answer.
 */

import type { ElectronApplication, JSHandle, Page } from '@stablyai/playwright-test'
import type { BrowserWindow } from 'electron'
import type * as NodeFs from 'node:fs'
import type * as NodePath from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, getStoreState, waitForActiveWorktree } from './helpers/store'
import {
  discoverActivePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { probeDirectWriteOutput } from './helpers/terminal-fresh-output-probes'
import { readMainPtyWindowClaims } from './helpers/main-pty-window-claims'

type DialogCall = {
  type: string | null
  message: string
  buttons: string[]
  defaultId: number | null
  cancelId: number | null
}

type MainProbe = {
  dialogs: DialogCall[]
  gone: { webContentsId: number; reason: string }[]
  loads: Record<string, number>
}

type WindowFacts = { webContentsId: number; pid: number; crashed: boolean }

const REPLACEMENT_TIMEOUT_MS = 60_000

/**
 * Stub the native dialog with queued answers and watch every window's renderer lifecycle.
 * Re-arming queues new answers and attaches to windows created since; records accumulate.
 */
async function armMainProbe(electronApp: ElectronApplication, answers: number[]): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, dialog }, queued) => {
    type State = {
      dialogs: DialogCall[]
      gone: { webContentsId: number; reason: string }[]
      loads: Record<string, number>
      answers: number[]
      attached: Set<number>
    }
    const scope = globalThis as unknown as { __forceReloadProbe?: State }
    const probe: State = scope.__forceReloadProbe ?? {
      dialogs: [],
      gone: [],
      loads: {},
      answers: [],
      attached: new Set<number>()
    }
    if (!scope.__forceReloadProbe) {
      scope.__forceReloadProbe = probe
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = (args.length > 1 ? args[1] : args[0]) as Electron.MessageBoxOptions
        probe.dialogs.push({
          type: options.type ?? null,
          message: options.message,
          buttons: options.buttons ?? [],
          defaultId: options.defaultId ?? null,
          cancelId: options.cancelId ?? null
        })
        return { response: probe.answers.shift() ?? 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    }
    probe.answers.push(...queued)
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents
      if (probe.attached.has(contents.id)) {
        continue
      }
      probe.attached.add(contents.id)
      contents.on('render-process-gone', (_event, details) => {
        probe.gone.push({ webContentsId: contents.id, reason: details.reason })
      })
      contents.on('did-finish-load', () => {
        probe.loads[contents.id] = (probe.loads[contents.id] ?? 0) + 1
      })
    }
  }, answers)
}

async function readMainProbe(electronApp: ElectronApplication): Promise<MainProbe> {
  return electronApp.evaluate(() => {
    const probe = (globalThis as unknown as { __forceReloadProbe?: MainProbe }).__forceReloadProbe
    return {
      dialogs: probe?.dialogs ?? [],
      gone: probe?.gone ?? [],
      loads: { ...probe?.loads }
    }
  })
}

async function windowFacts(
  electronApp: ElectronApplication,
  window: JSHandle<BrowserWindow>
): Promise<WindowFacts> {
  return electronApp.evaluate(
    (_electron, target) => ({
      webContentsId: target.webContents.id,
      pid: target.webContents.getOSProcessId(),
      crashed: target.webContents.isCrashed()
    }),
    window
  )
}

/** Runs in the window's renderer through main, so it works after Playwright lost the page. */
async function evalInWindow<T>(
  electronApp: ElectronApplication,
  window: JSHandle<BrowserWindow>,
  expression: string,
  timeoutMs = 2_000
): Promise<T | 'no-answer'> {
  return electronApp.evaluate(
    async (_electron, { target, expr, timeout }) => {
      const answer = target.webContents.executeJavaScript(expr, true)
      const late = new Promise<'no-answer'>((resolve) =>
        setTimeout(() => resolve('no-answer'), timeout)
      )
      return Promise.race([answer, late]).catch(() => 'no-answer' as const)
    },
    { target: window, expr: expression, timeout: timeoutMs }
  ) as Promise<T | 'no-answer'>
}

async function crashReportCount(electronApp: ElectronApplication): Promise<number> {
  return electronApp.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('node:fs') as typeof NodeFs
    const path = process.getBuiltinModule('node:path') as typeof NodePath
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(app.getPath('userData'), 'crash-reports.json'), 'utf8')
      ) as unknown
      const reports = Array.isArray(parsed)
        ? parsed
        : ((parsed as { reports?: unknown[] } | null)?.reports ?? [])
      return reports.length
    } catch {
      return 0
    }
  })
}

/** View > Force Reload, invoked as `window` — the menu path a user takes. Found by role, not label. */
async function clickForceReload(
  electronApp: ElectronApplication,
  window: JSHandle<BrowserWindow>
): Promise<void> {
  await electronApp.evaluate(({ Menu }, invokingWindow) => {
    const viewMenu = Menu.getApplicationMenu()?.items.find((item) =>
      item.submenu?.items.some((entry) => entry.role?.toLowerCase() === 'toggledevtools')
    )
    const forceReload = viewMenu?.submenu?.items[1]
    if (!forceReload?.click) {
      throw new Error('View > Force Reload is not registered')
    }
    ;(forceReload.click as unknown as (item: unknown, window: unknown, event: unknown) => void)(
      forceReload,
      invokingWindow,
      {}
    )
  }, window)
}

/** Hang the renderer's main thread; the evaluate itself returns before the loop starts. */
async function hangRenderer(page: Page): Promise<void> {
  await page.evaluate(() => {
    setTimeout(() => {
      for (;;) {
        // A renderer that never yields: no IPC answer, no unload, no paint.
      }
    }, 50)
  })
}

async function expectHung(electronApp: ElectronApplication, window: JSHandle<BrowserWindow>) {
  // Station control: the spec only means something if the renderer really stopped answering.
  await expect
    .poll(async () => evalInWindow(electronApp, window, '1', 1_000), {
      timeout: 15_000,
      message: 'the renderer still answers, so the hang never took hold'
    })
    .toBe('no-answer')
}

async function expectWorkspaceReady(
  electronApp: ElectronApplication,
  window: JSHandle<BrowserWindow>
): Promise<void> {
  await expect
    .poll(
      async () =>
        evalInWindow<boolean>(
          electronApp,
          window,
          'Boolean(window.__store && window.__store.getState().workspaceSessionReady === true)'
        ),
      { timeout: REPLACEMENT_TIMEOUT_MS, message: 'the new renderer never loaded the workspace' }
    )
    .toBe(true)
}

test.describe('Force Reload renderer replacement', () => {
  // oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
  test.beforeEach(({}, testInfo) => {
    testInfo.setTimeout(240_000)
  })

  test('a responsive window keeps its renderer process and is asked nothing', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForActiveWorktree(orcaPage)
    const window = await electronApp.browserWindow(orcaPage)
    await armMainProbe(electronApp, [])
    const before = await windowFacts(electronApp, window)
    expect(before.pid, 'precondition: the renderer has a process').toBeGreaterThan(0)

    await clickForceReload(electronApp, window)

    await expect
      .poll(async () => (await readMainProbe(electronApp)).loads[before.webContentsId] ?? 0, {
        timeout: 30_000,
        message: 'Force Reload of an answering renderer never reloaded it'
      })
      .toBeGreaterThan(0)
    await expectWorkspaceReady(electronApp, window)
    const after = await windowFacts(electronApp, window)
    const probe = await readMainProbe(electronApp)
    expect(after.pid, 'an answering renderer must be reloaded in place').toBe(before.pid)
    expect(probe.dialogs, 'an answering renderer must not trigger the confirm').toEqual([])
    expect(probe.gone).toEqual([])
  })

  test('a hung window: Cancel leaves it untouched, confirming starts a new renderer process', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)
    const ptyId = await discoverActivePtyId(orcaPage)
    expect(await probeDirectWriteOutput(orcaPage, ptyId, 'FORCE_BASELINE')).toBe(true)

    const window = await electronApp.browserWindow(orcaPage)
    await armMainProbe(electronApp, [0])
    const before = await windowFacts(electronApp, window)
    const reportsBefore = await crashReportCount(electronApp)

    await hangRenderer(orcaPage)
    await expectHung(electronApp, window)

    // Cancel.
    await clickForceReload(electronApp, window)
    await expect
      .poll(async () => (await readMainProbe(electronApp)).dialogs.length, {
        timeout: 15_000,
        message: 'Force Reload of a hung renderer never asked before replacing it'
      })
      .toBe(1)
    const [confirm] = (await readMainProbe(electronApp)).dialogs
    expect(confirm.buttons, 'the confirm offers Cancel and the replacement').toHaveLength(2)
    expect(confirm.defaultId, 'Cancel is the default').toBe(0)
    expect(confirm.cancelId, 'Escape answers Cancel').toBe(0)
    // Give a wrongly-proceeding Cancel time to show itself.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const cancelled = await windowFacts(electronApp, window)
    expect(cancelled.pid, 'Cancel must not replace the renderer').toBe(before.pid)
    expect((await readMainProbe(electronApp)).gone, 'Cancel must not crash the renderer').toEqual(
      []
    )
    expect(await evalInWindow(electronApp, window, '1', 1_000)).toBe('no-answer')

    // Confirm.
    await armMainProbe(electronApp, [1])
    await clickForceReload(electronApp, window)
    await expect
      .poll(async () => (await windowFacts(electronApp, window)).pid, {
        timeout: REPLACEMENT_TIMEOUT_MS,
        message: 'confirming never brought up a new renderer process (a husk has pid 0)'
      })
      .not.toBe(before.pid)
    expect((await windowFacts(electronApp, window)).pid).toBeGreaterThan(0)
    await expectWorkspaceReady(electronApp, window)

    const probe = await readMainProbe(electronApp)
    expect(probe.dialogs).toHaveLength(2)
    expect(probe.gone).toEqual([{ webContentsId: before.webContentsId, reason: 'crashed' }])
    // One load: the replacement's own. Crash recovery stood down instead of reloading again.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect((await readMainProbe(electronApp)).loads[before.webContentsId]).toBe(1)
    expect(await crashReportCount(electronApp), 'a replacement is not a crash').toBe(reportsBefore)

    // The window's terminal session outlived its renderer.
    const ptyIdsAfter = await evalInWindow<string[]>(
      electronApp,
      window,
      'Object.values(window.__store.getState().ptyIdsByTabId).flat()'
    )
    expect(ptyIdsAfter, 'the replaced window lost its terminal session').toContain(ptyId)
  })

  test("another window's renderer and terminal survive a window's replacement", async ({
    orcaPage,
    electronApp
  }) => {
    test.skip(process.platform === 'darwin', 'macOS keeps its native menu bar')
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)
    const ptyId = await discoverActivePtyId(orcaPage)
    // Why output lines: the echoed `echo MARKER` alone matched before, so a frozen survivor passed.
    expect(await probeDirectWriteOutput(orcaPage, ptyId, 'SURVIVOR_BASELINE')).toBe(true)
    const survivor = await electronApp.browserWindow(orcaPage)
    const survivorId = (await windowFacts(electronApp, survivor)).webContentsId
    // Why per-window ids: the union `visible` stays true if the second window shows this PTY too.
    await expect
      .poll(async () => (await readMainPtyWindowClaims(orcaPage, ptyId)).visibleClaimWindowIds, {
        timeout: 15_000,
        message:
          'precondition [MAIN_STATE]: the survivor window claims its terminal visible before a second window exists'
      })
      .toContain(survivorId)

    const secondPage = await Promise.all([
      electronApp.waitForEvent('window', { timeout: 60_000 }),
      orcaPage.evaluate(() => window.api.ui.createWindow())
    ]).then(([page]) => page)
    await secondPage.waitForLoadState('domcontentloaded')
    await expect
      .poll(async () => getStoreState<boolean>(secondPage, 'persistedUIReady'), { timeout: 60_000 })
      .toBe(true)
    // Why one read, no poll: claims are re-sent only on transitions, and a poll could outwait a withdraw.
    const claimsAfterOpen = await readMainPtyWindowClaims(orcaPage, ptyId)
    expect(
      claimsAfterOpen.visibleClaimWindowIds,
      "D6 C1 [MAIN_STATE]: opening a second window withdrew the survivor window's visible claim"
    ).toContain(survivorId)

    const replaced = await electronApp.browserWindow(secondPage)
    await armMainProbe(electronApp, [1])
    const survivorBefore = await windowFacts(electronApp, survivor)
    const replacedBefore = await windowFacts(electronApp, replaced)
    expect(
      replacedBefore.pid,
      'two windows sharing one renderer would make this a refusal test'
    ).not.toBe(survivorBefore.pid)

    await hangRenderer(secondPage)
    await expectHung(electronApp, replaced)
    await clickForceReload(electronApp, replaced)

    await expect
      .poll(async () => (await windowFacts(electronApp, replaced)).pid, {
        timeout: REPLACEMENT_TIMEOUT_MS,
        message: 'the hung window never got a new renderer process'
      })
      .not.toBe(replacedBefore.pid)
    await expect
      .poll(
        async () =>
          evalInWindow<boolean>(
            electronApp,
            replaced,
            'Boolean(window.__store && window.__store.getState().persistedUIReady === true)'
          ),
        { timeout: REPLACEMENT_TIMEOUT_MS }
      )
      .toBe(true)

    const survivorAfter = await windowFacts(electronApp, survivor)
    expect(survivorAfter.pid, 'the other window must keep its renderer').toBe(survivorBefore.pid)
    expect(survivorAfter.crashed).toBe(false)
    expect((await readMainProbe(electronApp)).gone).toEqual([
      { webContentsId: replacedBefore.webContentsId, reason: 'crashed' }
    ])
    const claimsAfterReplace = await readMainPtyWindowClaims(orcaPage, ptyId)
    expect(
      claimsAfterReplace.visibleClaimWindowIds,
      "D6 C3 [MAIN_STATE]: replacing the other window's renderer withdrew the survivor window's visible claim"
    ).toContain(survivorId)
    // Its terminal still round-trips through the PTY, over its own (unbroken) CDP session.
    expect(await probeDirectWriteOutput(orcaPage, ptyId, 'SURVIVOR_AFTER')).toBe(true)
  })
})
