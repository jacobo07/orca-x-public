/**
 * Terminal-liveness probes that only accept output produced AFTER the probe's own write: a marker minted
 * per call, a rendered line exactly equal to it (never the echoed `echo MARKER`), read from the pane whose
 * `container.dataset.ptyId` is the probed PTY. An absent owning pane is a failed read, never a pass.
 */

import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import { sendToTerminal } from './terminal'
import { mainRendererEval } from './terminal-input-probes'
import { terminalHasOutputLine } from './terminal-output-line'
import { mintProbeMarker } from './terminal-probe-marker'
import { buildSettledShellProbeInputSequence } from '../terminal-probe-input-sequence'

/**
 * For an idle prompt only: POSIX gets Ctrl+U alone, because bash's SIGINT handling flushes the tty input
 * queue and dropped the command's first byte (GEX44: `cho MARKER` ran under an `echo` echo).
 */
function probeInputs(marker: string): readonly string[] {
  const command = `echo ${marker}\r`
  return process.platform === 'win32'
    ? buildSettledShellProbeInputSequence(command)
    : [`\x15${command}`]
}

/** Renderer expression: the owning pane's serialized buffer, or null when no pane is bound to `ptyId`. */
function owningPaneContentExpression(ptyId: string, charLimit: number): string {
  return `(() => {
    const ptyId = ${JSON.stringify(ptyId)}
    const panes = []
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes?.() ?? []) {
        if (pane.container?.dataset?.ptyId === ptyId) { panes.push(pane) }
      }
    }
    if (panes.length === 0) { return null }
    return panes.map((pane) => pane.serializeAddon?.serialize?.() ?? '').join('\\r\\n').slice(-${charLimit})
  })()`
}

async function readOwningPane(
  page: Page,
  ptyId: string,
  charLimit: number
): Promise<string | null> {
  return page.evaluate<string | null>(owningPaneContentExpression(ptyId, charLimit))
}

/** Like getTerminalContentForPty, but only the pane bound to `ptyId`; '' when no pane is. */
export async function readOwningPaneContent(
  page: Page,
  ptyId: string,
  charLimit = 4000
): Promise<string> {
  return (await readOwningPane(page, ptyId, charLimit)) ?? ''
}

async function pollOutputLine(
  read: () => Promise<string>,
  marker: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => terminalHasOutputLine(await read(), marker), {
        timeout: timeoutMs,
        message: `Terminal printed no line equal to "${marker}"`
      })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

/** Writes until a line equal to `marker` appears; each attempt shares the marker this call minted. */
async function writeUntilOutputLine(probe: {
  marker: string
  write: (input: string) => Promise<void>
  read: () => Promise<string>
  timeoutMs: number
  attempts: number
  onMiss?: () => Promise<void>
}): Promise<boolean> {
  for (let attempt = 0; attempt < probe.attempts; attempt += 1) {
    for (const input of probeInputs(probe.marker)) {
      await probe.write(input)
    }
    if (
      await pollOutputLine(probe.read, probe.marker, Math.ceil(probe.timeoutMs / probe.attempts))
    ) {
      return true
    }
    await probe.onMiss?.()
  }
  return false
}

/**
 * Direct `pty:write` to `ptyId`, then the owning pane must print the marker. Retrying cannot hide a
 * frozen terminal: it never prints the output line.
 */
export async function probeDirectWriteOutput(
  page: Page,
  ptyId: string,
  label: string,
  timeoutMs = 10_000,
  attempts = 3
): Promise<boolean> {
  const marker = mintProbeMarker(label)
  const gateSamples: unknown[] = []
  const ok = await writeUntilOutputLine({
    marker,
    write: (input) => sendToTerminal(page, ptyId, input),
    read: () => readOwningPaneContent(page, ptyId),
    timeoutMs,
    attempts,
    // Why sample main's gate: output held behind a closed dispatcher gate looks identical to lost output.
    onMiss: async () => {
      gateSamples.push(
        await page.evaluate(async () => {
          const s = await window.api.pty.getRendererDeliveryDebugSnapshot()
          return {
            ready: s.rendererPtyDispatcherReady,
            forced: s.rendererDispatcherReadyForcedCount,
            resets: s.rendererLifecycleResetCount,
            pendingChars: s.pendingChars
          }
        })
      )
    }
  })
  if (ok) {
    return true
  }
  // Why: a false here has been the oracle twice (lost byte, wrong pane); record what it actually read.
  const ownedPaneFound = (await readOwningPane(page, ptyId, 1)) !== null
  const seen = await page.evaluate((ptyId) => {
    const ptyIdsByTabId = window.__store?.getState().ptyIdsByTabId ?? {}
    const tabId = Object.keys(ptyIdsByTabId).find((id) => ptyIdsByTabId[id]?.includes(ptyId))
    const panes = (tabId ? window.__paneManagers?.get(tabId)?.getPanes?.() : undefined) ?? []
    return {
      tabId: tabId ?? null,
      ptyIdsByTabId,
      managerTabIds: [...(window.__paneManagers?.keys() ?? [])],
      paneCount: panes.length,
      tails: panes.map((pane) =>
        (pane.serializeAddon?.serialize?.() ?? '<no serializer>').slice(-600)
      )
    }
  }, ptyId)
  console.log(
    `[probeDirectWriteOutput] ${marker} not found for ${ptyId}: ${JSON.stringify({ marker, ownedPaneFound, ...seen, gateSamples })}`
  )
  return false
}

/** Clicks the xterm of the pane bound to `ptyId` and types the command: the full DOM keyboard chain. */
export async function probeKeyboardTypeOutput(
  page: Page,
  ptyId: string,
  label: string,
  timeoutMs = 10_000
): Promise<boolean> {
  const marker = mintProbeMarker(label)
  const pane = page.locator(`[data-pty-id=${JSON.stringify(ptyId)}]`)
  const xterm = pane.locator('.xterm').first()
  await ((await xterm.count()) > 0 ? xterm : pane.first()).click()
  await page.keyboard.type(`echo ${marker}`, { delay: 20 })
  await page.keyboard.press('Enter')
  return pollOutputLine(() => readOwningPaneContent(page, ptyId), marker, timeoutMs)
}

// ─── Main-process twins (post-renderer-crash: CDP to the crashed target is severed) ─────────

/** executeJavaScript twin of readOwningPaneContent; '' on no owning pane or a rejected eval. */
export async function mainReadOwningPaneContent(
  electronApp: ElectronApplication,
  ptyId: string,
  charLimit = 4000
): Promise<string> {
  try {
    return (
      (await mainRendererEval<string | null>(
        electronApp,
        owningPaneContentExpression(ptyId, charLimit)
      )) ?? ''
    )
  } catch {
    return ''
  }
}

export async function mainProbeDirectWriteOutput(
  electronApp: ElectronApplication,
  ptyId: string,
  label: string,
  timeoutMs = 10_000,
  attempts = 3
): Promise<boolean> {
  const marker = mintProbeMarker(label)
  try {
    const ok = await writeUntilOutputLine({
      marker,
      write: (input) =>
        mainRendererEval<void>(
          electronApp,
          `window.api.pty.write(${JSON.stringify(ptyId)}, ${JSON.stringify(input)})`
        ),
      read: () => mainReadOwningPaneContent(electronApp, ptyId),
      timeoutMs,
      attempts
    })
    if (!ok) {
      const tail = (await mainReadOwningPaneContent(electronApp, ptyId)).slice(-300)
      console.log(
        `[mainProbeDirectWriteOutput] ${marker} not found for ${ptyId}: ${JSON.stringify({ tail })}`
      )
    }
    return ok
  } catch {
    // executeJavaScript rejects while the window is mid-recovery: the write did not happen.
    return false
  }
}

/**
 * Full chain without CDP: xterm's input() feeds terminal.onData → transport.sendInput → pty:write, the
 * path keystrokes take past the DOM keyboard layer. Why input() and not paste(): bracketed paste would
 * make the shell insert the control chars literally. The output must appear on the pane that was fed.
 */
export async function mainProbeTransportPasteOutput(
  electronApp: ElectronApplication,
  label: string,
  timeoutMs = 10_000
): Promise<boolean> {
  const marker = mintProbeMarker(label)
  let ptyId: string | null
  try {
    ptyId = await mainRendererEval<string | null>(
      electronApp,
      `(() => {
        for (const manager of window.__paneManagers?.values() ?? []) {
          const pane = manager.getActivePane?.() ?? (manager.getPanes?.() ?? [])[0]
          if (!pane?.terminal?.input) { continue }
          const ptyId = pane.container?.dataset?.ptyId
          if (!ptyId) { return null }
          for (const input of ${JSON.stringify(probeInputs(marker))}) {
            pane.terminal.input(input, true)
          }
          return ptyId
        }
        return null
      })()`
    )
  } catch {
    return false
  }
  if (!ptyId) {
    return false
  }
  const fedPtyId = ptyId
  return pollOutputLine(() => mainReadOwningPaneContent(electronApp, fedPtyId), marker, timeoutMs)
}

/** pty:listSessions repopulates main's ptyOwnership; output reviving after it names that drop path. */
export async function mainProbeOwnershipRebuildRevivalOutput(
  electronApp: ElectronApplication,
  ptyId: string,
  label: string
): Promise<boolean> {
  try {
    await mainRendererEval<void>(electronApp, `window.api.pty.listSessions()`)
  } catch {
    return false
  }
  return mainProbeDirectWriteOutput(electronApp, ptyId, label)
}
