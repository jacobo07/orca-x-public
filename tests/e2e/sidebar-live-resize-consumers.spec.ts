/**
 * Dragging the sidebar edge moves the layout during the gesture, not after it.
 *
 * An earlier version of this measurement asserted geometry only, and reported nothing: a press that
 * never landed on the handle and a consumer that ignored the drag produce the same reading — both
 * leave the numbers unchanged. So this walks the chain one link at a time, and each link fails with
 * its own message. Nothing downstream is interpreted until the product itself confirms it accepted
 * the press, because a claim about consumers is only worth as much as the proof that the stimulus
 * occurred.
 *
 * The layers: the handle exists, the press puts the component into its drag state, the sidebar's own
 * width moves mid-gesture, the centre gives up exactly that space mid-gesture, the running terminal
 * is never replaced, and the release is what commits the width to the store.
 */

import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

/** Tab ids per worktree — the renderer's handle on the live terminal sessions. */
async function readTabIdentity(page: Page): Promise<string> {
  const tabs = await getStoreState<Record<string, { id: string }[]>>(page, 'tabsByWorktree')
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(tabs ?? {}).map(([worktreeId, list]) => [
        worktreeId,
        (list ?? []).map((tab) => tab.id)
      ])
    )
  )
}

async function widthOf(locator: Locator, what: string): Promise<number> {
  const box = await locator.boundingBox()
  if (!box) {
    throw new Error(`${what} has no bounding box`)
  }
  return box.width
}

test('the sidebar and the centre follow the drag, not the release', async ({ sharedPage }) => {
  test.setTimeout(180_000)

  // Arrange — docked left the panel and the project sidebar are alternatives, so the panel yields
  // before the project sidebar (and therefore its resize handle) is the left surface at all.
  await expect(sharedPage.locator('[data-workspace-activity-rail]')).toBeVisible({ timeout: 60_000 })
  await sharedPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().setRightSidebarOpen(false)
    store.getState().setSidebarOpen(true)
  })

  const handle = sharedPage.locator('[data-sidebar-resize-handle]')
  const sidebar = handle.locator('xpath=..')
  const centre = sharedPage.locator('.xterm').first()

  // ── Layer 1: the handle is on screen and hit-testable ──────────────────────────────────────
  await expect(handle, 'the resize handle must render before a drag can be measured').toBeVisible({
    timeout: 30_000
  })
  await expect(centre).toBeVisible({ timeout: 30_000 })

  const sessionsBefore = await readTabIdentity(sharedPage)
  expect(sessionsBefore, 'the fixture must leave a live terminal to protect').not.toBe('{}')

  const startWidth = await widthOf(sidebar, 'the sidebar')
  const startCentre = await widthOf(centre, 'the centre')
  const box = await handle.boundingBox()
  if (!box) {
    throw new Error('the resize handle has no bounding box')
  }
  const originX = box.x + box.width / 2
  const originY = box.y + box.height / 2

  // ── Layer 2: the point a user aims at is owned by the handle ───────────────────────────────
  // A layout box is not a hit target: an ancestor's clip or a neighbouring surface can take the
  // pixel while the box still reports full width. Naming the element that actually receives the
  // press is what separates "the handle ignored the drag" from "the drag never reached it".
  const ownerAtGrabPoint = await sharedPage.evaluate(
    ([x, y]) => {
      const element = document.elementFromPoint(x, y)
      if (!element) {
        return 'nothing'
      }
      return element.closest('[data-sidebar-resize-handle]')
        ? 'handle'
        : `${element.tagName.toLowerCase()}.${element.className || '(no class)'}`
    },
    [originX, originY]
  )
  expect(
    ownerAtGrabPoint,
    'the centre of the resize handle is not hit-testable — something else owns that pixel'
  ).toBe('handle')

  // ── Layer 3: the press is accepted ─────────────────────────────────────────────────────────
  // Move first, then press. Pressing without moving puts the button down wherever the pointer
  // happens to be, which is how the previous attempt pressed nothing and still read as a result.
  await sharedPage.mouse.move(originX, originY)
  await sharedPage.mouse.down()

  // The product's own signal that it entered the drag, not a synthetic one: the handle only carries
  // this while isResizing is true. If this fails, nothing below it is about consumers.
  await expect(handle, 'the press did not put the sidebar into its drag state').toHaveClass(
    /bg-ring\/10/,
    { timeout: 10_000 }
  )

  // ── Layer 3: the sidebar tracks the pointer mid-gesture ────────────────────────────────────
  const targetDelta = 80
  for (const step of [20, 40, 60, targetDelta]) {
    await sharedPage.mouse.move(originX + step, originY)
  }

  await expect
    .poll(async () => widthOf(sidebar, 'the sidebar'), {
      timeout: 10_000,
      message: 'the sidebar width did not move while the button was still down'
    })
    .toBeGreaterThan(startWidth + targetDelta / 2)

  // ── Layer 4: the centre yields the space during the same gesture ───────────────────────────
  await expect
    .poll(async () => widthOf(centre, 'the centre'), {
      timeout: 10_000,
      message: 'the centre did not give up width until the drag was released'
    })
    .toBeLessThan(startCentre - targetDelta / 2)

  // ── Layer 5: a layout change is not a session change ───────────────────────────────────────
  expect(await readTabIdentity(sharedPage), 'dragging replaced the terminal session').toBe(
    sessionsBefore
  )

  // ── Layer 6: the release is what commits ───────────────────────────────────────────────────
  await sharedPage.mouse.up()
  await expect(handle).not.toHaveClass(/bg-ring\/10/, { timeout: 10_000 })

  const committed = await getStoreState<number>(sharedPage, 'sidebarWidth')
  const rendered = await widthOf(sidebar, 'the sidebar')
  expect(committed, 'the released width was not committed to the store').toBeCloseTo(rendered, 0)
  expect(committed).toBeGreaterThan(startWidth)
  expect(await readTabIdentity(sharedPage)).toBe(sessionsBefore)
})
