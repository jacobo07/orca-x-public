/**
 * The voice dock is pane-owned chrome that reserves its strip. These assert the
 * property that made reserving the right choice: it must never sit on top of
 * terminal rows, because the bottom row is where an agent TUI draws its prompt.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { splitActiveTerminalPane, waitForPaneCount } from './helpers/terminal'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

type PaneDockGeometry = {
  leafId: string
  hasReservation: boolean
  hasDock: boolean
  paneBottom: number
  paneWidth: number
  dockTop: number
  dockBottom: number
  dockWidth: number
  terminalBottom: number
  buttonHit: boolean
  buttonLabel: string
  /** Class or tag of the nearest ancestor that actually paints, '' if none does. */
  bandPaintedBy: string
}

async function setVoiceEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (voiceEnabled) => {
    const state = window.__store?.getState()
    await state?.updateSettings({
      voice: { ...(state.settings?.voice ?? {}), enabled: voiceEnabled }
    })
  }, enabled)
}

async function readPaneDockGeometry(page: Page): Promise<PaneDockGeometry[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.pane[data-leaf-id]')).map((pane) => {
      const dock = pane.querySelector<HTMLElement>('[data-terminal-voice-dock]')
      const button = pane.querySelector<HTMLElement>('[data-voice-dock-state]')
      const terminal = pane.querySelector<HTMLElement>('.xterm-container')
      const paneRect = pane.getBoundingClientRect()
      const dockRect = dock?.getBoundingClientRect() ?? null
      const buttonRect = button?.getBoundingClientRect() ?? null
      // Why elementFromPoint rather than the button's own box: a box does not
      // shrink when an ancestor clips it, so a control can report full size
      // while owning none of those pixels.
      const hit =
        buttonRect === null
          ? null
          : document.elementFromPoint(
              buttonRect.left + buttonRect.width / 2,
              buttonRect.top + buttonRect.height / 2
            )
      return {
        leafId: pane.dataset.leafId ?? '',
        hasReservation: pane.hasAttribute('data-has-voice-dock'),
        hasDock: dock !== null,
        paneBottom: paneRect.bottom,
        paneWidth: paneRect.width,
        dockTop: dockRect?.top ?? -1,
        dockBottom: dockRect?.bottom ?? -1,
        dockWidth: dockRect?.width ?? -1,
        terminalBottom: terminal?.getBoundingClientRect().bottom ?? -1,
        buttonHit: hit instanceof Element && hit.closest('[data-voice-dock-state]') !== null,
        buttonLabel: button?.getAttribute('aria-label') ?? '',
        // Who actually paints the reserved band. The dock and .pane may both be
        // transparent and the band still be covered, because the pane-manager
        // root paints behind them — so ask the ancestor chain rather than one
        // element, or the check reports a void that is not there.
        bandPaintedBy: (() => {
          let node: HTMLElement | null = dock ?? pane
          while (node) {
            const color = getComputedStyle(node).backgroundColor
            const alpha = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(color)
            const opaque = color !== '' && color !== 'transparent' && !(alpha && Number(alpha[1]) === 0)
            if (opaque) {
              return node.className || node.tagName.toLowerCase()
            }
            node = node.parentElement
          }
          return ''
        })()
      }
    })
  )
}

test.describe.configure({ mode: 'serial' })
test.describe('Terminal voice dock', () => {
  registerTerminalPaneMountReadiness()

  test('is absent, and reserves nothing, while voice is off', async ({ orcaPage }) => {
    await setVoiceEnabled(orcaPage, false)

    await expect
      .poll(async () => (await readPaneDockGeometry(orcaPage)).every((pane) => !pane.hasDock), {
        timeout: 5_000,
        message: 'A voice dock rendered while voice was disabled'
      })
      .toBe(true)
    const panes = await readPaneDockGeometry(orcaPage)
    expect(panes.length).toBeGreaterThan(0)
    expect(panes.every((pane) => !pane.hasReservation)).toBe(true)
  })

  test('sits on the pane bottom without covering a terminal row', async ({ orcaPage }) => {
    await setVoiceEnabled(orcaPage, true)

    await expect
      .poll(async () => (await readPaneDockGeometry(orcaPage)).filter((p) => p.hasDock).length, {
        timeout: 5_000,
        message: 'The voice dock never appeared after enabling voice'
      })
      .toBeGreaterThan(0)

    const panes = await readPaneDockGeometry(orcaPage)
    expect(panes.length).toBeGreaterThan(0)
    for (const pane of panes) {
      expect(pane.hasDock, `pane ${pane.leafId} has no dock`).toBe(true)
      expect(pane.hasReservation, `pane ${pane.leafId} did not reserve`).toBe(true)
      // Glued to the pane's own bottom edge, not floating somewhere near it.
      expect(Math.abs(pane.dockBottom - pane.paneBottom)).toBeLessThan(1.5)
      expect(Math.abs(pane.dockWidth - pane.paneWidth)).toBeLessThan(1.5)
      // The occlusion contract: terminal content ends at or above the dock.
      expect(
        pane.terminalBottom,
        `terminal in pane ${pane.leafId} extends under the dock`
      ).toBeLessThanOrEqual(pane.dockTop + 1)
      expect(pane.buttonHit, `the dock button in pane ${pane.leafId} owns no pixels`).toBe(true)
      expect(pane.buttonLabel.length).toBeGreaterThan(0)
      // A reserved band nothing paints is a void — a white gap in light mode, a
      // black block in dark. The pane title strip avoids this by painting its
      // own background; the dock relies on an ancestor, so name the painter.
      expect(
        pane.bandPaintedBy,
        `nothing in the ancestor chain paints the dock band in pane ${pane.leafId}`
      ).not.toBe('')
    }
  })

  test('gives every pane in a split its own dock', async ({ orcaPage }) => {
    await setVoiceEnabled(orcaPage, true)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)

    await expect
      .poll(async () => (await readPaneDockGeometry(orcaPage)).filter((p) => p.hasDock).length, {
        timeout: 10_000,
        message: 'Both panes did not get a dock after the split'
      })
      .toBe(2)

    const panes = await readPaneDockGeometry(orcaPage)
    // Ownership has to be unambiguous before recording starts, and no pane may
    // claim to be recording — nothing has started a job here.
    expect(panes.filter((pane) => /recording/i.test(pane.buttonLabel))).toHaveLength(0)
    for (const pane of panes) {
      expect(pane.terminalBottom).toBeLessThanOrEqual(pane.dockTop + 1)
      expect(Math.abs(pane.dockBottom - pane.paneBottom)).toBeLessThan(1.5)
    }
  })
})
