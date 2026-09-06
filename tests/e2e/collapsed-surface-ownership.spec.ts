/**
 * A collapsed surface gives up more than its pixels.
 *
 * Hiding is three separate contracts and they fail independently: the surface must stop reserving
 * layout, stop taking pointer input, and stop appearing in the keyboard path. A panel that is
 * visually gone but still tab-reachable is the worst of the three, because the focus ring travels
 * somewhere nobody can see and only a keyboard user ever finds out.
 *
 * The fourth claim is the counterweight. Whatever the collapse does to relinquish ownership must not
 * cost the state the surface was holding — the cheap way to pass the first three is to destroy
 * everything, so re-expanding has to bring the same panel back, not a fresh one.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

async function setPanelOpen(page: Page, open: boolean): Promise<void> {
  await page.evaluate((next) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().setRightSidebarOpen(next)
  }, open)
  await expect.poll(async () => getStoreState<boolean>(page, 'rightSidebarOpen')).toBe(open)
}

type FocusWalk = { offenders: string[]; judged: number }

/** Walk the keyboard path and report any stop that is invisible or inside the collapsed panel. */
async function walkFocusPath(page: Page, steps: number): Promise<FocusWalk> {
  const offenders: string[] = []
  let judged = 0
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press('Tab')
    const offence = await page.evaluate(async () => {
      const active = document.activeElement
      if (!active || active === document.body) {
        return null
      }
      if (active.closest('[data-side-panel-content]')) {
        return `focus entered the collapsed panel: ${active.getAttribute('aria-label') ?? active.tagName}`
      }
      // Some controls are deliberately zero-width until focused and reveal themselves — a keyboard
      // affordance, not a hidden one — so the reveal needs time to run before it is called
      // invisible. But wait only while the element still holds focus: rows here re-render and drop
      // it, the reveal then correctly reverts, and waiting past that point measures "focus survived
      // a second and a half" instead. That confusion is what made this check report two offenders,
      // then one, then none, on identical logic.
      const deadline = performance.now() + 1500
      let rect = active.getBoundingClientRect()
      while (
        (rect.width === 0 || rect.height === 0) &&
        active.matches(':focus') &&
        performance.now() < deadline
      ) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        rect = active.getBoundingClientRect()
      }
      if (rect.width !== 0 && rect.height !== 0) {
        return 'judged-visible'
      }
      if (!active.matches(':focus')) {
        // Focus moved on before the question could be asked. Not a verdict either way.
        return null
      }

      const style = getComputedStyle(active)
      // An element can be zero-sized because of its own rules or because an ancestor is not being
      // rendered at all. Those are different defects, so name which one before reporting.
      const hiddenAncestors: string[] = []
      for (let node = active.parentElement; node; node = node.parentElement) {
        const parentStyle = getComputedStyle(node)
        if (
          parentStyle.display === 'none' ||
          parentStyle.visibility === 'hidden' ||
          parentStyle.opacity === '0' ||
          node.getBoundingClientRect().width === 0
        ) {
          hiddenAncestors.push(
            `${node.tagName.toLowerCase()}[${node.getAttributeNames().filter((name) => name.startsWith('data-')).join(',') || node.className.slice(0, 40)}] display=${parentStyle.display} vis=${parentStyle.visibility} opacity=${parentStyle.opacity} width=${node.getBoundingClientRect().width}`
          )
        }
      }
      return [
        'focus landed on a zero-sized element',
        active.tagName.toLowerCase(),
        `aria-label=${active.getAttribute('aria-label') ?? 'none'}`,
        `self: display=${style.display} vis=${style.visibility} maxWidth=${style.maxWidth} opacity=${style.opacity} matchesFocus=${active.matches(':focus')}`,
        `hiddenAncestors=${hiddenAncestors.length ? hiddenAncestors.join(' >> ') : 'none'}`
      ].join(' | ')
    })
    if (offence === 'judged-visible') {
      judged += 1
    } else if (offence) {
      judged += 1
      offenders.push(offence)
    }
  }
  return { offenders, judged }
}

test('collapsing the side panel surrenders layout, pointer and focus, and keeps its state', async ({
  sharedPage
}) => {
  test.setTimeout(180_000)

  const rail = sharedPage.locator('[data-workspace-activity-rail]')
  const panel = sharedPage.locator('[data-side-panel]')
  const panelContent = sharedPage.locator('[data-side-panel-content]')

  await expect(rail).toBeVisible({ timeout: 60_000 })
  await setPanelOpen(sharedPage, true)
  await expect(panelContent).toBeVisible({ timeout: 20_000 })

  // The state the collapse must not spend.
  const tabBefore = await getStoreState<string>(sharedPage, 'rightSidebarTab')
  const explorerBefore = await getStoreState<string>(sharedPage, 'rightSidebarExplorerView')
  const railWidthOpen = (await rail.boundingBox())?.width ?? 0
  const contentWidthOpen = (await panelContent.boundingBox())?.width ?? 0
  expect(contentWidthOpen, 'the panel must be carrying content before it is collapsed').toBeGreaterThan(0)

  // Act.
  await setPanelOpen(sharedPage, false)

  // ── Layout ownership: the strip stays, the panel stops reserving width ─────────────────────
  await expect(rail).toBeVisible()
  // Compared to the pixel rather than the float: the two candidate answers are "the rail's width"
  // and "the rail plus a whole panel", which are hundreds apart, so sub-pixel noise is not the
  // error this is sized to catch.
  expect(
    (await rail.boundingBox())?.width ?? 0,
    'the rail must survive the collapse'
  ).toBeCloseTo(railWidthOpen, 0)
  await expect
    .poll(async () => (await panel.boundingBox())?.width ?? -1, { timeout: 20_000 })
    .toBeLessThan(railWidthOpen + 1)
  expect(
    (await panelContent.boundingBox())?.width ?? 0,
    'the collapsed panel is still reserving width'
  ).toBe(0)

  // ── Pointer ownership: nothing inside the panel can be reached by a click ──────────────────
  const reachablePanelPixels = await sharedPage.evaluate(() => {
    const content = document.querySelector('[data-side-panel-content]')
    if (!content) {
      return 0
    }
    const rect = content.getBoundingClientRect()
    // Probe the seam itself: if the collapsed panel still owns pixels, they are here.
    const samples = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
      x: rect.left + rect.width * fraction,
      y: rect.top + rect.height / 2
    }))
    return samples.filter((point) => {
      const element = document.elementFromPoint(point.x, point.y)
      return element ? element.closest('[data-side-panel-content]') !== null : false
    }).length
  })
  expect(reachablePanelPixels, 'the collapsed panel still intercepts pointer input').toBe(0)

  // ── Focus ownership: the keyboard path skips it entirely ───────────────────────────────────
  // Reset focus by blurring rather than by clicking a corner: at this size the window's top-left
  // is the activity rail, so a click there switches surface and everything after it would be
  // measuring a different screen.
  await sharedPage.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) {
      active.blur()
    }
  })
  const viewBefore = await getStoreState<string>(sharedPage, 'activeView')
  const { offenders, judged } = await walkFocusPath(sharedPage, 40)
  // Positive control: stops where focus moved on before it could be measured are skipped, so
  // without this a walk that judged nothing at all would report the same clean result as a walk
  // that judged everything.
  expect(judged, 'the focus walk reached no conclusion about any stop').toBeGreaterThan(5)
  expect(offenders, offenders.join(' | ')).toEqual([])
  expect(
    await getStoreState<string>(sharedPage, 'activeView'),
    'the focus walk changed the surface, so nothing after it is about the collapsed panel'
  ).toBe(viewBefore)

  // ── The counterweight: re-expanding restores the panel, not a replacement ──────────────────
  await setPanelOpen(sharedPage, true)
  await expect(panelContent).toBeVisible({ timeout: 20_000 })
  expect(await getStoreState<string>(sharedPage, 'rightSidebarTab')).toBe(tabBefore)
  expect(await getStoreState<string>(sharedPage, 'rightSidebarExplorerView')).toBe(explorerBefore)
  await expect
    .poll(async () => (await panelContent.boundingBox())?.width ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0)

  // ── Focus transition: collapsing from inside must not strand the focus ring ────────────────
  // Focus left on a control the collapse just removed is invisible but still live — the next
  // keystroke goes somewhere nobody can see.
  //
  // Last on purpose. This puts focus somewhere programmatically, and a programmatic focus changes
  // the modality Chromium uses to decide `:focus-visible`; run before the tab walk it makes
  // focus-revealed controls stay hidden there and the walk then reports the product's fault as its
  // own. Ordering is part of the instrument.
  const focusedInsidePanel = await sharedPage.evaluate(() => {
    const candidate = document
      .querySelector('[data-side-panel-content]')
      ?.querySelector<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')
    if (!candidate) {
      return false
    }
    candidate.focus()
    return document.activeElement === candidate
  })
  expect(focusedInsidePanel, 'no focusable control inside the open panel to collapse away').toBe(
    true
  )

  await setPanelOpen(sharedPage, false)
  const stranded = await sharedPage.evaluate(() => {
    const active = document.activeElement
    if (!active || active === document.body || !active.closest('[data-side-panel-content]')) {
      return null
    }
    const rect = active.getBoundingClientRect()
    return rect.width === 0 || rect.height === 0
      ? `focus stayed on a control the collapse removed: ${active.tagName.toLowerCase()}`
      : null
  })
  expect(stranded, stranded ?? '').toBeNull()
})
