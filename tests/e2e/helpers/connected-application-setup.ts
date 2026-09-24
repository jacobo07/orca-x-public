import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

export async function enableAgentSurfaces(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window
      .__store!.getState()
      .updateSettingsOrThrow({ showAgentsButton: true, showConversationsButton: true })
  })
}

/** Creates an agent on the first project and connects one application to that project. */
export async function connectApplicationToNewAgent(
  page: Page,
  application: { label: string; origin: string; signIn?: string }
): Promise<{ row: Locator; appId: string; partition: string }> {
  await page.locator('[data-workspace-activity="conversations"]').first().click()
  await page.getByTestId('workspace-new-agent').click()
  await page.getByTestId('new-agent-name').fill('App Hand')
  await page.getByTestId('new-agent-role').fill('creative')
  await page.getByTestId('new-agent-project').selectOption({ index: 0 })
  await page.getByTestId('new-agent-submit').click()
  await expect(page.getByTestId('agent-context-apps')).toBeVisible()

  await page.getByTestId('connected-app-add').click()
  await page.getByTestId('connected-app-label').fill(application.label)
  await page.getByTestId('connected-app-origin').fill(application.origin)
  if (application.signIn) {
    await page.getByTestId('connected-app-signin').fill(application.signIn)
  }
  await page.getByTestId('connected-app-submit').click()

  const row = page.getByTestId('connected-app-row')
  await expect(row).toHaveCount(1)
  await expect(row).not.toHaveAttribute('data-state', 'checking', { timeout: 30_000 })
  const appId = (await row.getAttribute('data-app-id')) as string
  return { row, appId, partition: `persist:orca-connected-app-${appId}` }
}

/** The guest webContents id of the surface actually on screen, not "any webview in main". */
export async function surfaceGuestId(page: Page): Promise<number> {
  return page
    .getByTestId('connected-app-webview')
    .evaluate((el) => (el as unknown as { getWebContentsId: () => number }).getWebContentsId())
}
