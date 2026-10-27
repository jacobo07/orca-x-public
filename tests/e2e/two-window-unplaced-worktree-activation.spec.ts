/**
 * A worktree created while two windows are open is activated in exactly one of them.
 *
 * A new worktree belongs to no window yet, so the runtime graph cannot name an owner and — correctly —
 * refuses to guess. The notifier router used to read that refusal as "every window", so each window
 * received `activateWorktree` together with the worktree's setup and startup launch. Driven through
 * the real CLI socket (`worktree.create`, the path `orca worktree create --activate` takes) and
 * observed as the IPC each renderer actually receives, not as a side effect.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'

async function installActivationProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const received: string[] = []
    ;(window as unknown as { __activations: string[] }).__activations = received
    window.api.ui.onActivateWorktree(({ worktreeId }) => {
      received.push(worktreeId)
    })
  })
}

async function readActivations(page: Page): Promise<string[] | null> {
  return page.evaluate(
    () => (window as unknown as { __activations?: string[] }).__activations ?? null
  )
}

test('a CLI-created worktree is activated in one window, not in every window', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)

  const secondWindow = await Promise.all([
    electronApp.waitForEvent('window', { timeout: 60_000 }),
    orcaPage.evaluate(() => window.api.ui.createWindow())
  ]).then(([page]) => page)
  await secondWindow.waitForLoadState('domcontentloaded')
  await expect
    .poll(async () => getStoreState<boolean>(secondWindow, 'persistedUIReady'), { timeout: 60_000 })
    .toBe(true)

  try {
    await installActivationProbe(orcaPage)
    await installActivationProbe(secondWindow)
    // Station control: both probes are live, so an empty list below means "not received".
    expect(await readActivations(orcaPage)).toEqual([])
    expect(await readActivations(secondWindow)).toEqual([])

    const repoId = await orcaPage.evaluate(() => {
      const repo = (window.__store?.getState().repos ?? []).find(
        (candidate) => (candidate.executionHostId ?? 'local') === 'local' && !candidate.connectionId
      )
      if (!repo) {
        throw new Error('expected a seeded local-host repo')
      }
      return repo.id
    })
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const client = new RuntimeClient(userDataDir, 30_000, null, null)
    const response = await client.call<{ worktree: { id: string } }>('worktree.create', {
      repo: `id:${repoId}`,
      name: `wt-two-window-${Date.now()}`,
      noParent: true,
      activate: true
    })
    const worktreeId = response.result.worktree.id

    const receivedBy = async (): Promise<number> => {
      const lists = [await readActivations(orcaPage), await readActivations(secondWindow)]
      return lists.filter((list) => list?.includes(worktreeId)).length
    }
    // Positive control: the activation is observable at all.
    await expect.poll(receivedBy, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    // Delivery is one IPC per window, so a second window would have received it by now.
    await orcaPage.waitForTimeout(3_000)
    expect(await receivedBy(), 'the new worktree was activated in more than one window').toBe(1)
  } finally {
    await secondWindow.close()
  }
})
