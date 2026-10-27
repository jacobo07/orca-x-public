import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import { connectMobileProtocolClient } from './mobile-protocol-test-client'
import { call, ok, read, registeredRepoPath } from './mobile-live-leg-steps'

// Plane: a disposable windowed Orca X (worktree build, throwaway profile) reached over CDP, with a
// scripted phone-protocol client as the phone. SCRIPTED CLIENT evidence: not a phone, not an emulator.
// Proves the desktop side of phone control: quiet chip by default, explanation on a dropped desktop
// keystroke without moving focus, the keystroke never reaching the PTY, and Take back.

const CDP = process.env.ORCA_LIVE_CDP ?? ''
const REPO_PATH = process.env.ORCA_LIVE_REPO_PATH ?? ''
const SHOTS = process.env.ORCA_LIVE_SHOTS ?? ''
const BANNER = '.mobile-driver-banner'
const DESKTOP_TYPED = 'DESKTOPTYPED'

async function mainWindow(cdpUrl: string): Promise<Page> {
  const browser = await chromium.connectOverCDP(cdpUrl)
  const pages = browser.contexts().flatMap((context) => context.pages())
  const page = pages.find((candidate) => /index\.html/.test(candidate.url())) ?? pages[0]
  if (!page) {
    throw new Error('no Orca window over CDP')
  }
  return page
}

describe.skipIf(!CDP || !REPO_PATH || !SHOTS)('live desktop leg: phone control chip', () => {
  it('shows the chip, explains a dropped desktop keystroke without moving focus, and takes back', async () => {
    mkdirSync(SHOTS, { recursive: true })
    const evidence: Record<string, unknown> = {}
    const page = await mainWindow(CDP)
    const offer = await page.evaluate(() =>
      window.api.mobile.getPairingQR({
        address: '127.0.0.1',
        connectionMode: 'local-only',
        rotate: true
      })
    )
    if (!offer.available) {
      throw new Error(`pairing unavailable: ${offer.reason ?? 'unknown'}`)
    }
    const deviceToken = parsePairingCode(offer.pairingUrl)?.deviceToken
    if (!deviceToken) {
      throw new Error('pairing URL did not parse')
    }
    const phone = await connectMobileProtocolClient(offer.pairingUrl)
    let handle = ''
    try {
      const repo = await registeredRepoPath(phone, REPO_PATH)
      handle = ok<{ terminal: { handle: string } }>(
        await call(phone, 'terminal.create', { worktree: `path:${repo}` }),
        'create'
      ).terminal.handle
      // A fresh profile opens on the start screen; open the workspace so its terminals mount.
      await page.getByText(basename(repo), { exact: true }).first().click()
      await expect
        .poll(() => page.locator('.xterm-helper-textarea').count(), { timeout: 20_000 })
        .toBeGreaterThan(0)
      await page.waitForTimeout(2_000)
      await expect.poll(() => page.locator(BANNER).count()).toBe(0)
      await page.screenshot({ path: join(SHOTS, '1-before.png') })

      // The phone takes the terminal with the app's display-mode "take control" gesture. A JSON
      // terminal.subscribe is refused for mobile clients (binary_terminal_stream_required), and this
      // scripted client does not speak the binary multiplex stream the app subscribes with.
      ok(
        await call(phone, 'terminal.setDisplayMode', {
          terminal: handle,
          mode: 'auto',
          client: { id: deviceToken, type: 'mobile' }
        }),
        'setDisplayMode'
      )
      // Phone input itself needs a stream subscriber (mobile_input_floor_unavailable otherwise); it
      // was proven from the real phone separately. This leg is about the desktop side.

      const banner = page.locator(BANNER)
      await expect.poll(() => banner.count(), { timeout: 15_000 }).toBe(1)
      evidence.chipIsDialog = await page.locator(`${BANNER}[role="dialog"]`).count()
      expect(evidence.chipIsDialog).toBe(0)
      await page.screenshot({ path: join(SHOTS, '2-chip.png') })

      const before = await read(phone, handle)
      await page.locator('.xterm-helper-textarea').last().focus()
      await page.keyboard.type(DESKTOP_TYPED)
      await expect
        .poll(() => page.locator(`${BANNER}[role="dialog"]`).count(), { timeout: 10_000 })
        .toBe(1)
      evidence.focusAfterExplain = await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? null,
        className: (document.activeElement as HTMLElement | null)?.className ?? null
      }))
      expect(String((evidence.focusAfterExplain as { className: string }).className)).toContain(
        'xterm-helper-textarea'
      )
      await page.screenshot({ path: join(SHOTS, '3-explained.png') })
      await page.waitForTimeout(1_500)
      const after = await read(phone, handle, before.latestCursor)
      evidence.desktopKeystrokesReachedPty = after.tail.some((line) => line.includes(DESKTOP_TYPED))
      expect(evidence.desktopKeystrokesReachedPty).toBe(false)

      // The primary action is last in the card: Take back this terminal.
      await page.locator(`${BANNER}[role="dialog"] button`).last().click()
      await expect.poll(() => banner.count(), { timeout: 15_000 }).toBe(0)
      await page.screenshot({ path: join(SHOTS, '4-taken-back.png') })
      evidence.takenBack = true
    } finally {
      writeFileSync(join(SHOTS, 'result.json'), JSON.stringify(evidence, null, 2))
      if (handle) {
        await call(phone, 'terminal.close', { terminal: handle })
      }
      await phone.close()
    }
  }, 120_000)
})
