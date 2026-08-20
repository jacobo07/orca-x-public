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

  // The strip lives in the sidebar-width header and collapses to the compact menu button when the
  // labels do not fit, so widen the sidebar first: at the default width the honest render is the
  // fallback, and asserting the strip there would pin a layout the app is right not to draw.
  await orcaPage.evaluate(() => window.__store?.getState().setSidebarWidth(520))

  const strip = orcaPage.locator('button.titlebar-menu-strip-button')
  await expect(strip.first()).toBeVisible({ timeout: 30_000 })

  // Assert against the registered menu rather than a hardcoded list: the point is that the strip
  // mirrors what Orca registered, so the test must not re-declare that list either.
  const registered = await orcaPage.evaluate(() => window.api.ui.getMenuTopLevelItems())
  expect(registered.length).toBeGreaterThan(0)
  expect(await strip.allTextContents()).toEqual(registered.map((item) => item.label))

  await orcaPage.screenshot({ path: 'pr-evidence/workspace-menu-strip.png' })
})

test('the titlebar header never draws one control over another @workspace-chrome', async ({
  orcaPage
}) => {
  test.skip(process.platform === 'darwin', 'macOS keeps its native menu bar')

  // The header is sized to the sidebar, which the user drags. The menu strip does not shrink, so at
  // ordinary widths it used to overflow and paint across the sidebar toggle and back/forward — every
  // control still clickable underneath, nothing visibly broken, and the titlebar quietly unusable.
  // Overlap is the property to pin, not the collapse threshold: the strip may fold to the compact
  // button whenever it needs to, provided nothing ends up on top of anything else.
  const overlapsAt = async (sidebarWidth: number): Promise<string[]> => {
    await orcaPage.evaluate(
      (width) => window.__store?.getState().setSidebarWidth(width),
      sidebarWidth
    )
    await expect
      .poll(async () =>
        orcaPage.evaluate(() => document.querySelector('.titlebar-left')?.clientWidth ?? 0)
      )
      .toBeGreaterThan(0)
    return orcaPage.evaluate(() => {
      const header = document.querySelector('.titlebar-left')
      if (!header) {
        return ['no titlebar-left header']
      }
      const controls = [...header.querySelectorAll('button')]
        .map((button) => ({
          name: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '?',
          rect: button.getBoundingClientRect()
        }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      const hits: string[] = []
      for (let i = 0; i < controls.length; i += 1) {
        for (let j = i + 1; j < controls.length; j += 1) {
          const a = controls[i].rect
          const b = controls[j].rect
          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
            hits.push(`"${controls[i].name}" over "${controls[j].name}"`)
          }
        }
      }
      return hits
    })
  }

  for (const width of [220, 280, 360, 520]) {
    expect(await overlapsAt(width), `sidebar width ${width}`).toEqual([])
  }
  await orcaPage.screenshot({ path: 'pr-evidence/workspace-titlebar-no-overlap.png' })
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
