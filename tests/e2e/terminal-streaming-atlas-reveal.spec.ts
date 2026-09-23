import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { sendToTerminal, waitForActivePanePtyId } from './helpers/terminal'

// Why: mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'
const TOGGLE_EVENT = 'orca-toggle-floating-terminal'
// Why: a shell builtin, so the pane blocks even when node is not on the isolated profile's PATH;
// an idle prompt blinks its cursor and no screenshot ever stabilizes.
const SILENT_FOREGROUND_COMMAND =
  process.platform === 'win32' ? 'Start-Sleep -Seconds 3600\r' : 'sleep 3600\r'
const STREAM_MS = 4_000

/**
 * Question: does a tab reveal elsewhere leave a STREAMING terminal painting something other than
 * its buffer (garbled or stale cells)? A reveal wipes the glyph atlas shared by every same-config
 * WebGL terminal; the wake path already avoids that mid-stream because of xterm.js #4480.
 *
 * Oracle: once the stream ends on a fixed final frame, the presented canvas must equal the canvas
 * after a forced full atlas rebuild — i.e. the pane shows its buffer. The control streams the same
 * frames with no reveals, so a failure is attributable to the reveals and not to the method.
 */

async function enableGpu(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    if (!store || !state?.settings) {
      throw new Error('Store unavailable')
    }
    store.setState({
      settings: { ...state.settings, floatingTerminalEnabled: true, terminalGpuAcceleration: 'on' }
    })
  })
}

async function waitForWebglOnTab(page: Page, tabId: string): Promise<boolean> {
  await page.evaluate((id) => {
    window.__paneManagers?.get(id)?.setTerminalGpuAcceleration?.('on')
  }, tabId)
  return page
    .waitForFunction(
      (id) =>
        (window.__paneManagers?.get(id)?.getRenderingDiagnostics?.() ?? []).some(
          (diagnostic) => diagnostic.hasWebgl
        ),
      tabId,
      { timeout: 15_000 }
    )
    .then(() => true)
    .catch(() => false)
}

async function ensureFloatingTabs(page: Page): Promise<string[]> {
  const tabIds = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    while ((store.getState().tabsByWorktree[worktreeId] ?? []).length < 2) {
      store.getState().createTab(worktreeId, undefined, undefined, { activate: false })
    }
    const tabs = store.getState().tabsByWorktree[worktreeId] ?? []
    store.getState().activateTab(tabs[0].id)
    return tabs.slice(0, 2).map((tab) => tab.id)
  }, FLOATING_WORKTREE_ID)
  await page.waitForFunction(
    (selector) => Boolean(document.querySelector(selector)),
    PANEL_SELECTOR,
    {
      timeout: 30_000
    }
  )
  return tabIds
}

async function toggleFloatingPanel(page: Page, open: boolean): Promise<void> {
  const isOpen = await page.locator(PANEL_SELECTOR).isVisible()
  if (isOpen !== open) {
    await page.evaluate((event) => window.dispatchEvent(new Event(event)), TOGGLE_EVENT)
  }
  await (open
    ? expect(page.locator(PANEL_SELECTOR)).toBeVisible()
    : expect(page.locator(PANEL_SELECTOR)).toBeHidden())
}

async function activateFloatingTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.__store?.getState().activateTab(id), tabId)
}

/** Draws a TUI-like frame in place, many times, with a glyph and colour population large enough to
 *  grow the shared atlas across pages; ends on one deterministic frame. */
async function streamFrames(page: Page, tabId: string, durationMs: number): Promise<void> {
  await page.evaluate(
    async ({ id, duration }) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error(`Pane unavailable for tab ${id}`)
      }
      const pool =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' +
        '[]{}<>/\\#@%&*+=~!?^;:,.|$_-─│┌┐└┘├┤┬┴┼═║╔╗╚╝▀▄█░▒▓●○◆◇→←↑↓✓✗'
      const frame = (seed: number): string => {
        let out = '\x1b[H\x1b[?25l'
        for (let row = 0; row < 16; row += 1) {
          let line = ''
          for (let col = 0; col < 60; col += 1) {
            const n = (seed * 131 + row * 31 + col * 7) % pool.length
            const sgr = `\x1b[${(seed + row + col) % 2 ? 1 : 22};${31 + ((seed + col) % 7)}m`
            line += sgr + pool[n]
          }
          out += `${line}\x1b[0m\x1b[K\r\n`
        }
        return out
      }
      const write = (data: string): Promise<void> =>
        new Promise((resolve) => pane.terminal.write(data, resolve))
      // Why: an agent TUI paints its body once and then redraws only a status line, so cells a
      // reset invalidated are never rewritten — the shape under which stale glyphs would persist.
      await write('\x1b[2J\x1b[3J')
      await write(frame(0))
      const started = performance.now()
      let tick = 1
      while (performance.now() - started < duration) {
        const spinner = pool[tick % pool.length]
        await write(`\x1b[18;1H\x1b[${31 + (tick % 7)}m${spinner} working ${tick}\x1b[0m\x1b[K`)
        tick += 1
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
      await write('\x1b[18;1H\x1b[32m✓ done\x1b[0m\x1b[K')
    },
    { id: tabId, duration: durationMs }
  )
}

async function screenshot(page: Page, ptyId: string): Promise<Buffer> {
  const screen = page.locator(`[data-pty-id="${ptyId}"] .xterm-screen`).first()
  await expect(screen).toBeVisible()
  return screen.screenshot({ animations: 'disabled' })
}

async function captureStable(page: Page, ptyId: string): Promise<Buffer> {
  let previous = await screenshot(page, ptyId)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(250)
    const next = await screenshot(page, ptyId)
    if (next.equals(previous)) {
      return next
    }
    previous = next
  }
  throw new Error('Terminal surface did not stabilize for a screenshot')
}

type Scenario = { workspaceTabId: string; workspacePtyId: string; floatingTabIds: string[] }

async function setUp(page: Page): Promise<Scenario | null> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await enableGpu(page)
  const workspaceTabId = await page.evaluate(() => window.__store?.getState().activeTabId ?? null)
  if (!workspaceTabId) {
    return null
  }
  const workspacePtyId = await waitForActivePanePtyId(page)
  if (!(await waitForWebglOnTab(page, workspaceTabId))) {
    return null
  }
  await sendToTerminal(page, workspacePtyId, SILENT_FOREGROUND_COMMAND)
  await page.waitForTimeout(1_000)
  const floatingTabIds = await ensureFloatingTabs(page)
  await toggleFloatingPanel(page, true)
  if (!(await waitForWebglOnTab(page, floatingTabIds[0]))) {
    return null
  }
  return { workspaceTabId, workspacePtyId, floatingTabIds }
}

async function presentedMatchesRebuilt(page: Page, scenario: Scenario): Promise<boolean> {
  await toggleFloatingPanel(page, false)
  // Why: scheduled reveal recoveries fire up to 500ms after their trigger; wait past them.
  await page.waitForTimeout(900)
  const presented = await captureStable(page, scenario.workspacePtyId)
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    manager?.resetWebglTextureAtlases?.()
    for (const pane of manager?.getPanes?.() ?? []) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  }, scenario.workspaceTabId)
  await page.waitForTimeout(900)
  const rebuilt = await captureStable(page, scenario.workspacePtyId)
  if (!presented.equals(rebuilt)) {
    writeFileSync(test.info().outputPath('presented.png'), presented)
    writeFileSync(test.info().outputPath('rebuilt.png'), rebuilt)
    const diff = await page.evaluate(
      async ({ a, b }) => {
        const load = async (b64: string): Promise<ImageData> => {
          const bitmap = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${b64}`)).blob()
          )
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const context = canvas.getContext('2d')!
          context.drawImage(bitmap, 0, 0)
          return context.getImageData(0, 0, bitmap.width, bitmap.height)
        }
        const [left, right] = [await load(a), await load(b)]
        let pixels = 0
        let minX = Infinity,
          minY = Infinity,
          maxX = -1,
          maxY = -1
        for (let i = 0; i < left.data.length; i += 4) {
          const delta =
            Math.abs(left.data[i] - right.data[i]) +
            Math.abs(left.data[i + 1] - right.data[i + 1]) +
            Math.abs(left.data[i + 2] - right.data[i + 2])
          if (delta > 48) {
            pixels += 1
            const x = (i / 4) % left.width
            const y = Math.floor(i / 4 / left.width)
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
          }
        }
        return { width: left.width, height: left.height, pixels, box: [minX, minY, maxX, maxY] }
      },
      { a: presented.toString('base64'), b: rebuilt.toString('base64') }
    )
    console.log(`[streaming-atlas] mismatch ${JSON.stringify(diff)} -> ${test.info().outputDir}`)
  }
  return presented.equals(rebuilt)
}

test.describe('streaming terminal across reveals @headful', () => {
  test('control: a streaming terminal with no reveals presents its buffer', async ({
    orcaPage
  }) => {
    const scenario = await setUp(orcaPage)
    test.skip(!scenario, 'WebGL inactive')
    await streamFrames(orcaPage, scenario!.workspaceTabId, STREAM_MS)
    expect(await presentedMatchesRebuilt(orcaPage, scenario!)).toBe(true)
  })

  test('a streaming terminal presents its buffer after reveals in another terminal', async ({
    orcaPage
  }) => {
    const scenario = await setUp(orcaPage)
    test.skip(!scenario, 'WebGL inactive')
    const { workspaceTabId, floatingTabIds } = scenario!
    // Why: prove the stimulus reached the streaming terminal — count the atlas resets it receives.
    await orcaPage.evaluate((id) => {
      const manager = window.__paneManagers?.get(id) as
        | { resetWebglTextureAtlases?: () => void }
        | undefined
      const original = manager?.resetWebglTextureAtlases?.bind(manager)
      ;(window as unknown as { __atlasResets: number }).__atlasResets = 0
      if (manager && original) {
        manager.resetWebglTextureAtlases = () => {
          ;(window as unknown as { __atlasResets: number }).__atlasResets += 1
          original()
        }
      }
    }, workspaceTabId)
    const stream = streamFrames(orcaPage, workspaceTabId, STREAM_MS)
    const deadline = Date.now() + STREAM_MS - 300
    let reveals = 0
    while (Date.now() < deadline) {
      await activateFloatingTab(orcaPage, floatingTabIds[reveals % 2 === 0 ? 1 : 0])
      reveals += 1
      await orcaPage.waitForTimeout(180)
    }
    await stream
    const resets = await orcaPage.evaluate(
      () => (window as unknown as { __atlasResets: number }).__atlasResets
    )
    console.log(`[streaming-atlas] reveals=${reveals} resetsDuringStream=${resets}`)
    expect(resets).toBeGreaterThan(0)
    expect(await presentedMatchesRebuilt(orcaPage, scenario!)).toBe(true)
  })
})
