// Why: pins the renderer half of the dead-push-delivery recovery — the
// watchdog must cost nothing while output flows, confirm a wedge across two
// silent ticks against main's invoke-reported state, then heal exactly once
// per cooldown: re-attach push listeners, request the write-off, and route
// the pulled restore markers to pane handlers locally.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyRendererDeliveryHealthReply } from '../../../../shared/pty-renderer-delivery-health'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

const INTERVAL_MS = 15_000

const HEALTHY: PtyRendererDeliveryHealthReply = {
  inFlightTotalChars: 0,
  inFlightPtyCount: 0,
  msSinceLastAck: 1_000
}

const STALLED: PtyRendererDeliveryHealthReply = {
  inFlightTotalChars: 512 * 1024,
  inFlightPtyCount: 2,
  msSinceLastAck: null
}

describe('terminal delivery watchdog', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const reportMock = vi.fn<(args: unknown) => Promise<PtyRendererDeliveryHealthReply>>()
  const listenerCountMock = vi.fn(() => 1)
  const reattachMock = vi.fn()
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    reportMock.mockReset()
    listenerCountMock.mockClear()
    reattachMock.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          reportRendererDeliveryState: reportMock,
          getPtyDataListenerCount: listenerCountMock
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  async function startWatchdog(): Promise<{
    recordPtyDataReceived: (ptyId: string, chars: number) => void
    registerRestoreHandler: (
      ptyId: string,
      handler: (event: { id: string; reason: string; markerSeq?: number }) => void
    ) => void
  }> {
    const watchdog = await import('./terminal-delivery-watchdog')
    const restoreChannel = await import('./pty-model-restore-channel')
    watchdog.startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachMock,
      hasAttachedPtys: () => true
    })
    return {
      recordPtyDataReceived: watchdog.recordPtyDataReceived,
      registerRestoreHandler: (ptyId, handler) => {
        restoreChannel.registerPtyModelRestoreNeededHandler(ptyId, handler)
      }
    }
  }

  it('does zero IPC while pty output is flowing', async () => {
    const { recordPtyDataReceived } = await startWatchdog()

    for (let tick = 0; tick < 8; tick++) {
      recordPtyDataReceived('pty-1', 64)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    }

    expect(reportMock).not.toHaveBeenCalled()
  })

  it('reports during silence but never heals a healthy-idle main', async () => {
    reportMock.mockResolvedValue(HEALTHY)
    await startWatchdog()

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4)

    expect(reportMock).toHaveBeenCalledTimes(4)
    for (const call of reportMock.mock.calls) {
      expect((call[0] as { heal?: boolean }).heal).toBeUndefined()
    }
    expect(reattachMock).not.toHaveBeenCalled()
  })

  it('confirms a wedge across two silent ticks, re-attaches, and routes pulled restore markers', async () => {
    reportMock.mockImplementation((args) =>
      Promise.resolve(
        (args as { heal?: boolean }).heal
          ? {
              ...STALLED,
              inFlightTotalChars: 0,
              inFlightPtyCount: 0,
              writtenOff: [{ id: 'pty-1', markerSeq: 42, writtenOffChars: 512 * 1024 }]
            }
          : STALLED
      )
    )
    const { recordPtyDataReceived, registerRestoreHandler } = await startWatchdog()
    const restoreEvents: { id: string; reason: string; markerSeq?: number }[] = []
    registerRestoreHandler('pty-1', (event) => restoreEvents.push(event))

    // Bytes flowed once, then the push channel died: the field shape.
    recordPtyDataReceived('pty-1', 128)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(reportMock).not.toHaveBeenCalled()

    // First silent tick: report only, no heal yet.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(reattachMock).not.toHaveBeenCalled()

    // Second silent tick confirms: re-attach precedes the heal report, the
    // listener count is captured for field discrimination, and the pulled
    // marker reaches the pane handler without any push event.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(reattachMock).toHaveBeenCalledTimes(1)
    const healCalls = reportMock.mock.calls.filter(
      (call) => (call[0] as { heal?: boolean }).heal === true
    )
    expect(healCalls).toHaveLength(1)
    expect(healCalls[0]![0]).toMatchObject({
      heal: true,
      rendererPtyDataListenerCount: 1,
      receivedCharsByPty: { 'pty-1': 128 }
    })
    expect(restoreEvents).toEqual([{ id: 'pty-1', reason: 'delivery-heal', markerSeq: 42 }])
  })

  it('rate-limits heals to the cooldown while the wedge persists', async () => {
    reportMock.mockImplementation((args) =>
      Promise.resolve((args as { heal?: boolean }).heal ? { ...STALLED, writtenOff: [] } : STALLED)
    )
    await startWatchdog()

    const countHeals = (): number =>
      reportMock.mock.calls.filter((call) => (call[0] as { heal?: boolean }).heal === true).length

    // Ticks at 15s/30s: confirm + first heal.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    expect(countHeals()).toBe(1)

    // 45s/60s/75s: streak rebuilds but the 60s cooldown holds.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
    expect(countHeals()).toBe(1)

    // 90s: cooldown elapsed — one more heal, not one per tick.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(countHeals()).toBe(2)
    expect(reattachMock).toHaveBeenCalledTimes(2)
  })

  it('stays off when no PTY expects push delivery', async () => {
    reportMock.mockResolvedValue(STALLED)
    const watchdog = await import('./terminal-delivery-watchdog')
    watchdog.startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachMock,
      hasAttachedPtys: () => false
    })

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

    expect(reportMock).not.toHaveBeenCalled()
  })

  it('never starts without the invoke heal lane (web client, partial mocks)', async () => {
    ;(window.api.pty as { reportRendererDeliveryState?: unknown }).reportRendererDeliveryState =
      undefined
    const watchdog = await import('./terminal-delivery-watchdog')
    watchdog.startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachMock,
      hasAttachedPtys: () => true
    })

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

    expect(reattachMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  // Why: the field freeze had a live preview beside a frozen pane while other
  // PTYs kept flowing — exactly when the push probe stays silent.
  async function driveVisiblePane(paneReceivesOutput: boolean): Promise<ReturnType<typeof vi.fn>> {
    const { recordPtyDataReceived } = await startWatchdog()
    const liveness = await import('./visible-pane-output-liveness')
    const pipelineHealth = await import('@/lib/pane-manager/terminal-write-pipeline-health')
    const terminal = {}
    const requestRecovery = vi.fn()
    liveness.registerVisiblePaneLiveness({
      terminal,
      getPtyId: () => 'pty-visible',
      isOnScreen: () => true,
      requestRecovery
    })
    let modelSequence = 1
    reportMock.mockImplementation(async () => ({
      ...HEALTHY,
      modelOutputSequenceByPty: { 'pty-visible': modelSequence },
      hiddenGatedPtyIds: ['pty-visible']
    }))
    for (let tick = 0; tick < 3; tick++) {
      recordPtyDataReceived('pty-other', 64)
      if (paneReceivesOutput) {
        recordPtyDataReceived('pty-visible', 64)
        pipelineHealth.recordTerminalParseProgress(terminal)
      }
      modelSequence += 10
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    }
    return requestRecovery
  }

  it('asks main about on-screen panes even while other PTYs flow, and recovers a frozen one', async () => {
    const requestRecovery = await driveVisiblePane(false)

    expect(reportMock).toHaveBeenCalledWith(
      expect.objectContaining({ onScreenPtyIds: ['pty-visible'] })
    )
    expect(requestRecovery).toHaveBeenCalledTimes(1)
    expect(requestRecovery).toHaveBeenCalledWith('output-not-received')
    expect(reattachMock).not.toHaveBeenCalled()
  })

  // Why this is asserted and not assumed: the in-renderer ring is DevTools-only, so the remount the
  // stall triggers destroys the evidence of its own cause. Several field freezes stayed unattributed
  // for exactly that reason. A mirror nobody drives is a silent producer wearing a green suite.
  it('mirrors a visible-pane stall out of the renderer, with the cause attached', async () => {
    await driveVisiblePane(false)

    const { recordRendererCrashBreadcrumb } = await import('@/lib/crash-breadcrumb-recorder')
    const { TERMINAL_VISIBLE_PANE_STALL_BREADCRUMB } = await import('./terminal-delivery-watchdog')

    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      TERMINAL_VISIBLE_PANE_STALL_BREADCRUMB,
      expect.objectContaining({ cause: 'output-not-received' })
    )
  })

  // Bracketed rather than asserted as an absolute zero: this mock is not cleared between tests, so
  // `not.toHaveBeenCalled()` measures the whole file's history and fails against a correct build.
  // The claim is about THIS window, so the count is what must not move.
  it('does not mirror anything for a pane that keeps up (negative control)', async () => {
    const { recordRendererCrashBreadcrumb } = await import('@/lib/crash-breadcrumb-recorder')
    const mirrored = () => vi.mocked(recordRendererCrashBreadcrumb).mock.calls.length
    const before = mirrored()

    await driveVisiblePane(true)

    expect(mirrored()).toBe(before)
  })

  it('leaves an on-screen pane alone while it keeps up with its model', async () => {
    const requestRecovery = await driveVisiblePane(true)

    expect(reportMock).toHaveBeenCalledTimes(3)
    expect(requestRecovery).not.toHaveBeenCalled()
  })
})
