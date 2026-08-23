/**
 * The terminal canvas is the largest surface in the Workspace, and it is the one surface the
 * token system does not own -- xterm takes its background from the terminal theme, so a canvas
 * can drift from the chrome around it with every token and every theme individually correct.
 * That is what #282c34 was: a blue-grey panel inside chrome painted from --background.
 *
 * This pins the relationship rather than the hex, so it keeps meaning something if either side
 * moves. It reads the rendered element in the running app because a themed canvas is exactly the
 * thing source inspection cannot confirm -- the value reaching xterm comes from settings, not CSS.
 */

import { test, expect } from './helpers/orca-app'
import { waitForActiveTerminalManager } from './helpers/terminal'

test('the terminal canvas paints the same surface as the app chrome', async ({ orcaPage }) => {
  await waitForActiveTerminalManager(orcaPage)

  // Why forced: the e2e host resolves to light, where both surfaces are white and agree for
  // reasons that say nothing about the reported defect. Dark is the case worth pinning, so the
  // test puts the app there rather than accepting whichever mode the machine happens to be in.
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ theme: 'dark' })
  })
  await orcaPage.waitForFunction(() => document.documentElement.classList.contains('dark'), null, {
    timeout: 15_000
  })

  const surfaces = await orcaPage.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll<HTMLElement>('.xterm')).find(
      (element) => element.offsetParent !== null
    )
    // Why a probe element: --background is authored as a hex string while a computed
    // background-color is rgb(). Letting the browser resolve both puts them in one format
    // without this test reimplementing colour parsing.
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(--background)'
    document.body.appendChild(probe)
    const appSurface = getComputedStyle(probe).backgroundColor
    probe.remove()

    return {
      canvasSurface: canvas ? getComputedStyle(canvas).backgroundColor : null,
      appSurface,
      isDark: document.documentElement.classList.contains('dark')
    }
  })

  // Why logged: the exact-value assertion below is dark-only, so a run that never entered dark
  // mode would pass on the relationship alone. Naming the observed mode keeps that visible
  // instead of leaving a weaker pass looking like the stronger one.
  console.log(
    `[e2e] terminal canvas ${surfaces.canvasSurface} vs app surface ${surfaces.appSurface} (dark=${surfaces.isDark})`
  )

  expect(surfaces.canvasSurface, 'no visible terminal canvas was rendered').not.toBeNull()
  expect(surfaces.isDark, 'the app never entered dark mode, so the value below proves nothing').toBe(
    true
  )
  expect(surfaces.canvasSurface).toBe(surfaces.appSurface)

  // Pinned to the value as well as the relationship: two surfaces can agree on the wrong colour.
  expect(surfaces.canvasSurface).toBe('rgb(10, 10, 10)')
})
