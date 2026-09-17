/**
 * Product boundary for "a pinned tab keeps its agent awake".
 *
 * Three real terminal tabs in a background worktree. Tab A is pinned through the
 * real tab context menu; B and A get completed agent statuses. The Resource
 * Manager must offer only B, name A's pin, and size the estimate from B alone.
 * The explicit action then sleeps B: the host still lists A, only B has a resume
 * record, and the real main-process probe is asked about B's processes only.
 *
 * Then the automatic path. C, unpinned, is given a completed status after the
 * click: the 60 s coordinator must sleep C (the control that its ticks run in
 * this app) while A, pinned and otherwise eligible, stays live through the same
 * ticks. Finally A is unpinned through the same menu: the plan reprojects through the
 * existing refresh and offers A, which is still running — unpinning sleeps nothing.
 *
 * Supplied by this spec, so NOT proven here: the agent status entries (a plain
 * shell has no agent hooks) and the sleep settings, set in the renderer store.
 * Pinning between display and click, and mid-batch, are not reachable through
 * the UI (every store change re-renders the plan first); the real planner and
 * coordinator own those in agent-hibernation-explicit-sleep.test.ts.
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'

// Why: the menu helper matches the English "New tab" label; creation is not under test here.
async function createTerminalTab(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((wt) => {
    window.__store!.getState().createTab(wt)
  }, worktreeId)
  await waitForActiveTerminalManager(page, 30_000)
}

const MIN_IDLE_MS = 60_000
const PROBE_CHANNEL = 'memory:probeProcessPresence'

type Pane = { paneKey: string; tabId: string; ptyId: string }

async function bindActivePane(page: Page, worktreeId: string, notPtyIds: string[]): Promise<Pane> {
  await expect
    .poll(
      async () => {
        const id = await waitForActivePanePtyId(page)
        return notPtyIds.includes(id) ? null : id
      },
      { timeout: 30_000 }
    )
    .not.toBeNull()
  const ptyId = await waitForActivePanePtyId(page)
  return page.evaluate(
    ({ worktreeId: wt, livePtyId }) => {
      const state = window.__store!.getState()
      const tab = (state.tabsByWorktree[wt] ?? []).find((candidate) =>
        (state.ptyIdsByTabId[candidate.id] ?? []).includes(livePtyId)
      )
      const leafId = Object.entries(
        (tab ? state.terminalLayoutsByTabId[tab.id] : undefined)?.ptyIdsByLeafId ?? {}
      ).find(([, id]) => id === livePtyId)?.[0]
      if (!tab || !leafId) {
        throw new Error('ORCA-E2E-PRECONDITION-FAILED [pane-binding] live pty has no leaf')
      }
      return { paneKey: `${tab.id}:${leafId}`, tabId: tab.id, ptyId: livePtyId }
    },
    { worktreeId, livePtyId: ptyId }
  )
}

async function seedCompletedAgent(page: Page, pane: Pane, worktreeId: string, id: string) {
  await page.evaluate(
    ({ paneKey, tabId, wt, sessionId }) => {
      const store = window.__store!
      const doneAt = Date.now() - 10 * 60_000
      store.setState({
        agentStatusByPaneKey: {
          ...store.getState().agentStatusByPaneKey,
          [paneKey]: {
            state: 'done',
            prompt: 'e2e pinned sleep',
            updatedAt: doneAt,
            stateStartedAt: doneAt,
            paneKey,
            tabId,
            worktreeId: wt,
            agentType: 'claude',
            providerSession: { key: 'session_id', id: sessionId },
            stateHistory: []
          }
        }
      } as never)
    },
    { ...pane, wt: worktreeId, sessionId: id }
  )
}

// Why: terminals render as rail rows when the terminal rail is on, as strip tabs otherwise;
// both open the same tab menu.
async function togglePinFromTabMenu(page: Page, tabId: string, expected: boolean) {
  const row = page.locator(
    `[data-terminal-rail-tab-id="${tabId}"], [data-testid="sortable-tab"][data-tab-id="${tabId}"]`
  )
  await row.first().click({ button: 'right' })
  await page.locator('[data-tab-menu-action="toggle-pin"]').click()
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const state = window.__store!.getState()
          return Object.values(state.unifiedTabsByWorktree ?? {})
            .flat()
            .some((tab) => tab?.entityId === id && tab.isPinned === true)
        }, tabId),
      { timeout: 10_000 }
    )
    .toBe(expected)
}

type Reading = {
  reclaimable: number | null
  reasons: string[]
  known: string | null
  bytesA: number | null
  bytesB: number | null
}

async function readPlan(page: Page, a: Pane, b: Pane): Promise<Reading> {
  return page.evaluate(
    ({ paneA, paneB }) => {
      const section = document.querySelector('[data-testid="sleep-reclaim-authorization"]')
      const sessions = (window.__store!.getState().memorySnapshot?.worktrees ?? []).flatMap(
        (worktree) => worktree.sessions
      )
      const bytes = (paneKey: string) => {
        const s = sessions.find((candidate) => candidate.paneKey === paneKey)
        return s && s.pid > 0 && s.memory > 0 ? s.memory : null
      }
      const raw = section?.getAttribute('data-reclaimable-count')
      return {
        reclaimable: raw === null || raw === undefined ? null : Number(raw),
        reasons: [...(section?.querySelectorAll('li[data-reason]') ?? [])].map(
          (li) => li.getAttribute('data-reason') ?? ''
        ),
        known: section?.querySelector('[data-testid="reclaim-known"]')?.textContent ?? null,
        bytesA: bytes(paneA),
        bytesB: bytes(paneB)
      }
    },
    { paneA: a.paneKey, paneB: b.paneKey }
  )
}

async function openSection(page: Page) {
  const section = page.getByTestId('sleep-reclaim-authorization')
  if (!(await section.isVisible())) {
    await page.getByTestId('resource-manager-trigger').click()
  }
  await expect(section).toBeVisible({ timeout: 20_000 })
  // Why: the kept-awake disclosure exists only while some pane is kept awake.
  const disclosure = section.locator('button[aria-expanded="false"]')
  if ((await disclosure.count()) > 0) {
    await disclosure.click()
  }
}

// Mirrors formatMemory; the assertion is that the figure is B's own bytes.
function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function readLiveness(page: Page, worktreeId: string, panes: Pane[]) {
  return page.evaluate(
    async ({ wt, list }) => {
      const state = window.__store!.getState()
      // The host's own view, so a renderer that merely forgot a pty cannot pass.
      const listing = await window.api.runtime.call({
        method: 'terminal.list',
        params: { worktree: `id:${wt}`, requireFreshPtyLiveness: true }
      })
      if (!listing.ok) {
        throw new Error(listing.error.message)
      }
      const hostPtyIds = (
        listing.result as { terminals: { ptyId?: string | null; connected?: boolean }[] }
      ).terminals
        .filter((t) => t.connected)
        .map((t) => t.ptyId)
      return list.map((pane) => ({
        live: (state.ptyIdsByTabId[pane.tabId] ?? []).includes(pane.ptyId),
        hostListed: hostPtyIds.includes(pane.ptyId),
        resumeRecorded: state.sleepingAgentSessionsByPaneKey[pane.paneKey] !== undefined
      }))
    },
    { wt: worktreeId, list: panes }
  )
}

test.describe('Sleep keeps a pinned tab awake', () => {
  test('pinned through the tab menu, excluded from explicit and automatic sleep', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(420_000)
    await waitForSessionReady(orcaPage)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    const wt = (await getAllWorktreeIds(orcaPage)).find((id) => id !== homeWorktreeId)
    test.skip(!wt, 'needs the seeded secondary worktree')
    if (!wt) {
      return
    }
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    // Three real terminals in the worktree that will sit in the background.
    await switchToWorktree(orcaPage, wt)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const a = await bindActivePane(orcaPage, wt, [])
    await createTerminalTab(orcaPage, wt)
    const b = await bindActivePane(orcaPage, wt, [a.ptyId])
    await createTerminalTab(orcaPage, wt)
    const c = await bindActivePane(orcaPage, wt, [a.ptyId, b.ptyId])

    // The user's pin, through the product's own menu.
    await togglePinFromTabMenu(orcaPage, a.tabId, true)
    await seedCompletedAgent(orcaPage, a, wt, 'e2e-pinned-a')
    await seedCompletedAgent(orcaPage, b, wt, 'e2e-pinned-b')

    await switchToWorktree(orcaPage, homeWorktreeId)
    const hiddenAt = Date.now()
    await orcaPage.evaluate((idleMs) => {
      const store = window.__store!
      store.setState({
        settings: {
          ...store.getState().settings,
          experimentalAgentHibernation: true,
          agentHibernationIdleMs: idleMs
        }
      } as never)
    }, MIN_IDLE_MS)
    await openSection(orcaPage)

    // Before the idle threshold the pin already names A; B is merely not idle yet.
    await expect
      .poll(async () => (await readPlan(orcaPage, a, b)).reasons, { timeout: 15_000 })
      .toEqual(expect.arrayContaining(['tab-pinned', 'not-idle-long-enough']))
    expect(Date.now() - hiddenAt).toBeLessThan(MIN_IDLE_MS)

    // Eligible: only B, and the figure is B's bytes alone.
    await expect
      .poll(
        async () => {
          const r = await readPlan(orcaPage, a, b)
          return {
            reclaimable: r.reclaimable,
            pinned: r.reasons.includes('tab-pinned'),
            figureIsB: r.bytesB !== null && (r.known ?? '').includes(formatMemory(r.bytesB))
          }
        },
        { timeout: MIN_IDLE_MS + 30_000, intervals: [2_000] }
      )
      .toEqual({ reclaimable: 1, pinned: true, figureIsB: true })
    const planned = await readPlan(orcaPage, a, b)
    expect(planned.bytesA, 'collector did not measure the pinned pane').not.toBeNull()
    expect(planned.known).not.toContain(formatMemory(planned.bytesA! + planned.bytesB!))

    const baseline = await orcaPage.evaluate(
      ({ paneA, paneB }) => {
        const sessions = (window.__store!.getState().memorySnapshot?.worktrees ?? []).flatMap(
          (worktree) => worktree.sessions
        )
        const pidsOf = (paneKey: string) =>
          (sessions.find((s) => s.paneKey === paneKey)?.processes ?? []).map((p) => p.pid)
        return { a: pidsOf(paneA), b: pidsOf(paneB) }
      },
      { paneA: a.paneKey, paneB: b.paneKey }
    )
    expect(baseline.b.length).toBeGreaterThanOrEqual(1)
    expect(baseline.a.length).toBeGreaterThanOrEqual(1)

    // The explicit action.
    await installProbeSpy(electronApp)
    await orcaPage.getByTestId('sleep-reclaim-action').click()
    const result = orcaPage.getByTestId('sleep-reclaim-result')
    await expect(result).toHaveAttribute('data-slept-count', '1', { timeout: 30_000 })
    await expect(result).toHaveAttribute('data-failed-count', '0')
    await expect(result).toHaveAttribute('data-kept-count', '0')
    await expect
      .poll(() => readLiveness(orcaPage, wt, [a, b]), { timeout: 15_000 })
      .toEqual([
        { live: true, hostListed: true, resumeRecorded: false },
        { live: false, hostListed: false, resumeRecorded: true }
      ])
    const observed = orcaPage.getByTestId('sleep-reclaim-observed')
    await expect(observed).not.toHaveAttribute('data-status', 'pending', { timeout: 30_000 })
    const spy = await readProbeSpy(electronApp)
    expect(spy.calls, 'the renderer never asked main for the follow-up sweep').toHaveLength(1)
    expect([...spy.calls[0].pids].sort()).toEqual([...baseline.b].sort())
    expect(spy.calls[0].pids.filter((pid) => baseline.a.includes(pid))).toEqual([])
    await expect(observed).toHaveAttribute('data-measured-panes', '1')

    // The automatic path: C is the control that ticks run; A must survive the same ticks.
    await seedCompletedAgent(orcaPage, c, wt, 'e2e-pinned-c')
    await expect
      .poll(async () => (await readLiveness(orcaPage, wt, [c]))[0], {
        timeout: 200_000,
        intervals: [5_000]
      })
      .toEqual({ live: false, hostListed: false, resumeRecorded: true })
    expect(await readLiveness(orcaPage, wt, [a])).toEqual([
      { live: true, hostListed: true, resumeRecorded: false }
    ])
    expect((await readProbeSpy(electronApp)).calls).toHaveLength(1)

    // Unpin through the same menu. A was already idle (its tab never came to the
    // foreground), so a fresh plan offers it — and unpinning alone sleeps nothing.
    await switchToWorktree(orcaPage, wt)
    await togglePinFromTabMenu(orcaPage, a.tabId, false)
    await switchToWorktree(orcaPage, homeWorktreeId)
    await openSection(orcaPage)
    await expect
      .poll(
        async () => {
          const r = await readPlan(orcaPage, a, b)
          return { reclaimable: r.reclaimable, pinned: r.reasons.includes('tab-pinned') }
        },
        { timeout: 15_000 }
      )
      .toEqual({ reclaimable: 1, pinned: false })
    expect(await readLiveness(orcaPage, wt, [a])).toEqual([
      { live: true, hostListed: true, resumeRecorded: false }
    ])
  })
})

type ProbeSpy = { calls: { pids: number[] }[] }

async function installProbeSpy(electronApp: ElectronApplication): Promise<void> {
  const installed = await electronApp.evaluate(({ ipcMain }, channel) => {
    type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
      ._invokeHandlers
    const real = handlers?.get(channel)
    if (!handlers || !real) {
      return false
    }
    const spy: ProbeSpy = { calls: [] }
    ;(globalThis as { __pinnedSleepProbeSpy?: ProbeSpy }).__pinnedSleepProbeSpy = spy
    handlers.set(channel, async (event, pids) => {
      spy.calls.push({ pids: pids as number[] })
      return real(event, pids)
    })
    return true
  }, PROBE_CHANNEL)
  if (!installed) {
    throw new Error(
      `ORCA-E2E-PRECONDITION-FAILED [probe-spy] no invoke handler for ${PROBE_CHANNEL}`
    )
  }
}

async function readProbeSpy(electronApp: ElectronApplication): Promise<ProbeSpy> {
  return electronApp.evaluate(
    () =>
      (globalThis as { __pinnedSleepProbeSpy?: ProbeSpy }).__pinnedSleepProbeSpy ?? { calls: [] }
  )
}
