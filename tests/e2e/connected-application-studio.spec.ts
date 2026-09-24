import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// PRODUCT REALITY — a project connects the real KobiiCraft Studio (studio.kobicraft.net).
//
// Live facts this run depends on, measured 2026-09-23: /api/health is public and reports a build;
// every other route redirects an anonymous session to /sign-in. So a truthful status for a fresh
// Orca partition is `auth-required` with that build — a surface that said "connected" because
// health was green would fail here.
//
// Security is asserted from main, against the real guest, both ways:
//   - the guest has no Orca bridge (no window.api, no require);
//   - a guest cannot START off the app's origin in its partition, while the app's own origin can
//     (the control that proves the refusal is not simply "webviews never attach");
//   - a navigation to an undeclared origin stays out of the view and goes to the system browser.
// Returning must find the same thread and the unsent draft.

test.setTimeout(300_000)

const STUDIO = 'https://studio.kobicraft.net'
const SIGN_IN = 'https://auth.kobicraft.net'

async function enableSurfaces(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window
      .__store!.getState()
      .updateSettingsOrThrow({ showAgentsButton: true, showConversationsButton: true })
  })
}

/** Creates a <webview> in the renderer and reports whether main let its guest attach. */
async function tryAttach(page: Page, partition: string, src: string): Promise<boolean> {
  return page.evaluate(
    async ({ partition, src }) => {
      const webview = document.createElement('webview') as HTMLElement & { src: string }
      webview.setAttribute('partition', partition)
      webview.style.width = '10px'
      webview.style.height = '10px'
      const attached = new Promise<boolean>((resolve) => {
        webview.addEventListener('did-attach', () => resolve(true))
        setTimeout(() => resolve(false), 8000)
      })
      document.body.appendChild(webview)
      webview.setAttribute('src', src)
      const result = await attached
      webview.remove()
      return result
    },
    { partition, src }
  )
}

test('a project connects KobiiCraft Studio truthfully, safely, and without losing the thread', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    await enableSurfaces(page)
    await app.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1700, 960)
      const opened: string[] = []
      ;(globalThis as { __externalOpens?: string[] }).__externalOpens = opened
      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })

    await page.locator('[data-workspace-activity="conversations"]').first().click()
    await page.getByTestId('workspace-new-agent').click()
    await page.getByTestId('new-agent-name').fill('Studio Hand')
    await page.getByTestId('new-agent-role').fill('creative')
    await page.getByTestId('new-agent-project').selectOption({ index: 0 })
    await page.getByTestId('new-agent-submit').click()
    await expect(page.getByTestId('agent-context-apps')).toBeVisible()

    await page.getByTestId('connected-app-add').click()
    await page.getByTestId('connected-app-label').fill('KobiiCraft Studio')
    await page.getByTestId('connected-app-origin').fill(STUDIO)
    await page.getByTestId('connected-app-signin').fill(SIGN_IN)
    await page.getByTestId('connected-app-submit').click()

    const row = page.getByTestId('connected-app-row')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-state', 'auth-required', { timeout: 30_000 })
    await expect(row).toContainText('700d0538')
    const appId = (await row.getAttribute('data-app-id')) as string
    const partition = `persist:orca-connected-app-${appId}`
    await page.screenshot({ path: testInfo.outputPath('studio-rail.png') })

    // The guest check, both poles.
    expect(await tryAttach(page, partition, 'https://example.com/')).toBe(false)
    expect(await tryAttach(page, partition, `${STUDIO}/`)).toBe(true)

    // A draft the person has not sent yet.
    await page.getByTestId('conversation-composer').fill('draft that must survive')

    await page.getByTestId('connected-app-open').click()
    await expect(page.getByTestId('connected-app-surface')).toBeVisible()
    await expect(page.getByTestId('connected-app-surface')).toHaveAttribute('data-load', 'ready', {
      timeout: 60_000
    })

    const guest = await app.evaluate(async ({ webContents }) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === 'webview')
      if (!view) {
        return null
      }
      return {
        id: view.id,
        url: view.getURL(),
        bridge: await view.executeJavaScript(
          'JSON.stringify({ api: typeof window.api, require: typeof require, electron: typeof window.electron })'
        )
      }
    })
    expect(guest).not.toBeNull()
    expect(guest!.url.startsWith(`${STUDIO}/sign-in`)).toBe(true)
    expect(JSON.parse(guest!.bridge)).toEqual({
      api: 'undefined',
      require: 'undefined',
      electron: 'undefined'
    })
    await page.screenshot({ path: testInfo.outputPath('studio-surface.png') })

    // An undeclared origin never loads in the view; it is handed to the system browser instead.
    await app.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id)!.executeJavaScript('location.href = "https://example.com/leave"')
    }, guest!.id)
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as { __externalOpens?: string[] }).__externalOpens ?? [])
      )
      .toContain('https://example.com/leave')
    const after = await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id)!.getURL(),
      guest!.id
    )
    expect(after.startsWith(STUDIO)).toBe(true)

    // Back: same thread, same unsent draft, and the guest is gone.
    await page.getByTestId('connected-app-back').click()
    await expect(page.getByTestId('connected-app-surface')).toHaveCount(0)
    await expect(page.getByTestId('conversation-composer')).toHaveValue('draft that must survive')
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }) =>
            webContents.getAllWebContents().filter((contents) => contents.getType() === 'webview')
              .length
        )
      )
      .toBe(0)

    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error(
        `[connected-app-studio-e2e] cleanup failed (not a test result): ${String(error)}`
      )
    })
  }
})
