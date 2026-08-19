import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, getStoreState, waitForActiveWorktree } from './helpers/store'

// The chrome is only meaningful in the running app: the strip renders whatever Electron actually
// registered, and the Home control's whole promise is that the work survives it. Neither claim is
// observable from component source.

test('the titlebar strip mirrors the registered application menu @workspace-chrome', async ({
  orcaPage
}) => {
  // The native menu bar is hidden on Windows and Linux, which is the only reason the strip exists.
  test.skip(process.platform === 'darwin', 'macOS keeps its native menu bar')

  const strip = orcaPage.locator('button.titlebar-menu-strip-button')
  await expect(strip.first()).toBeVisible({ timeout: 30_000 })

  // Assert against the registered menu rather than a hardcoded list: the point is that the strip
  // mirrors what Orca registered, so the test must not re-declare that list either.
  const registered = await orcaPage.evaluate(() => window.api.ui.getMenuTopLevelItems())
  expect(registered.length).toBeGreaterThan(0)
  expect(await strip.allTextContents()).toEqual(registered.map((item) => item.label))

  await orcaPage.screenshot({ path: 'pr-evidence/workspace-menu-strip.png' })
})

test('a project names itself in the chrome, and Home keeps the work @workspace-chrome', async ({
  orcaPage
}) => {
  // Arrange — a project open with a terminal in it, which is the state the chrome describes.
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const homeControl = orcaPage.getByRole('button', { name: /Go to Workspace home/i })
  await expect(homeControl).toBeVisible({ timeout: 30_000 })
  await orcaPage.screenshot({ path: 'pr-evidence/workspace-project-chrome.png' })

  const tabsBefore = (
    await getStoreState<Record<string, unknown[]>>(orcaPage, 'tabsByWorktree')
  )[worktreeId]?.length
  expect(tabsBefore).toBeGreaterThan(0)

  // Act
  await homeControl.click()

  // Assert — Home is navigation, not teardown: the view changes, the session does not.
  await expect
    .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 10_000 })
    .toBe('workspace')
  const tabsAfter = (await getStoreState<Record<string, unknown[]>>(orcaPage, 'tabsByWorktree'))[
    worktreeId
  ]?.length
  expect(tabsAfter).toBe(tabsBefore)
  expect(await getStoreState<string | null>(orcaPage, 'activeWorktreeId')).toBe(worktreeId)

  await orcaPage.screenshot({ path: 'pr-evidence/workspace-home.png' })
})
