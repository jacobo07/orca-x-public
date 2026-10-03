import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree } from './helpers/store'
import { settlePaint } from './helpers/settled-paint'
import { waitForActiveTerminalManager } from './helpers/terminal'

/**
 * Snapshots from the Resume Center, in a running Orca.
 *
 * Workspace pages do not mount the Sidebar, which once owned the Snapshots dialog, so the button
 * could open nothing. And the dialog lists by owner key: a snapshot saved under the key the
 * sidebar's menu uses must be the one this button lists, or the two routes disagree on scope.
 */

test.setTimeout(180_000)

test.describe('@resume-center', () => {
  test('Snapshots opens the selected workspace’s saved layouts from the Resume Center', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    // Saved under the bare worktree id, exactly as the sidebar's Snapshots menu saves.
    const workingSetId = await orcaPage.evaluate(async (ownerKey) => {
      const api = window.__workingSetE2E!
      await api.save({ ownerKey, label: 'From the sidebar key' })
      const listed = (await api.list({ executionHostId: 'local', ownerKey })) as {
        valid?: { workingSetId: string }[]
      }
      return listed.valid?.[0]?.workingSetId ?? null
    }, worktreeId)
    expect(workingSetId, 'precondition: the snapshot was not saved').toBeTruthy()

    await orcaPage.locator('[data-workspace-activity="agent-workspace"]').first().click()
    await orcaPage.locator('[data-workspace-nav-item="resume"]').click()
    await expect(orcaPage.getByTestId('resume-center-page')).toBeVisible({ timeout: 15_000 })

    // The most recent row is selected on arrival, which enables the button.
    const button = orcaPage.getByTestId('resume-center-snapshots')
    await expect(button).toBeEnabled({ timeout: 30_000 })
    await button.click()

    const dialog = orcaPage.getByTestId('working-sets-dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.locator(`[data-working-set-id="${workingSetId}"]`)).toBeVisible({
      timeout: 15_000
    })

    // Why settle: Radix fades the dialog in, and an early capture shows it near opacity 0.
    await settlePaint(orcaPage)
    await orcaPage.screenshot({ path: 'pr-evidence/resume-center-snapshots.png' })
    await orcaPage.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0, { timeout: 10_000 })
  })
})
