/**
 * Layer-discriminating input probes for frozen-terminal repro specs.
 *
 * The field failure (Discord #performance / GitHub #2836 family) is a pane
 * that shows content while keystrokes silently vanish. Both drop layers are
 * silent today:
 *   - renderer: transport.sendInput returns false when `!connected || !ptyId`
 *     (pty-transport.ts)
 *   - main: pty:write drops when `ptyOwnership` misses the id or the provider
 *     lookup fails (src/main/ipc/pty.ts writePtyInput)
 *
 * Direct `window.api.pty.write` bypasses the renderer transport, so:
 *   direct dead                 → MAIN-side drop (ownership/provider routing)
 *   direct alive, renderer dead → RENDERER input path (replay, focus, binding)
 * The ownership-rebuild probe invokes pty:listSessions, which repopulates
 * `ptyOwnership` as a side effect — input reviving after it is a smoking gun
 * for the missing-ownership drop path.
 *
 * Two probe families:
 *   - Page-based (Playwright CDP): for specs whose renderer never crashes.
 *   - Main-process-based (webContents.executeJavaScript): for post-crash
 *     phases — a crashed target severs Playwright's CDP session even though
 *     the app recovers, so the harness must drive the renderer from main.
 */

import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import { sendToTerminal, waitForTerminalOutput } from './terminal'
import { buildSettledShellProbeInputSequence } from '../terminal-probe-input-sequence'

// ─── Page-based probes (healthy CDP session) ────────────────────────

export async function probeDirectWrite(
  page: Page,
  ptyId: string,
  marker: string,
  timeoutMs = 10_000
): Promise<boolean> {
  for (const input of buildSettledShellProbeInputSequence(`echo ${marker}\r`)) {
    await sendToTerminal(page, ptyId, input)
  }
  try {
    await waitForTerminalOutput(page, marker, timeoutMs)
    return true
  } catch {
    return false
  }
}

/** Probe the full chain: focus the visible xterm and type through the keyboard. */
export async function probeKeyboardType(
  page: Page,
  marker: string,
  timeoutMs = 10_000
): Promise<boolean> {
  await page.locator('.xterm:visible').first().click()
  await page.keyboard.type(`echo ${marker}`, { delay: 20 })
  await page.keyboard.press('Enter')
  try {
    // Any appearance of the marker proves the roundtrip: xterm does not local-
    // echo, so typed characters only render after the PTY echoes them back.
    await waitForTerminalOutput(page, marker, timeoutMs)
    return true
  } catch {
    return false
  }
}

export async function probeOwnershipRebuildRevival(
  page: Page,
  ptyId: string,
  marker: string
): Promise<boolean> {
  await page.evaluate(async () => {
    await window.api.pty.listSessions()
  })
  return probeDirectWrite(page, ptyId, marker)
}

export async function getStorePtyIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }
    return Object.values(store.getState().ptyIdsByTabId).flat()
  })
}

// ─── Main-process-based probes (post-renderer-crash) ────────────────

export async function mainRendererEval<T>(
  electronApp: ElectronApplication,
  expression: string
): Promise<T> {
  return electronApp.evaluate(async ({ BrowserWindow }, expr) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error('no live window for executeJavaScript probe')
    }
    return (await win.webContents.executeJavaScript(expr, true)) as T
  }, expression) as Promise<T>
}

export async function mainRendererStoreReady(electronApp: ElectronApplication): Promise<boolean> {
  try {
    return await mainRendererEval<boolean>(
      electronApp,
      `Boolean(window.__store && window.__store.getState().workspaceSessionReady === true)`
    )
  } catch {
    // executeJavaScript rejects while the document is loading or the window
    // is mid-recovery; callers poll, so a false here is just "not yet".
    return false
  }
}

export async function mainGetStorePtyIds(electronApp: ElectronApplication): Promise<string[]> {
  try {
    return await mainRendererEval<string[]>(
      electronApp,
      `(() => {
        const store = window.__store
        if (!store) { return [] }
        return Object.values(store.getState().ptyIdsByTabId).flat()
      })()`
    )
  } catch {
    return []
  }
}

/** Serialize every mounted pane's buffer; marker search doesn't need per-pane precision. */
export async function mainGetAllTerminalContent(electronApp: ElectronApplication): Promise<string> {
  try {
    return await mainRendererEval<string>(
      electronApp,
      `(() => {
        const managers = window.__paneManagers
        if (!managers) { return '' }
        let combined = ''
        for (const manager of managers.values()) {
          for (const pane of manager.getPanes?.() ?? []) {
            combined += '\\n' + (pane.serializeAddon?.serialize?.() ?? '')
          }
        }
        return combined.slice(-8000)
      })()`
    )
  } catch {
    return ''
  }
}

export async function mainWaitForPaneMounted(
  electronApp: ElectronApplication,
  timeoutMs = 30_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await mainRendererEval<number>(
            electronApp,
            `(() => {
              const managers = window.__paneManagers
              if (!managers) { return 0 }
              let count = 0
              for (const manager of managers.values()) {
                count += (manager.getPanes?.() ?? []).length
              }
              return count
            })()`
          )
        } catch {
          return 0
        }
      },
      { timeout: timeoutMs, message: 'no terminal pane mounted after renderer recovery' }
    )
    .toBeGreaterThan(0)
}

// ─── Failure report ─────────────────────────────────────────────────

/**
 * Assemble the failure report for a reproduced frozen pane. Kept in one place
 * so every repro spec reports the same layer discrimination.
 */
export function buildFrozenPaneReport(
  context: string,
  probes: {
    directAlive: boolean
    transportAlive: boolean
    revivedByOwnershipRebuild: boolean
    ownershipRebuildAttempted?: boolean
    readinessAlive?: boolean
    ptyIds: string[]
    terminalTail: string
  }
): string {
  return [
    `REPRODUCED frozen terminal (${context}):`,
    ...(probes.readinessAlive === undefined
      ? []
      : [`  replay + transport readiness probe alive: ${probes.readinessAlive}`]),
    `  direct pty:write probe alive: ${probes.directAlive} (false ⇒ MAIN-side drop: ptyOwnership/provider)`,
    `  renderer input-path probe alive: ${probes.transportAlive} (false with direct alive ⇒ replay, focus, or renderer binding failure)`,
    `  ownership rebuild attempted: ${probes.ownershipRebuildAttempted ?? true}`,
    `  revived by pty:listSessions ownership rebuild: ${probes.revivedByOwnershipRebuild}`,
    `  pane ptyIds: ${JSON.stringify(probes.ptyIds)}`,
    `  terminal tail:\n${probes.terminalTail.slice(-600)}`
  ].join('\n')
}
