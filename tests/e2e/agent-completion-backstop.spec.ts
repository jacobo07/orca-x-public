import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

// Four panes run a silent stand-in agent: no hooks, no titles. The only thing that can tell
// Orca one of them exited is the process-exit backstop, which now asks for every pane of a
// window in one call per tick.

const PANES = 4
const stage = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-backstop-'))
const agentPath = path.join(stage, 'gemini.exe')
const stopFile = (index: number) => path.join(stage, `stop-${index}`)

// Why an exe: the Windows foreground scan names processes by image; a script would read as node.
const agentSource = String.raw`using System.IO; using System.Threading;
class StandInAgent {
  static void Main(string[] args) {
    while (!File.Exists(args[0])) Thread.Sleep(200);
  }
}`

type InspectLogEntry = {
  at: number
  channel: string
  ids: string[]
  foreground: Record<string, string | null>
}
type NotificationDispatch = { source?: string; terminalTitle?: string; paneKey?: string }
type PaneHandle = { ptyId: string; paneKey: string }

async function installInspectionSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, args: unknown) => Promise<unknown>
    const g = globalThis as unknown as {
      __backstopInspectLog?: InspectLogEntry[]
      __backstopNotifications?: NotificationDispatch[]
    }
    if (g.__backstopInspectLog) {
      return
    }
    g.__backstopInspectLog = []
    g.__backstopNotifications = []
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
      ._invokeHandlers
    const single = handlers?.get('pty:inspectProcess')
    const batch = handlers?.get('pty:inspectProcesses')
    if (!handlers || !single || !batch) {
      throw new Error('inspection handlers are not registered')
    }
    handlers.set('pty:inspectProcess', async (event, args) => {
      const id = (args as { id: string }).id
      const result = (await single(event, args)) as { foregroundProcess: string | null }
      g.__backstopInspectLog!.push({
        at: Date.now(),
        channel: 'single',
        ids: [id],
        foreground: { [id]: result.foregroundProcess }
      })
      return result
    })
    handlers.set('pty:inspectProcesses', async (event, args) => {
      const entries = (await batch(event, args)) as {
        id: string
        status: string
        inspection?: { foregroundProcess: string | null }
      }[]
      g.__backstopInspectLog!.push({
        at: Date.now(),
        channel: 'batch',
        ids: entries.map((entry) => entry.id),
        foreground: Object.fromEntries(
          entries.map((entry) => [entry.id, entry.inspection?.foregroundProcess ?? null])
        )
      })
      return entries
    })
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle('notifications:dispatch', (_event: unknown, dispatch: NotificationDispatch) => {
      g.__backstopNotifications!.push(dispatch)
      return { delivered: true }
    })
  })
}

async function readSpy(app: ElectronApplication) {
  return app.evaluate(() => {
    const g = globalThis as unknown as {
      __backstopInspectLog?: InspectLogEntry[]
      __backstopNotifications?: NotificationDispatch[]
    }
    return {
      inspections: [...(g.__backstopInspectLog ?? [])],
      notifications: [...(g.__backstopNotifications ?? [])],
      now: Date.now()
    }
  })
}

async function readPanes(page: Page): Promise<PaneHandle[]> {
  return page.evaluate(() => {
    for (const [tabId, manager] of window.__paneManagers ?? []) {
      const panes = manager.getPanes?.() ?? []
      if (panes.length > 1) {
        return panes.map((pane) => ({
          ptyId: (pane as { container: HTMLElement }).container.dataset.ptyId ?? '',
          paneKey: `${tabId}:${(pane as { leafId: string }).leafId}`
        }))
      }
    }
    return []
  })
}

async function readBackstop(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        __orcaAgentProcessBackstop?: () => { scheduled: number; timerArmed: boolean }
      }
    ).__orcaAgentProcessBackstop?.()
  )
}

const isAgent = (name: string | null | undefined) => /gemini/i.test(name ?? '')

test.describe('agent completion backstop', () => {
  test.skip(process.platform !== 'win32', 'the stand-in agent is a compiled Windows exe')

  test.beforeAll(() => {
    const sourcePath = path.join(stage, 'agent.cs')
    writeFileSync(sourcePath, agentSource)
    execFileSync(
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      ['/nologo', '/target:exe', `/out:${agentPath}`, sourcePath],
      { stdio: 'pipe' }
    )
  })

  test.afterAll(() => {
    for (let i = 0; i < PANES; i++) {
      writeFileSync(stopFile(i), '')
    }
    // Why: give the stand-ins a moment to see their stop files before the stage goes.
    setTimeout(() => rmSync(stage, { recursive: true, force: true }), 1_000)
  })

  test('one silent exit is found by the shared backstop, and only for its pane', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installInspectionSpy(electronApp)

    for (let i = 1; i < PANES; i++) {
      await splitActiveTerminalPane(orcaPage, i % 2 === 0 ? 'vertical' : 'horizontal')
    }
    await waitForPaneCount(orcaPage, PANES, 20_000)
    await expect
      .poll(async () => (await readPanes(orcaPage)).filter((pane) => pane.ptyId).length, {
        timeout: 30_000,
        message: 'every pane should be bound to a PTY'
      })
      .toBe(PANES)
    const panes = await readPanes(orcaPage)

    for (const [index, pane] of panes.entries()) {
      await execInTerminal(orcaPage, pane.ptyId, `${agentPath} ${stopFile(index)}`)
    }

    // Why: a recognition timeout otherwise says nothing about what the backstop did see.
    test.info().annotations.push({ type: 'panes', description: JSON.stringify(panes) })
    const describeSeen = async () => {
      const { inspections } = await readSpy(electronApp)
      const names = new Set<string>()
      for (const entry of inspections.slice(-20)) {
        for (const name of Object.values(entry.foreground)) {
          names.add(String(name))
        }
      }
      return JSON.stringify({ calls: inspections.length, recentForeground: [...names] })
    }
    // Every stand-in is seen as an agent by the backstop itself.
    await expect
      .poll(
        async () => {
          const { inspections } = await readSpy(electronApp)
          const seen = new Set<string>()
          for (const entry of inspections) {
            for (const [id, name] of Object.entries(entry.foreground)) {
              if (isAgent(name)) {
                seen.add(id)
              }
            }
          }
          return panes.filter((pane) => seen.has(pane.ptyId)).length
        },
        { timeout: 60_000, message: 'the backstop never recognized every stand-in agent' }
      )
      .toBe(PANES)
      .catch(async (error: unknown) => {
        test.info().annotations.push({ type: 'seen', description: await describeSeen() })
        throw error
      })

    // Steady state: one timer, one call per tick carrying every pane, no per-pane calls.
    const windowStart = (await readSpy(electronApp)).now
    await orcaPage.waitForTimeout(6_000)
    const steady = await readSpy(electronApp)
    const inWindow = steady.inspections.filter((entry) => entry.at >= windowStart)
    const paneIds = new Set(panes.map((pane) => pane.ptyId))
    const batchCalls = inWindow.filter((entry) => entry.channel === 'batch')
    const singleCallsForPanes = inWindow.filter(
      (entry) => entry.channel === 'single' && paneIds.has(entry.ids[0]!)
    )
    const backstop = await readBackstop(orcaPage)
    test.info().annotations.push({
      type: 'steady-state',
      description: JSON.stringify({
        windowMs: steady.now - windowStart,
        batchCalls: batchCalls.length,
        idsPerCall: batchCalls.map((entry) => entry.ids.length),
        singleCallsForPanes: singleCallsForPanes.length,
        backstop
      })
    })
    expect(backstop).toMatchObject({ scheduled: PANES, timerArmed: true })
    expect(singleCallsForPanes).toEqual([])
    expect(batchCalls.length).toBeGreaterThan(0)
    // One tick is at most one call per 70% of the 750 ms tier.
    expect(batchCalls.length).toBeLessThanOrEqual(Math.ceil((steady.now - windowStart) / 525) + 1)
    expect(Math.max(...batchCalls.map((entry) => entry.ids.length))).toBe(PANES)

    // Stop one agent from outside Electron. No hook, no title: only the backstop can see it.
    const target = panes[2]!
    const stoppedAt = Date.now()
    writeFileSync(stopFile(2), '')

    await expect
      .poll(
        async () =>
          (await readSpy(electronApp)).notifications.filter(
            (dispatch) => dispatch.source === 'agent-task-complete'
          ),
        { timeout: 30_000, message: 'the silent exit was never noticed' }
      )
      .toEqual([expect.objectContaining({ paneKey: target.paneKey })])
    const after = await readSpy(electronApp)
    const completion = after.notifications.find((d) => d.source === 'agent-task-complete')!
    test.info().annotations.push({
      type: 'backstop-detection',
      description: JSON.stringify({
        latencyMs: after.now - stoppedAt,
        terminalTitle: completion.terminalTitle
      })
    })
    // Why: only the process-exit path names the completion after the process.
    expect(completion.terminalTitle).toMatch(/gemini/i)

    // The other agents are still live and still asked about.
    const latest = after.inspections.findLast((entry) => entry.channel === 'batch')!
    for (const [index, pane] of panes.entries()) {
      if (index !== 2) {
        expect(isAgent(latest.foreground[pane.ptyId])).toBe(true)
      }
    }
    await orcaPage.waitForTimeout(3_000)
    expect(
      (await readSpy(electronApp)).notifications.filter(
        (dispatch) => dispatch.source === 'agent-task-complete'
      )
    ).toHaveLength(1)
  })
})
