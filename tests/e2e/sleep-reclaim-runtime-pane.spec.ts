/**
 * Product boundary for "a runtime-backed pane can be offered for sleep".
 *
 * A real Electron client paired to a real headed host. The client opens a
 * terminal that lives on the host, so its liveness is only knowable by asking
 * the host. The Resource Manager must:
 *   - keep the pane awake as unknown while the host cannot answer (a fault at
 *     the client's own runtime-call boundary, nothing faked in the renderer);
 *   - offer it, unmeasured, once a fresh listing proves the PTY live;
 *   - send the host nothing but liveness listings while it is only shown;
 * and Sleep now must stop exactly that host PTY.
 *
 * Supplied by this spec, so NOT proven here: the agent status entry (a plain
 * process has no agent hooks), set in the HOST store and mirrored to the client
 * by the product, and the sleep settings, set in the client store.
 * Staleness between display and click is owned by
 * agent-hibernation-runtime-explicit-sleep.test.ts — every store change
 * re-renders the plan first, so it cannot be staged through the UI.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalListResult, RuntimeTerminalShow } from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { getAllWorktreeIds, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId } from './helpers/terminal'

const MIN_IDLE_MS = 60_000
const CALL_CHANNEL = 'runtimeEnvironments:call'
/** Methods that stop, start, write to or resume a terminal on the host. */
const EFFECTFUL_METHOD =
  /^(terminal\.(stop|stopExact|sleep|closeTab|send|ensure|create|restart|kill|materialize)|session\.tabs\.(create|close)|.*[Rr]esume)/

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-runtime-sleep-'))
const fixturePath = path.join(scratch, 'idle-agent.mjs')
writeFileSync(
  fixturePath,
  "process.stdout.write('RUNTIME_SLEEP_READY\\r\\n')\nsetInterval(() => {}, 1 << 30)\n"
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(' ')
}

async function callRuntime<T>(page: Page, selector: string, method: string, params: unknown) {
  return page.evaluate(
    async ({ method, params, selector }) => {
      const response = await window.api.runtimeEnvironments.call({ selector, method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params, selector }
  ) as Promise<T>
}

type CallSpy = { methods: string[]; failLiveness: boolean }

/** Wraps the client's real runtime-call handler: records methods, can refuse liveness listings. */
async function installCallSpy(app: ElectronApplication): Promise<void> {
  const installed = await app.evaluate(({ ipcMain }, channel) => {
    type Handler = (event: unknown, args: { method?: string; params?: unknown }) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
      ._invokeHandlers
    const real = handlers?.get(channel)
    if (!handlers || !real) {
      return false
    }
    const spy: CallSpy = { methods: [], failLiveness: false }
    ;(globalThis as { __runtimeSleepCallSpy?: CallSpy }).__runtimeSleepCallSpy = spy
    handlers.set(channel, async (event, args) => {
      spy.methods.push(args?.method ?? '')
      const fresh = (args?.params as { requireFreshPtyLiveness?: boolean } | undefined)
        ?.requireFreshPtyLiveness
      if (spy.failLiveness && args?.method === 'terminal.list' && fresh) {
        throw new Error('e2e: host cannot answer')
      }
      return real(event, args)
    })
    return true
  }, CALL_CHANNEL)
  if (!installed) {
    throw new Error(`ORCA-E2E-PRECONDITION-FAILED [call-spy] no invoke handler for ${CALL_CHANNEL}`)
  }
}

async function updateSpy(app: ElectronApplication, patch: Partial<CallSpy>): Promise<string[]> {
  return app.evaluate((_electron, next) => {
    const spy = (globalThis as { __runtimeSleepCallSpy?: CallSpy }).__runtimeSleepCallSpy!
    Object.assign(spy, next)
    return [...spy.methods]
  }, patch)
}

async function readPlan(page: Page) {
  return page.evaluate(() => {
    const section = document.querySelector('[data-testid="sleep-reclaim-authorization"]')
    const raw = section?.getAttribute('data-reclaimable-count')
    return {
      reclaimable: raw === null || raw === undefined ? null : Number(raw),
      reasons: [...(section?.querySelectorAll('li[data-reason]') ?? [])].map(
        (li) => li.getAttribute('data-reason') ?? ''
      ),
      known: section?.querySelector('[data-testid="reclaim-known"]')?.textContent ?? null
    }
  })
}

/** The client's own facts about the pane, so a failed poll says which one moved. */
async function readPaneFacts(page: Page, paneKey: string, tabId: string) {
  return page.evaluate(
    ({ key, tab }) => {
      const state = window.__store!.getState()
      const entry = state.agentStatusByPaneKey[key]
      return {
        entry: entry ? entry.state : null,
        sleeping: state.sleepingAgentSessionsByPaneKey[key] !== undefined,
        layoutPtys: Object.values(state.terminalLayoutsByTabId[tab]?.ptyIdsByLeafId ?? {}),
        tabPtys: state.ptyIdsByTabId[tab] ?? null,
        active: state.activeWorktreeId
      }
    },
    { key: paneKey, tab: tabId }
  )
}

async function openSection(page: Page) {
  const section = page.getByTestId('sleep-reclaim-authorization')
  if (!(await section.isVisible())) {
    await page.getByTestId('resource-manager-trigger').click()
  }
  await expect(section).toBeVisible({ timeout: 20_000 })
  // Why: the kept-awake disclosure exists only while some pane is kept awake, which can change.
  const disclosure = section.locator('button[aria-expanded="false"]')
  if ((await disclosure.count()) > 0) {
    await disclosure.click({ timeout: 5_000 }).catch(() => undefined)
  }
}

async function closeSection(page: Page) {
  const section = page.getByTestId('sleep-reclaim-authorization')
  if (await section.isVisible()) {
    await page.getByTestId('resource-manager-trigger').click()
  }
  await expect(section).toBeHidden({ timeout: 10_000 })
}

test('offers a live runtime-backed pane for sleep only once its host proves it live', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  const hostHome = await waitForActiveWorktree(orcaPage)
  const wt = (await getAllWorktreeIds(orcaPage)).find((id) => id !== hostHome)
  test.skip(!wt, 'needs the seeded secondary worktree')
  if (!wt) {
    return
  }

  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    'runtime-sleep-client'
  )
  const { app, page, environmentId: env } = client
  const timeline: unknown[] = []
  const consoleLines: string[] = []
  for (const [who, source] of [
    ['client', page],
    ['host', orcaPage]
  ] as const) {
    source.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        consoleLines.push(`${who} ${message.type()}: ${message.text()}`)
      }
    })
  }
  try {
    const clientWindow = await app.browserWindow(page)
    await clientWindow.evaluate((w) => {
      w.show()
      w.focus()
    })
    await expect
      .poll(
        () =>
          page.evaluate(
            (ids) => {
              const known =
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .map((w) => w.id) ?? []
              return ids.every((id) => known.includes(id))
            },
            [wt, hostHome]
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await installCallSpy(app)

    // A terminal that lives on the host, mounted once in the client.
    const created = await callRuntime<{ tab: { parentTabId: string; terminal: string | null } }>(
      page,
      env,
      'session.tabs.createTerminal',
      {
        worktree: `id:${wt}`,
        command: fixtureCommand(),
        activate: false,
        select: false,
        navigation: 'caller'
      }
    )
    const handle = created.tab.terminal
    if (!handle) {
      throw new Error('ORCA-E2E-PRECONDITION-FAILED [host-terminal] no terminal handle')
    }
    const hostPtyId = (
      await callRuntime<{ terminal: RuntimeTerminalShow }>(page, env, 'terminal.show', {
        terminal: handle
      })
    ).terminal.ptyId
    if (!hostPtyId) {
      throw new Error('ORCA-E2E-PRECONDITION-FAILED [host-terminal] no host pty')
    }
    const tabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), wt)
    const row = page
      .locator(
        `[data-terminal-rail-tab-id="${tabId}"], [data-testid="sortable-tab"][data-tab-id="${tabId}"]`
      )
      .first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()
    const clientPtyId = await waitForActivePanePtyId(page, 30_000)
    const paneKey = await page.evaluate(
      ({ tab, pty }) => {
        const layout = window.__store!.getState().terminalLayoutsByTabId[tab]
        const leaf = Object.entries(layout?.ptyIdsByLeafId ?? {}).find(([, id]) => id === pty)?.[0]
        return leaf ? `${tab}:${leaf}` : null
      },
      { tab: tabId, pty: clientPtyId }
    )
    if (!paneKey) {
      throw new Error('ORCA-E2E-PRECONDITION-FAILED [pane-binding] client pty has no leaf')
    }

    // Why: a runtime pane's agent status is the host's; the client mirrors it and drops any
    // entry it did not write itself, so the completed agent is seeded where hooks would report.
    const leafId = paneKey.slice(tabId.length + 1)
    await orcaPage.evaluate(
      ({ tab, leaf, worktreeId }) => {
        const store = window.__store!
        const doneAt = Date.now()
        const key = `${tab}:${leaf}`
        store.setState({
          agentStatusByPaneKey: {
            ...store.getState().agentStatusByPaneKey,
            [key]: {
              state: 'done',
              prompt: 'e2e runtime sleep',
              updatedAt: doneAt,
              stateStartedAt: doneAt,
              paneKey: key,
              tabId: tab,
              worktreeId,
              agentType: 'claude',
              providerSession: { key: 'session_id', id: 'e2e-runtime-sleep' },
              stateHistory: []
            }
          }
        } as never)
      },
      { tab: created.tab.parentTabId, leaf: leafId, worktreeId: wt }
    )
    await expect
      .poll(() => readPaneFacts(page, paneKey, tabId).then((facts) => facts.entry), {
        timeout: 30_000,
        message: 'the client never mirrored the host agent status'
      })
      .toBe('done')
    await page.evaluate((id) => window.__store!.getState().setActiveWorktree(id), hostHome)
    await page.evaluate((idleMs) => {
      const store = window.__store!
      store.setState({
        settings: {
          ...store.getState().settings,
          experimentalAgentHibernation: true,
          agentHibernationIdleMs: idleMs
        }
      } as never)
    }, MIN_IDLE_MS)

    const note = async (stage: string) => {
      const plan = await readPlan(page)
      timeline.push({
        stage,
        at: Date.now(),
        workerPid: process.pid,
        plan,
        pane: await readPaneFacts(page, paneKey, tabId),
        calls: await updateSpy(app, {})
      })
      // Why: written as it goes, so a run that dies mid-way still says where.
      writeFileSync(testInfo.outputPath('pane-timeline.json'), JSON.stringify(timeline, null, 2))
      return plan
    }
    await note('seeded')

    // Host cannot answer: the pane stays awake as unknown, not offered, not called dead.
    await updateSpy(app, { failLiveness: true })
    await openSection(page)
    await expect
      .poll(() => note('faulted'), { timeout: 15_000 })
      .toEqual({ reclaimable: 0, reasons: ['runtime-liveness-unknown'], known: null })
    await closeSection(page)

    // Host answers: a fresh showing samples once and, past the idle threshold, offers the pane.
    const before = (await updateSpy(app, { failLiveness: false })).length
    await openSection(page)
    await expect
      .poll(() => note('answered'), { timeout: MIN_IDLE_MS + 30_000, intervals: [2_000] })
      .toEqual({ reclaimable: 1, reasons: [], known: null })
    // Why: the rest of the app keeps talking to the host (ports, git, pane lookups); the claim
    // is only that showing the plan changed nothing there.
    const shown = (await updateSpy(app, {})).slice(before)
    expect(shown).toContain('terminal.list')
    expect(shown.filter((m) => EFFECTFUL_METHOD.test(m))).toEqual([])

    await note('before-click')
    await page.getByTestId('sleep-reclaim-action').click()
    const result = page.getByTestId('sleep-reclaim-result')
    await expect(result).toHaveAttribute('data-slept-count', '1', { timeout: 30_000 })
    await expect(result).toHaveAttribute('data-failed-count', '0')
    await note('slept')
    await expect
      .poll(
        async () => {
          const listing = await callRuntime<RuntimeTerminalListResult>(page, env, 'terminal.list', {
            worktree: `id:${wt}`,
            requireFreshPtyLiveness: true
          })
          return listing.terminals.some((t) => t.connected && t.ptyId === hostPtyId)
        },
        { timeout: 20_000 }
      )
      .toBe(false)
    expect(
      await page.evaluate(
        (key) => window.__store!.getState().sleepingAgentSessionsByPaneKey[key] !== undefined,
        paneKey
      )
    ).toBe(true)
  } finally {
    writeFileSync(
      testInfo.outputPath('pane-timeline.json'),
      JSON.stringify({ timeline, console: consoleLines.slice(-60) }, null, 2)
    )
    await page
      .screenshot()
      .then((body) => testInfo.attach('client', { body, contentType: 'image/png' }))
      .catch(() => undefined)
    await client.dispose()
  }
})
