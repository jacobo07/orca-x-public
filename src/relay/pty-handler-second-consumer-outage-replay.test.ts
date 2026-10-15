import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach proves the backing pid is alive; the runner's own pid always is.
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import { REPLAY_BUFFER_MAX } from './pty-handler'
import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const NONCE = 'a1b2c3d4'
const OUTAGE_TICKS = 13
const PANE_KEY = 'tab-a:leaf-a'
const TAB_ID = 'tab-a'

// Mirrors the tick the HWF reconnect leg prints (startTickLoop: `TICK-<nonce>-<n> <epoch>\n`, tty adds \r).
function tickLine(n: number): string {
  return `TICK-${NONCE}-${n} 1790820836.${String(n).padStart(9, '0')}\r\n`
}

function tickNumbers(replay: string | undefined): number[] {
  return [...(replay ?? '').matchAll(new RegExp(`TICK-${NONCE}-(\\d+) `, 'g'))].map((m) =>
    Number(m[1])
  )
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

describe('PtyHandler replay across an outage and a second consumer (rows 59 73, D-18)', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let emit: (data: string) => void

  const { spawnPty, attachPty } = createPtyRequestHelpers(() => dispatcher)

  async function spawnTickPty(params: Record<string, unknown> = {}): Promise<{
    id: string
    incarnationId: string
  }> {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        emit = cb
      }),
      onExit: vi.fn()
    })
    return await spawnPty(params)
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  describe('outage replay', () => {
    it('replays all 13 ticks produced while no consumer was attached, in order', async () => {
      const spawn = await spawnTickPty()
      // No attach of any kind between spawn and the ticks: the outage.
      for (let n = 1; n <= OUTAGE_TICKS; n += 1) {
        emit(tickLine(n))
      }

      const result = await attachPty({ id: spawn.id, suppressReplayNotification: true })

      expect(tickNumbers(result.replay)).toEqual(range(1, OUTAGE_TICKS))
    })

    it('control: a consumer attached throughout also gets all 13 on a later attach', async () => {
      const spawn = await spawnTickPty()
      await attachPty({ id: spawn.id, suppressReplayNotification: true })
      for (let n = 1; n <= OUTAGE_TICKS; n += 1) {
        emit(tickLine(n))
      }

      const result = await attachPty({ id: spawn.id, suppressReplayNotification: true })

      expect(tickNumbers(result.replay)).toEqual(range(1, OUTAGE_TICKS))
    })

    it('the live notifications of the outage are not what carries it: replay does', async () => {
      const spawn = await spawnTickPty()
      for (let n = 1; n <= OUTAGE_TICKS; n += 1) {
        emit(tickLine(n))
      }
      // A mux that was down received none of the pty.data pushes; model that by dropping them.
      vi.advanceTimersByTime(50)
      dispatcher.notify.mockClear()

      const result = await attachPty({ id: spawn.id, suppressReplayNotification: true })

      expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
      expect(tickNumbers(result.replay)).toEqual(range(1, OUTAGE_TICKS))
    })
  })

  describe('second consumer on the same PTY', () => {
    it('consumer B, with the pane identity A used, receives the ticks of the outage A missed', async () => {
      const spawn = await spawnTickPty({ paneKey: PANE_KEY, tabId: TAB_ID })
      emit(tickLine(1))
      emit(tickLine(2))
      const first = await attachPty({
        id: spawn.id,
        suppressReplayNotification: true,
        expectedPaneKey: PANE_KEY,
        expectedTabId: TAB_ID
      })
      expect(tickNumbers(first.replay)).toEqual([1, 2])
      // A is gone (carrier dropped); the outage ticks 3..15 are produced with nobody attached.
      for (let n = 3; n < 3 + OUTAGE_TICKS; n += 1) {
        emit(tickLine(n))
      }

      const second = await dispatcher.callRequest(
        'pty.attach',
        {
          id: spawn.id,
          suppressReplayNotification: true,
          expectedPaneKey: PANE_KEY,
          expectedTabId: TAB_ID
        },
        { isStale: () => false, clientId: 2 } as never
      )

      expect(tickNumbers((second as { replay?: string }).replay)).toEqual(range(1, 2 + OUTAGE_TICKS))
      expect((second as { incarnationId: string }).incarnationId).toBe(spawn.incarnationId)
    })

    it('a second consumer that supplies no identity is accepted and gets the same replay (permissive)', async () => {
      const spawn = await spawnTickPty({ paneKey: PANE_KEY, tabId: TAB_ID })
      for (let n = 1; n <= OUTAGE_TICKS; n += 1) {
        emit(tickLine(n))
      }

      const result = await attachPty({ id: spawn.id, suppressReplayNotification: true })

      expect(tickNumbers(result.replay)).toEqual(range(1, OUTAGE_TICKS))
    })

    it('a second consumer that supplies a different paneKey is refused as identity mismatch', async () => {
      const spawn = await spawnTickPty({ paneKey: PANE_KEY, tabId: TAB_ID })
      emit(tickLine(1))

      await expect(
        attachPty({
          id: spawn.id,
          suppressReplayNotification: true,
          expectedPaneKey: 'tab-b:leaf-b',
          expectedTabId: TAB_ID
        })
      ).rejects.toThrow('PTY "pty-1" not found (identity mismatch)')
    })

    it('a second consumer that supplies a different tabId is refused as identity mismatch', async () => {
      const spawn = await spawnTickPty({ paneKey: PANE_KEY, tabId: TAB_ID })
      emit(tickLine(1))

      await expect(
        attachPty({ id: spawn.id, suppressReplayNotification: true, expectedTabId: 'tab-b' })
      ).rejects.toThrow('PTY "pty-1" not found (identity mismatch)')
    })

    it('control: the refusal does not damage the PTY, the owning identity still attaches and replays', async () => {
      const spawn = await spawnTickPty({ paneKey: PANE_KEY, tabId: TAB_ID })
      for (let n = 1; n <= OUTAGE_TICKS; n += 1) {
        emit(tickLine(n))
      }
      await expect(
        attachPty({ id: spawn.id, suppressReplayNotification: true, expectedPaneKey: 'tab-b:leaf-b' })
      ).rejects.toThrow('identity mismatch')

      const result = await attachPty({
        id: spawn.id,
        suppressReplayNotification: true,
        expectedPaneKey: PANE_KEY
      })

      expect(tickNumbers(result.replay)).toEqual(range(1, OUTAGE_TICKS))
      expect(handler.activePtyCount).toBe(1)
    })
  })

  describe('replay bound', () => {
    it('the 13-tick outage is far below REPLAY_BUFFER_MAX', () => {
      const outageSize = range(1, OUTAGE_TICKS).reduce((sum, n) => sum + tickLine(n).length, 0)

      // A hundredfold margin: the cap cannot be what lost 13 ticks.
      expect(outageSize * 100).toBeLessThan(REPLAY_BUFFER_MAX)
    })

    it('an outage larger than the cap keeps the tail and loses the head', async () => {
      const spawn = await spawnTickPty()
      const total = Math.ceil(REPLAY_BUFFER_MAX / tickLine(1).length) + 50
      for (let n = 1; n <= total; n += 1) {
        emit(tickLine(n))
      }

      const result = await attachPty({ id: spawn.id, suppressReplayNotification: true })
      const seen = tickNumbers(result.replay)

      expect(result.replay!.length).toBeLessThanOrEqual(REPLAY_BUFFER_MAX)
      expect(seen.at(-1)).toBe(total)
      expect(seen).not.toContain(1)
    })
  })
})
