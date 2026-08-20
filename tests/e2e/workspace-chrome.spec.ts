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

test('the closed file panel keeps a reopen control clear of the tabs @workspace-chrome', async ({
  orcaPage
}) => {
  // Closing the Explorer is only reversible if the control that reopens it can be seen and clicked.
  // Docked left — the default — that control sits at the content edge, which is where the first tab
  // starts. Painted over a tab it is invisible and takes the tab's clicks, so the file panel reads
  // as gone for good. Overlap is the assertion because "the button is in the DOM" stayed true the
  // whole time this was broken.
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.setSidePanelDock('left')
    if (state?.rightSidebarOpen) {
      state.toggleRightSidebar()
    }
  })

  await expect
    .poll(
      async () =>
        orcaPage.evaluate(() => {
          const strip = document.querySelector('[data-tab-group-strip-id]')
          const reopen = [...document.querySelectorAll('button.sidebar-toggle')].find((button) =>
            /derecha|right/i.test(button.getAttribute('aria-label') ?? '')
          )
          if (!strip || !reopen) {
            return 'no reopen control'
          }
          const reopenRect = reopen.getBoundingClientRect()
          const hit = [...strip.querySelectorAll('[data-tab-id], [role="tab"]')].find((tab) => {
            const rect = tab.getBoundingClientRect()
            return (
              rect.width > 0 &&
              reopenRect.left < rect.right &&
              rect.left < reopenRect.right &&
              reopenRect.top < rect.bottom &&
              rect.top < reopenRect.bottom
            )
          })
          return hit ? `overlaps tab "${hit.textContent?.trim()}"` : 'clear'
        }),
      { timeout: 15_000 }
    )
    .toBe('clear')

  await orcaPage.screenshot({ path: 'pr-evidence/workspace-closed-panel-reopen.png' })
})

test('the project chrome never covers the tab strip controls @workspace-chrome', async ({
  orcaPage
}) => {
  // The chrome floats over the tab strip's right end, so the strip has to reserve its width. It is
  // the project's name, so that width is not a constant — with a short name nothing looks wrong,
  // and the quick-command button disappears under a longer one.
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const coveredAt = async (dock: string, panelOpen: boolean): Promise<string[]> => {
    await orcaPage.evaluate(
      ([dock, panelOpen]) => {
        const state = window.__store?.getState()
        state?.setSidePanelDock(dock as 'left' | 'right')
        if (state && state.rightSidebarOpen !== panelOpen) {
          state.toggleRightSidebar()
        }
      },
      [dock, panelOpen] as [string, boolean]
    )
    await orcaPage.waitForTimeout(500)
    return orcaPage.evaluate(() => {
      const home = document.querySelector('button[aria-label="Go to Workspace home"]')
      const cluster = home?.parentElement
      const strip = document.querySelector('[data-tab-group-strip-id]')
      if (!cluster || !strip) {
        return ['no project chrome mounted']
      }
      const clusterRect = cluster.getBoundingClientRect()
      return [...strip.querySelectorAll('button')]
        .map((button) => ({
          name: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '?',
          rect: button.getBoundingClientRect()
        }))
        .filter(
          ({ rect }) =>
            rect.width > 0 &&
            clusterRect.left < rect.right &&
            rect.left < clusterRect.right &&
            clusterRect.top < rect.bottom &&
            rect.top < clusterRect.bottom
        )
        .map(({ name }) => `covers "${name}"`)
    })
  }

  expect(await coveredAt('left', false), 'left dock, panel closed').toEqual([])
  expect(await coveredAt('left', true), 'left dock, panel open').toEqual([])
  expect(await coveredAt('right', false), 'right dock, panel closed').toEqual([])
  await orcaPage.screenshot({ path: 'pr-evidence/workspace-project-chrome-clear.png' })
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
