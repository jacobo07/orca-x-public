import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// @headful: a never-shown window can hand back an empty capture, and the store refuses empty frames,
// so a hidden run would measure the refusal instead of the freeze frame.

type FreezeFrameProbe = {
  addedAt: number | null
  removedAt: number | null
  hydratedAt: number | null
  imageWidth: number | null
  imageHeight: number | null
  distinctColors: number | null
  viewportWidth: number
  viewportHeight: number
  firstPaintAt?: number | null
  firstContentfulPaintAt?: number | null
}

const OVERLAY_ID = 'orca-reload-freeze-frame'

async function installProbe(page: Page): Promise<void> {
  await page.addInitScript((overlayId) => {
    const probe = {
      addedAt: null as number | null,
      removedAt: null as number | null,
      hydratedAt: null as number | null,
      imageWidth: null as number | null,
      imageHeight: null as number | null,
      distinctColors: null as number | null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }
    ;(window as unknown as { __freezeFrameProbe: typeof probe }).__freezeFrameProbe = probe

    const measure = (overlay: Element): void => {
      const image = overlay.querySelector('img')
      if (!image) {
        return
      }
      probe.imageWidth = image.naturalWidth
      probe.imageHeight = image.naturalHeight
      // A capture of a blank or unpainted document is one flat colour; a picture of the app is not.
      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 32
      const context = canvas.getContext('2d')
      if (!context) {
        return
      }
      context.drawImage(image, 0, 0, 32, 32)
      const pixels = context.getImageData(0, 0, 32, 32).data
      const colors = new Set<number>()
      for (let i = 0; i < pixels.length; i += 4) {
        colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2])
      }
      probe.distinctColors = colors.size
    }

    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.id === overlayId && probe.addedAt === null) {
            probe.addedAt = performance.now()
            probe.viewportWidth = window.innerWidth
            probe.viewportHeight = window.innerHeight
            measure(node)
          }
        }
        for (const node of record.removedNodes) {
          if (node instanceof Element && node.id === overlayId && probe.removedAt === null) {
            probe.removedAt = performance.now()
          }
        }
      }
    }).observe(document, { childList: true, subtree: true })

    const watchHydration = (): void => {
      const store = window.__store
      if (!store) {
        requestAnimationFrame(watchHydration)
        return
      }
      const record = (): void => {
        if (probe.hydratedAt === null && store.getState().hydrationSucceeded) {
          probe.hydratedAt = performance.now()
        }
      }
      record()
      store.subscribe(record)
    }
    watchHydration()
  }, OVERLAY_ID)
}

async function readProbe(page: Page): Promise<FreezeFrameProbe | null> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __freezeFrameProbe?: FreezeFrameProbe })
      .__freezeFrameProbe
    if (!probe) {
      return null
    }
    // The document's own paint timeline: a first paint earlier than addedAt is a frame of the
    // new document drawn with no freeze frame over it.
    const paints = Object.fromEntries(
      performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime])
    )
    return {
      ...probe,
      firstPaintAt: paints['first-paint'] ?? null,
      firstContentfulPaintAt: paints['first-contentful-paint'] ?? null
    }
  })
}

async function reloadAndObserve(
  page: Page,
  trigger: () => Promise<void>
): Promise<FreezeFrameProbe> {
  await installProbe(page)
  const loaded = page.waitForEvent('load', { timeout: 30_000 })
  await trigger()
  await loaded
  // Settled once the app hydrated and either uncovered or never showed a frame at all.
  await expect
    .poll(
      async () => {
        const probe = await readProbe(page)
        return probe?.hydratedAt !== null && probe?.hydratedAt !== undefined
          ? probe.addedAt === null || probe.removedAt !== null
          : false
      },
      { timeout: 30_000, message: 'reloaded app never hydrated, or its overlay never came down' }
    )
    .toBe(true)
  const probe = await readProbe(page)
  expect(probe, 'the probe must be installed in the reloaded document').not.toBeNull()
  return probe!
}

function expectFrozenFrameCoveredHydration(probe: FreezeFrameProbe): void {
  expect(probe.addedAt, 'no freeze frame was painted after the reload').not.toBeNull()
  // Until the new document's first contentful paint the old frame stays on screen, so that paint
  // must be the frozen frame. Measured before the mount gate: FCP ran 20-25 ms ahead of it.
  expect(probe.firstContentfulPaintAt, 'the reloaded document never painted').not.toBeNull()
  expect(
    probe.firstContentfulPaintAt!,
    'the empty shell painted before the frozen frame covered it'
  ).toBeGreaterThanOrEqual(probe.addedAt!)
  expect(
    probe.distinctColors,
    'the frozen frame is a flat colour, not a picture of the app'
  ).toBeGreaterThan(4)
  // Main downscales the capture to CSS pixels, so the picture matches the viewport it covers.
  expect(Math.abs((probe.imageWidth ?? 0) - probe.viewportWidth)).toBeLessThanOrEqual(2)
  expect(Math.abs((probe.imageHeight ?? 0) - probe.viewportHeight)).toBeLessThanOrEqual(2)
  expect(probe.addedAt!, 'the frame must be up before the shell hydrates').toBeLessThanOrEqual(
    probe.hydratedAt!
  )
  expect(probe.removedAt, 'the frame must come down').not.toBeNull()
  expect(probe.removedAt!, 'the frame must not come down before hydration').toBeGreaterThanOrEqual(
    probe.hydratedAt!
  )
  // Uncovered by hydration, not by the 8 s backstop.
  expect(probe.removedAt! - probe.hydratedAt!).toBeLessThan(2_000)
}

async function expectFrameConsumed(page: Page): Promise<void> {
  const second = await page.evaluate(() => window.api.app.takeReloadFreezeFrame())
  expect(second, 'the frame is single-use; the reloaded document already took it').toBeNull()
  await expect(page.locator(`#${OVERLAY_ID}`)).toHaveCount(0)
}

async function focusFirstWindow(electronApp: ElectronApplication): Promise<void> {
  const focused = await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.focus()
    return BrowserWindow.getFocusedWindow() !== null
  })
  // The menu leg reloads the FOCUSED window; without focus it is a silent no-op.
  expect(focused, 'no focused window, so the menu reload could not reach anything').toBe(true)
}

test.describe('Reload freeze frame @headful', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('a cold start holds no frame and paints no overlay', async ({ orcaPage }) => {
    const frame = await orcaPage.evaluate(() => window.api.app.takeReloadFreezeFrame())
    expect(frame).toBeNull()
    await expect(orcaPage.locator(`#${OVERLAY_ID}`)).toHaveCount(0)
  })

  test('app:reload paints the last frame until the shell hydrates', async ({ orcaPage }) => {
    const probe = await reloadAndObserve(orcaPage, async () => {
      // Not awaited: the invoke's own document is destroyed by the reload it requests.
      void orcaPage.evaluate(() => window.api.app.reload()).catch(() => undefined)
    })
    console.log(`[freeze-frame] app:reload ${JSON.stringify(probe)}`)
    expectFrozenFrameCoveredHydration(probe)
    await expectFrameConsumed(orcaPage)
  })

  test('View > Reload paints the last frame until the shell hydrates', async ({
    electronApp,
    orcaPage
  }) => {
    await focusFirstWindow(electronApp)
    const probe = await reloadAndObserve(orcaPage, async () => {
      await electronApp.evaluate(({ Menu }) => {
        // Found by position rather than label, so the host locale cannot hide it.
        const viewMenu = Menu.getApplicationMenu()?.items.find((item) =>
          item.submenu?.items.some((entry) => entry.role?.toLowerCase() === 'toggledevtools')
        )
        const reloadItem = viewMenu?.submenu?.items[0]
        if (!reloadItem) {
          throw new Error('View > Reload is not registered')
        }
        reloadItem.click()
      })
    })
    console.log(`[freeze-frame] menu ${JSON.stringify(probe)}`)
    expectFrozenFrameCoveredHydration(probe)
    await expectFrameConsumed(orcaPage)
  })

  test('the force-reload accelerator paints the last frame until the shell hydrates', async ({
    electronApp,
    orcaPage
  }) => {
    await focusFirstWindow(electronApp)
    const probe = await reloadAndObserve(orcaPage, async () => {
      // sendInputEvent goes through before-input-event, the path a real Ctrl+Shift+R takes.
      await electronApp.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents
        if (!contents) {
          throw new Error('no window to send the accelerator to')
        }
        const modifiers: ('control' | 'shift' | 'meta')[] =
          process.platform === 'darwin' ? ['meta', 'shift'] : ['control', 'shift']
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers })
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers })
      })
    })
    console.log(`[freeze-frame] accelerator ${JSON.stringify(probe)}`)
    expectFrozenFrameCoveredHydration(probe)
    await expectFrameConsumed(orcaPage)
  })
})
