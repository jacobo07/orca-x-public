/**
 * The field symptom this file exists for: the hover preview stays live while the large pane shows
 * older content. The preview reads main's headless model, so everything up to the model is proven
 * healthy by the preview itself; the break is below it, on the pane's own presentation path.
 *
 * WHY A SECOND SPEC. `terminal-visible-pane-freeze-recovery.spec.ts` asserts through
 * `getTerminalContent`, which returns `serializeAddon.serialize()` — the xterm BUFFER. A buffer
 * oracle cannot fail on a canvas that stopped painting while xterm kept parsing, which is exactly
 * the reported state. That spec is not wrong and is not replaced: it proves delivery. This one adds
 * the oracle it structurally cannot have.
 *
 * The oracle here is a screenshot of the pane's screen element: the composited pixels, what the user sees.
 * It is independent of the production detector in LAYER, which is the property that matters: both
 * read real pixels rather than the model, so neither can be satisfied by a healthy buffer.
 *
 * The plant is the field state rather than an approximation of it: xterm's render service calls
 * `renderRows` on its renderer and then fires `onRender`. Neutering `renderRows` leaves the render
 * loop running, `onRender` firing, and the canvas painting nothing — "a renderer that still reports
 * a render while painting nothing", which `terminal-render-progress.ts` names as its own residual.
 */
import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  waitForActiveTerminalManager,
  waitForActivePanePtyId,
  execInTerminal,
  getTerminalContent
} from './helpers/terminal'

type DeliveryWatchdogWindow = Window & {
  __terminalDeliveryWatchdog?: {
    configure: (config: { intervalMs?: number }) => void
    snapshot: () => { visiblePaneRecoveryCount: number }
  }
  __orcaTerminalFreezeReport?: () => Promise<unknown>
}

/** Hashes the COMPOSITED pixels of the pane's screen — what the user sees. Reading the WebGL canvas
 *  from page context does not work: Orca's addon has no `preserveDrawingBuffer`, so outside the
 *  drawing task it reads back cleared and every frame hashes alike. That fooled this spec's first
 *  version, whose positive control stayed on one hash across fresh output on a healthy pane. */
async function presentedSignature(page: Page): Promise<string> {
  const png = await page.locator('.xterm-screen').first().screenshot({ animations: 'disabled' })
  return createHash('sha256').update(png).digest('hex')
}

const NEUTER_PAINT = `(() => {
  const managers = window.__paneManagers
  if (!managers) return 'no-managers'
  for (const manager of managers.values()) {
    const pane = manager.getActivePane?.() ?? manager.getPanes?.()?.[0]
    const renderer = pane?.terminal?._core?._renderService?._renderer?.value
    if (!renderer || typeof renderer.renderRows !== 'function') continue
    renderer.renderRows = () => {}
    return 'planted'
  }
  return 'no-renderer'
})()`

test.describe('visible terminal pane paint recovery', () => {
  // Why @headful: a never-shown window reports its document hidden, and a pane nobody can see is correctly left alone.
  test('a pane whose render loop paints nothing recovers without input @headful', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)

    // Positive control for the oracle itself: a gate that can only ever report "unchanged" would
    // pass every assertion below, so prove it moves on a pane that is demonstrably healthy.
    // Precondition, bounded on the condition: a shell that has not printed its prompt yet drops the
    // command below, and on a loaded host that took >15s. Failing here is a harness verdict.
    // Why escapes are stripped: PowerShell emits ESC[?1004h before its prompt, and counting that as
    // "ready" let the command race a shell that was not reading input yet.
    await expect
      .poll(async () => printableText(await getTerminalContent(orcaPage)).length, {
        timeout: 90_000,
        message: 'HARNESS: the shell never printed a prompt, so nothing below was exercised'
      })
      .toBeGreaterThan(0)
    const beforeHealthy = await presentedSignature(orcaPage)
    await execInTerminal(orcaPage, ptyId, 'echo paint-before-$((41+1))')
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 30_000 })
      .toContain('paint-before-42')
    await expect
      .poll(async () => presentedSignature(orcaPage), { timeout: 15_000 })
      .not.toBe(beforeHealthy)

    // Control: a watchdog too slow to act, so the frozen state must hold on its own.
    const baseline = await orcaPage.evaluate(() => {
      const watchdog = (window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog
      if (!watchdog) {
        throw new Error('delivery watchdog e2e hook missing — exposeStore build?')
      }
      watchdog.configure({ intervalMs: 600_000 })
      return watchdog.snapshot().visiblePaneRecoveryCount
    })

    expect(await orcaPage.evaluate(NEUTER_PAINT)).toBe('planted')
    const frozen = await presentedSignature(orcaPage)
    await orcaPage.evaluate((id) => window.api.pty.write(id, 'echo painted-$((100+1))\r'), ptyId)

    // THE FIELD STATE, AND THE WHOLE POINT OF THIS FILE. The buffer oracle sees the new text and
    // is green; the pixel oracle sees an unchanged canvas and is red. A spec asserting only the
    // first cannot fail here, which is why the previous one could not catch this class.
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 20_000 })
      .toContain('painted-101')
    expect(await presentedSignature(orcaPage), 'canvas painted while plant was in').toBe(
      frozen
    )
    expect(await orcaPage.evaluate(recoveryCount)).toBe(baseline)

    // Recovery: keep the PTY producing across several fast ticks, with no input to the pane.
    await orcaPage.evaluate(() => {
      ;(window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.configure({ intervalMs: 1_000 })
    })
    for (let i = 0; i < 8; i++) {
      await orcaPage.evaluate(([id, n]) => window.api.pty.write(id, `echo producing-${n}\r`), [
        ptyId,
        i
      ] as const)
      await orcaPage.waitForTimeout(1_000)
    }
    await expect
      .poll(async () => orcaPage.evaluate(recoveryCount), { timeout: 45_000 })
      .toBeGreaterThan(baseline)

    // The cause must name the layer that lied, or the next field report is unattributed again.
    const report = JSON.stringify(
      await orcaPage.evaluate(() => (window as DeliveryWatchdogWindow).__orcaTerminalFreezeReport?.())
    )
    expect(report).toContain('output-not-painted')

    // The remounted pane paints again: same PTY, new pixels, no reload and no keystroke.
    const livePtyId = await waitForActivePanePtyId(orcaPage)
    expect(livePtyId).toBe(ptyId)
    const recovered = await presentedSignature(orcaPage)
    await orcaPage.evaluate(
      (id) => window.api.pty.write(id, 'echo paint-after-$((200+56))\r'),
      livePtyId
    )
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 20_000 })
      .toContain('paint-after-256')
    await expect
      .poll(async () => presentedSignature(orcaPage), { timeout: 20_000 })
      .not.toBe(recovered)
  })
})

function printableText(serialized: string): string {
  // eslint-disable-next-line no-control-regex
  return serialized.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)?/g, '').trim()
}

function recoveryCount(): number {
  return (
    (window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.snapshot()
      .visiblePaneRecoveryCount ?? -1
  )
}
