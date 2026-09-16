/**
 * Product boundary for the sleep authorization section in the Resource Manager popover.
 *
 * A real PTY in a background worktree is given a completed agent status, and the
 * real collector measures it. The section must follow the canonical planner
 * through its states — agent sleep off, idle too briefly, eligible — and show
 * the collector's own figure for the pane once it is eligible, while displaying
 * it destroys nothing. Then the explicit action sleeps that pane through the
 * coordinator: the host stops listing its terminal, a resume record exists, the
 * result says one slept, and an unrelated terminal is untouched.
 *
 * Not proven here: a pane going stale between display and click. Every store
 * change re-renders the section first, so that interleaving is driven in
 * agent-hibernation-explicit-sleep.test.ts against the real planner instead.
 *
 * Supplied by this spec, so NOT proven here: the agent status entry (a plain
 * shell has no agent hooks), and the agent-sleep settings, set in the renderer
 * store only. The automatic coordinator needs two confirming 60 s ticks after
 * eligibility, so it cannot act inside this spec's window.
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'

const MIN_IDLE_MS = 60_000

type SectionReading = {
  present: boolean
  reclaimable: number | null
  excluded: number | null
  known: string | null
  unknown: boolean
  paneBytes: number | null
  ptyLive: boolean
}

async function readSection(page: Page, pane: { paneKey: string; tabId: string; ptyId: string }) {
  // One evaluate, so the DOM and the snapshot it was rendered from are sampled together.
  return (await page.evaluate(({ paneKey, tabId, ptyId }) => {
    const section = document.querySelector('[data-testid="sleep-reclaim-authorization"]')
    const state = window.__store!.getState()
    const session = state.memorySnapshot?.worktrees
      .flatMap((worktree) => worktree.sessions)
      .find((candidate) => candidate.paneKey === paneKey)
    const count = (name: string): number | null => {
      const raw = section?.getAttribute(name)
      return raw === null || raw === undefined ? null : Number(raw)
    }
    return {
      present: section !== null,
      reclaimable: count('data-reclaimable-count'),
      excluded: count('data-excluded-count'),
      known: section?.querySelector('[data-testid="reclaim-known"]')?.textContent ?? null,
      unknown: section?.querySelector('[data-testid="reclaim-unknown"]') !== null,
      paneBytes: session && session.pid > 0 && session.memory > 0 ? session.memory : null,
      ptyLive: (state.ptyIdsByTabId[tabId] ?? []).includes(ptyId)
    }
  }, pane)) as SectionReading
}

// Mirrors formatMemory; the assertion is that the section shows the snapshot's own bytes.
function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

test.describe('Sleep reclaim authorization surface', () => {
  test('projects the live plan for a real background pane, then sleeps only that pane', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    const agentWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== homeWorktreeId)
    test.skip(!agentWorktreeId, 'needs the seeded secondary worktree')
    if (!agentWorktreeId) {
      return
    }

    // An unrelated live terminal, which the action must leave alone.
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const homePtyId = await waitForActivePanePtyId(orcaPage)

    // A real PTY in the worktree that will sit in the background.
    await switchToWorktree(orcaPage, agentWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const pane = await orcaPage.evaluate(
      ({ worktreeId, livePtyId }) => {
        const state = window.__store!.getState()
        const tab = (state.tabsByWorktree[worktreeId] ?? []).find((candidate) =>
          (state.ptyIdsByTabId[candidate.id] ?? []).includes(livePtyId)
        )
        const layout = tab ? state.terminalLayoutsByTabId[tab.id] : undefined
        const leafId = Object.entries(layout?.ptyIdsByLeafId ?? {}).find(
          ([, id]) => id === livePtyId
        )?.[0]
        if (!tab || !leafId) {
          throw new Error('ORCA-E2E-PRECONDITION-FAILED [pane-binding] live pty has no leaf')
        }
        return { paneKey: `${tab.id}:${leafId}`, tabId: tab.id, ptyId: livePtyId }
      },
      { worktreeId: agentWorktreeId, livePtyId: ptyId }
    )

    // A completed agent on that pane, done long enough ago that only the
    // foreground visit below decides when it becomes idle.
    await orcaPage.evaluate(
      ({ paneKey, tabId, worktreeId }) => {
        const store = window.__store!
        const doneAt = Date.now() - 10 * 60_000
        store.setState({
          agentStatusByPaneKey: {
            ...store.getState().agentStatusByPaneKey,
            [paneKey]: {
              state: 'done',
              prompt: 'e2e sleep authorization',
              updatedAt: doneAt,
              stateStartedAt: doneAt,
              paneKey,
              tabId,
              worktreeId,
              agentType: 'claude',
              providerSession: { key: 'session_id', id: 'e2e-sleep-authorization' },
              stateHistory: []
            }
          }
        } as never)
      },
      { ...pane, worktreeId: agentWorktreeId }
    )

    await switchToWorktree(orcaPage, homeWorktreeId)
    const hiddenAt = Date.now()
    await orcaPage.getByTestId('resource-manager-trigger').click()
    const section = orcaPage.getByTestId('sleep-reclaim-authorization')
    await expect(section).toBeVisible({ timeout: 20_000 })

    // 1. Agent sleep off (the default): the pane is on the plan, kept awake, no figure.
    await expect
      .poll(async () => readSection(orcaPage, pane), { timeout: 15_000 })
      .toMatchObject({ reclaimable: 0, known: null, ptyLive: true })
    expect((await readSection(orcaPage, pane)).excluded).toBeGreaterThanOrEqual(1)

    // 2. Agent sleep on at the minimum threshold: still kept awake until the
    //    pane has been out of view for a full minute.
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
    await expect
      .poll(async () => readSection(orcaPage, pane), { timeout: 10_000 })
      .toMatchObject({ reclaimable: 0, known: null, ptyLive: true })
    expect(Date.now() - hiddenAt).toBeLessThan(MIN_IDLE_MS)

    // 3. Eligible: counted once, and the figure is the collector's own bytes.
    await expect
      .poll(
        async () => {
          const reading = await readSection(orcaPage, pane)
          if (reading.reclaimable !== 1) {
            return reading
          }
          const expectedKnown = reading.paneBytes === null ? null : formatMemory(reading.paneBytes)
          return {
            ...reading,
            figureMatchesSnapshot:
              expectedKnown === null
                ? reading.known === null && reading.unknown
                : (reading.known ?? '').includes(expectedKnown)
          }
        },
        { timeout: MIN_IDLE_MS + 30_000, intervals: [2_000] }
      )
      .toMatchObject({ reclaimable: 1, figureMatchesSnapshot: true, ptyLive: true })
    expect(Date.now() - hiddenAt).toBeGreaterThanOrEqual(MIN_IDLE_MS)

    const final = await readSection(orcaPage, pane)
    // A real collector measures a live PTY; an unmeasured pane would be a meter gap worth seeing.
    expect(final.paneBytes, 'collector did not measure the live pane').not.toBeNull()
    expect(final.known).toMatch(/\d/)
    expect(final.ptyLive).toBe(true)

    // 4. The explicit action: a real shutdown through the coordinator, reported as it happened.
    expect(await readEffect(orcaPage, pane, agentWorktreeId, homePtyId)).toEqual({
      ptyLive: true,
      hostTerminalCount: 1,
      resumeRecorded: false,
      homePtyLive: true
    })
    await orcaPage.getByTestId('sleep-reclaim-action').click()
    const result = orcaPage.getByTestId('sleep-reclaim-result')
    await expect(result).toHaveAttribute('data-slept-count', '1', { timeout: 30_000 })
    await expect(result).toHaveAttribute('data-failed-count', '0')
    await expect(result).toHaveAttribute('data-kept-count', '0')
    await expect
      .poll(() => readEffect(orcaPage, pane, agentWorktreeId, homePtyId), { timeout: 15_000 })
      .toEqual({ ptyLive: false, hostTerminalCount: 0, resumeRecorded: true, homePtyLive: true })
  })
})

type EffectReading = {
  ptyLive: boolean
  hostTerminalCount: number
  resumeRecorded: boolean
  homePtyLive: boolean
}

async function readEffect(
  page: Page,
  pane: { paneKey: string; tabId: string; ptyId: string },
  worktreeId: string,
  homePtyId: string
): Promise<EffectReading> {
  return (await page.evaluate(
    async ({ paneKey, tabId, ptyId, agentWorktreeId, otherPtyId }) => {
      const state = window.__store!.getState()
      // The host's own view, so a renderer that merely forgot the pty cannot pass.
      const listing = await window.api.runtime.call({
        method: 'terminal.list',
        params: { worktree: `id:${agentWorktreeId}`, requireFreshPtyLiveness: true }
      })
      if (!listing.ok) {
        throw new Error(listing.error.message)
      }
      return {
        ptyLive: (state.ptyIdsByTabId[tabId] ?? []).includes(ptyId),
        hostTerminalCount: (listing.result as { totalCount: number }).totalCount,
        resumeRecorded: state.sleepingAgentSessionsByPaneKey[paneKey] !== undefined,
        homePtyLive: Object.values(state.ptyIdsByTabId).some((ids) =>
          (ids ?? []).includes(otherPtyId)
        )
      }
    },
    { ...pane, agentWorktreeId: worktreeId, otherPtyId: homePtyId }
  )) as EffectReading
}
