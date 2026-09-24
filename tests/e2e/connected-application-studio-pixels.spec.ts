import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { connectApplicationToNewAgent, surfaceGuestId } from './helpers/connected-application-setup'

// VISUAL REALITY — the pixels in the Studio surface are Studio's, and they are a frame drawn AFTER
// Open. The earlier capture was taken the moment the guest finished loading and handed back the
// chat frame from before Open while every DOM check said the surface was ready. Measured on GEX44
// (3/3 runs): without waiting for the guest to paint, the region is the old white chat (diff 0.009,
// one colour); with the wait, it is Studio (diff 1.0). So the claim is bound to three things a
// stale frame cannot satisfy, and runs @headful so the window is shown as a person would see it:
//   - the guest itself reports two animation frames after its load (it painted);
//   - the region the guest occupies differs from the same region captured before Open;
//   - that region is not a uniform fill (a blank guest would also "differ" from the chat).
// A comparator self-check (before vs before) proves "differs" is not its only answer.

test.setTimeout(300_000)

const STUDIO = 'https://studio.kobicraft.net'
const SIGN_IN = 'https://auth.kobicraft.net'

type RegionVerdict = {
  windowVisible: boolean
  selfDiff: number
  diff: number
  distinctColors: number
  size: { width: number; height: number }
  beforePng: string
  afterPng: string
}

test('@headful the Studio surface shows the guest it loaded, not the chat it replaced', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1700, 960))

    const { row } = await connectApplicationToNewAgent(page, {
      label: 'KobiiCraft Studio',
      origin: STUDIO,
      signIn: SIGN_IN
    })
    await expect(row).toHaveAttribute('data-state', 'auth-required')

    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      ;(globalThis as { __beforeOpen?: Electron.NativeImage }).__beforeOpen =
        await win.capturePage()
    })

    await page.getByTestId('connected-app-open').click()
    const surface = page.getByTestId('connected-app-surface')
    await expect(surface).toHaveAttribute('data-load', 'ready', { timeout: 60_000 })

    const guestId = await surfaceGuestId(page)
    const guestUrl = await app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id)!
      await guest.executeJavaScript(
        'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
      )
      return guest.getURL()
    }, guestId)
    expect(guestUrl.startsWith(`${STUDIO}/sign-in`)).toBe(true)

    const rect = await page.getByTestId('connected-app-webview').evaluate((el) => {
      const box = el.getBoundingClientRect()
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height)
      }
    })
    expect(rect.width).toBeGreaterThan(200)
    expect(rect.height).toBeGreaterThan(200)

    const measure = (): Promise<RegionVerdict> =>
      app.evaluate(async ({ BrowserWindow }, rect) => {
        const win = BrowserWindow.getAllWindows()[0]!
        const beforeFull = (globalThis as { __beforeOpen?: Electron.NativeImage }).__beforeOpen!
        const afterFull = await win.capturePage()
        // Capture images are in device pixels; the rect is in CSS pixels of the content area.
        const scale = afterFull.getSize().width / win.getContentBounds().width
        const pixelRect = {
          x: Math.round(rect.x * scale),
          y: Math.round(rect.y * scale),
          width: Math.round(rect.width * scale),
          height: Math.round(rect.height * scale)
        }
        const before = beforeFull.crop(pixelRect)
        const after = afterFull.crop(pixelRect)
        const differing = (a: Buffer, b: Buffer): number => {
          let count = 0
          const pixels = Math.min(a.length, b.length) / 4
          for (let i = 0; i < pixels; i++) {
            const o = i * 4
            if (
              Math.abs(a[o]! - b[o]!) > 16 ||
              Math.abs(a[o + 1]! - b[o + 1]!) > 16 ||
              Math.abs(a[o + 2]! - b[o + 2]!) > 16
            ) {
              count++
            }
          }
          return pixels === 0 ? 0 : count / pixels
        }
        const beforeBitmap = before.toBitmap()
        const afterBitmap = after.toBitmap()
        const colors = new Set<number>()
        for (let o = 0; o < afterBitmap.length; o += 4 * 97) {
          colors.add((afterBitmap[o]! << 16) | (afterBitmap[o + 1]! << 8) | afterBitmap[o + 2]!)
        }
        return {
          windowVisible: win.isVisible(),
          selfDiff: differing(beforeBitmap, beforeBitmap),
          diff: differing(beforeBitmap, afterBitmap),
          distinctColors: colors.size,
          size: after.getSize(),
          beforePng: before.toPNG().toString('base64'),
          afterPng: after.toPNG().toString('base64')
        }
      }, rect)

    // Bounded by the condition, not a sleep: a frame that has not composited yet reads as "same".
    let verdict = await measure()
    await expect
      .poll(
        async () => {
          verdict = await measure()
          return verdict.diff
        },
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0.2)

    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      testInfo.outputPath('studio-region-before.png'),
      Buffer.from(verdict.beforePng, 'base64')
    )
    writeFileSync(
      testInfo.outputPath('studio-region-after.png'),
      Buffer.from(verdict.afterPng, 'base64')
    )
    console.log(
      `[studio-pixels] visible=${verdict.windowVisible} self=${verdict.selfDiff} diff=${verdict.diff.toFixed(3)} colors=${verdict.distinctColors} size=${verdict.size.width}x${verdict.size.height}`
    )

    expect(verdict.windowVisible).toBe(true)
    expect(verdict.selfDiff).toBe(0)
    expect(verdict.distinctColors).toBeGreaterThan(8)

    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error('[studio-pixels] dispose failed', error)
    })
  }
})
