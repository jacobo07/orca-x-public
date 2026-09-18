/**
 * Product reality for explicit agent Sleep and a draft only the host knows about. A real PTY in a
 * background worktree carries a completed agent (supplied, as in
 * sleep-reclaim-authorization-surface.spec.ts: a plain shell has no agent hooks) and a line written
 * straight to the host, so the renderer has no typing stamp for the pane — the state a reload
 * leaves. The planner therefore offers the pane; the click must still keep it awake, because the
 * coordinator asks the host immediately before the shutdown. Control: the line cleared, the same
 * click sleeps it.
 *
 * Not a reload: the agent status and the agent-sleep settings are set in the renderer store only,
 * and a reload would discard them. The missing stamp is what the probe keys on either way.
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

type Pane = { paneKey: string; tabId: string }

async function hostInput(page: Page, ptyId: string): Promise<unknown> {
  return (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId)).inputSincePrompt
}

async function hostTerminalCount(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate(async (wt) => {
    const listing = await window.api.runtime.call({
      method: 'terminal.list',
      params: { worktree: `id:${wt}`, requireFreshPtyLiveness: true }
    })
    if (!listing.ok) {
      throw new Error(listing.error.message)
    }
    return (listing.result as { totalCount: number }).totalCount
  }, worktreeId)
}

async function seedDoneAgent(page: Page, pane: Pane, worktreeId: string): Promise<void> {
  await page.evaluate(
    ({ paneKey, tabId, wt, idleMs }) => {
      const store = window.__store!
      const doneAt = Date.now() - 10 * 60_000
      store.setState({
        agentStatusByPaneKey: {
          ...store.getState().agentStatusByPaneKey,
          [paneKey]: {
            state: 'done',
            prompt: 'e2e sleep host draft',
            updatedAt: doneAt,
            stateStartedAt: doneAt,
            paneKey,
            tabId,
            worktreeId: wt,
            agentType: 'claude',
            providerSession: { key: 'session_id', id: 'e2e-sleep-host-draft' },
            stateHistory: []
          }
        },
        settings: {
          ...store.getState().settings,
          experimentalAgentHibernation: true,
          agentHibernationIdleMs: idleMs
        }
      } as never)
    },
    { ...pane, wt: worktreeId, idleMs: MIN_IDLE_MS }
  )
}

test('explicit Sleep keeps an agent pane whose unsent line only the host knows', async ({
  orcaPage
}) => {
  test.setTimeout(360_000)
  const page = orcaPage
  await waitForSessionReady(page)
  const homeWorktreeId = await waitForActiveWorktree(page)
  const agentWorktreeId = (await getAllWorktreeIds(page)).find((id) => id !== homeWorktreeId)
  test.skip(!agentWorktreeId, 'needs the seeded secondary worktree')
  if (!agentWorktreeId) {
    return
  }

  await switchToWorktree(page, agentWorktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  const pane: Pane = await page.evaluate(
    ({ worktreeId, livePtyId }) => {
      const state = window.__store!.getState()
      const tab = (state.tabsByWorktree[worktreeId] ?? []).find((candidate) =>
        (state.ptyIdsByTabId[candidate.id] ?? []).includes(livePtyId)
      )
      const leafId = Object.entries(
        (tab ? state.terminalLayoutsByTabId[tab.id] : undefined)?.ptyIdsByLeafId ?? {}
      ).find(([, id]) => id === livePtyId)?.[0]
      if (!tab || !leafId) {
        throw new Error('ORCA-E2E-PRECONDITION-FAILED [pane-binding] live pty has no leaf')
      }
      return { paneKey: `${tab.id}:${leafId}`, tabId: tab.id }
    },
    { worktreeId: agentWorktreeId, livePtyId: ptyId }
  )
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId)).promptState,
      { timeout: 30_000, message: 'the shell reached its prompt' }
    )
    .toBe('prompt')

  // The draft: written to the host, never seen by the renderer.
  await page.evaluate((id) => window.api.pty.write(id, 'echo sleep-draft-line'), ptyId)
  await expect
    .poll(() => hostInput(page, ptyId), { timeout: 30_000, message: 'the host saw the line' })
    .toBe('typed')
  await seedDoneAgent(page, pane, agentWorktreeId)
  expect(
    await page.evaluate(
      (paneKey) => window.__store!.getState().lastTerminalInputAtByPaneKey[paneKey],
      pane.paneKey
    ),
    'the renderer holds no typing stamp for the pane'
  ).toBeUndefined()

  await switchToWorktree(page, homeWorktreeId)
  await page.getByTestId('resource-manager-trigger').click()
  const section = page.getByTestId('sleep-reclaim-authorization')
  await expect(section).toBeVisible({ timeout: 20_000 })
  // Precondition: the planner offers the pane, so the refusal below is the effect-time probe.
  await expect(section).toHaveAttribute('data-reclaimable-count', '1', {
    timeout: MIN_IDLE_MS + 30_000
  })

  await page.getByTestId('sleep-reclaim-action').click()
  const result = page.getByTestId('sleep-reclaim-result')
  await expect(result).toHaveAttribute('data-kept-count', '1', { timeout: 30_000 })
  await expect(result).toHaveAttribute('data-slept-count', '0')
  await expect(result).toHaveAttribute('data-failed-count', '0')
  expect(await hostTerminalCount(page, agentWorktreeId)).toBe(1)
  expect(await hostInput(page, ptyId)).toBe('typed')

  // Control: the line cleared, the same action sleeps the pane.
  await page.evaluate((id) => window.api.pty.write(id, '\x03'), ptyId)
  await expect
    .poll(() => hostInput(page, ptyId), { timeout: 30_000, message: 'the line was cleared' })
    .toBe('clean')
  // Why re-seed: the prompt Ctrl+C prints reads as the agent returning to its shell, and the
  // exit detector drops the supplied agent status — correct product behaviour, not the subject.
  const agentSurvivedClear = await page.evaluate(
    (paneKey) => window.__store!.getState().agentStatusByPaneKey[paneKey] !== undefined,
    pane.paneKey
  )
  await seedDoneAgent(page, pane, agentWorktreeId)
  // Why reopen: once a result is on screen the section shows it in place of the action.
  await page.keyboard.press('Escape')
  await expect(section).toHaveCount(0, { timeout: 15_000 })
  await page.getByTestId('resource-manager-trigger').click()
  await expect(section).toHaveAttribute('data-reclaimable-count', '1', {
    timeout: MIN_IDLE_MS + 30_000
  })
  await page.getByTestId('sleep-reclaim-action').click()
  await expect(result).toHaveAttribute('data-slept-count', '1', { timeout: 30_000 })
  await expect.poll(() => hostTerminalCount(page, agentWorktreeId), { timeout: 15_000 }).toBe(0)
  console.log(
    `[sleep-draft-evidence] kept=1 control-slept=1 agentSurvivedClear=${agentSurvivedClear}`
  )
})
