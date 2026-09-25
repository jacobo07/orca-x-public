/**
 * Field symptom: the big terminal pane froze while its hover thumbnail stayed
 * live. The thumbnail reads main's model of the PTY, so the PTY kept producing;
 * main had stopped delivering to (or the pane had stopped consuming) a pane the
 * user was looking at. None of those states leaves ACK-starved in-flight bytes,
 * so the push-delivery watchdog could not see them.
 *
 * Stimulus: mark the on-screen pane's PTY hidden in main directly — the stale
 * hidden claim — so main drops every byte for a pane that is still on screen.
 * The control proves the freeze holds with a slow watchdog; the fast watchdog
 * must then recover the pane with no input to it and no reload.
 *
 * Restoring the bytes dropped while frozen is not asserted: in headless e2e a
 * local PTY has no main headless emulator to restore from (see
 * terminal-push-delivery-loss-recovery.spec.ts). Recovery is asserted by the
 * visible-pane counter, which only this path increments, and by live output.
 */
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
}

function recoveryCount(): number {
  return (
    (window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.snapshot()
      .visiblePaneRecoveryCount ?? -1
  )
}

test.describe('visible terminal pane freeze recovery', () => {
  // Why @headful: a never-shown window reports its document hidden, and a pane nobody can see is correctly left alone.
  test('a pane frozen on screen while its PTY keeps producing recovers without input @headful', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)

    await execInTerminal(orcaPage, ptyId, 'echo live-before-$((41+1))')
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 15_000 })
      .toContain('live-before-42')

    // Control: a watchdog too slow to act, so the freeze must hold on its own.
    const baseline = await orcaPage.evaluate(() => {
      const watchdog = (window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog
      if (!watchdog) {
        throw new Error('delivery watchdog e2e hook missing — exposeStore build?')
      }
      watchdog.configure({ intervalMs: 600_000 })
      return watchdog.snapshot().visiblePaneRecoveryCount
    })
    await orcaPage.evaluate((id) => window.api.pty.setHiddenRendererPty(id, true), ptyId)
    // Why write to the PTY directly: typing into the pane is user input, and
    // input paths can heal delivery on their own.
    await orcaPage.evaluate((id) => window.api.pty.write(id, 'echo frozen-$((100+1))\r'), ptyId)
    await orcaPage.waitForTimeout(3_000)
    expect(await getTerminalContent(orcaPage)).not.toContain('frozen-101')
    expect(await orcaPage.evaluate(recoveryCount)).toBe(baseline)

    // Recovery: keep the PTY producing across several fast ticks.
    await orcaPage.evaluate(() => {
      ;(window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.configure({
        intervalMs: 1_000
      })
    })
    for (let i = 0; i < 6; i++) {
      await orcaPage.evaluate(([id, n]) => window.api.pty.write(id, `echo producing-${n}\r`), [
        ptyId,
        i
      ] as const)
      await orcaPage.waitForTimeout(1_000)
    }
    await expect
      .poll(async () => orcaPage.evaluate(recoveryCount), { timeout: 30_000 })
      .toBeGreaterThan(baseline)

    // The remounted pane is live again: new output paints with no reload.
    const livePtyId = await waitForActivePanePtyId(orcaPage)
    expect(livePtyId).toBe(ptyId)
    await orcaPage.evaluate(
      (id) => window.api.pty.write(id, 'echo live-after-$((200+56))\r'),
      livePtyId
    )
    await expect
      .poll(async () => getTerminalContent(orcaPage), { timeout: 15_000 })
      .toContain('live-after-256')
  })
})
