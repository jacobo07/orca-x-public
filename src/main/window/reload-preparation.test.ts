import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RELOAD_PREPARATION_REQUEST_CHANNEL,
  requestReloadPreparation,
  resetReloadPreparationForTest,
  settleReloadPreparation,
  type ReloadPreparationTarget
} from './reload-preparation'

function createTarget(id: number): ReloadPreparationTarget & {
  sent: { channel: string; payload: { requestId: string } }[]
  destroy: () => void
} {
  const destroyedListeners: (() => void)[] = []
  let destroyed = false
  const target = {
    id,
    sent: [] as { channel: string; payload: { requestId: string } }[],
    isDestroyed: () => destroyed,
    send: (channel: string, payload: { requestId: string }) => {
      target.sent.push({ channel, payload })
    },
    once: (_event: 'destroyed', listener: () => void) => {
      destroyedListeners.push(listener)
    },
    removeListener: (_event: 'destroyed', listener: () => void) => {
      const index = destroyedListeners.indexOf(listener)
      if (index !== -1) {
        destroyedListeners.splice(index, 1)
      }
    },
    destroy: () => {
      destroyed = true
      for (const listener of destroyedListeners.splice(0)) {
        listener()
      }
    }
  }
  return target
}

function lastRequestId(target: ReturnType<typeof createTarget>): string {
  const request = target.sent.at(-1)
  expect(request?.channel).toBe(RELOAD_PREPARATION_REQUEST_CHANNEL)
  return request!.payload.requestId
}

describe('requestReloadPreparation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetReloadPreparationForTest()
    vi.useRealTimers()
  })

  it('resolves prepared and lets the renderer proceed when it answers in time', async () => {
    const target = createTarget(1)
    const outcome = requestReloadPreparation(target, { timeoutMs: 5_000 })

    const reply = settleReloadPreparation(1, { requestId: lastRequestId(target), outcome: 'prepared' })

    expect(reply).toEqual({ proceed: true })
    await expect(outcome).resolves.toBe('prepared')
  })

  it('resolves refused and tells the renderer not to proceed', async () => {
    const target = createTarget(1)
    const outcome = requestReloadPreparation(target, { timeoutMs: 5_000 })

    const reply = settleReloadPreparation(1, { requestId: lastRequestId(target), outcome: 'refused' })

    expect(reply).toEqual({ proceed: false })
    await expect(outcome).resolves.toBe('refused')
  })

  it('times out, and a late prepared answer is told not to proceed', async () => {
    const target = createTarget(1)
    const outcome = requestReloadPreparation(target, { timeoutMs: 5_000 })
    const requestId = lastRequestId(target)

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(outcome).resolves.toBe('timeout')

    // The renderer set its unload bypass while preparing; it must release it, not keep it.
    expect(settleReloadPreparation(1, { requestId, outcome: 'prepared' })).toEqual({
      proceed: false
    })
  })

  it('ignores an answer from another window', async () => {
    const a = createTarget(1)
    createTarget(2)
    const outcome = requestReloadPreparation(a, { timeoutMs: 5_000 })

    expect(
      settleReloadPreparation(2, { requestId: lastRequestId(a), outcome: 'prepared' })
    ).toEqual({ proceed: false })

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(outcome).resolves.toBe('timeout')
  })

  it('ignores an answer to an older request from the same window', async () => {
    const target = createTarget(1)
    const first = requestReloadPreparation(target, { timeoutMs: 5_000 })
    const staleId = lastRequestId(target)
    await vi.advanceTimersByTimeAsync(5_000)
    await first

    const second = requestReloadPreparation(target, { timeoutMs: 5_000 })

    expect(settleReloadPreparation(1, { requestId: staleId, outcome: 'prepared' })).toEqual({
      proceed: false
    })
    expect(
      settleReloadPreparation(1, { requestId: lastRequestId(target), outcome: 'prepared' })
    ).toEqual({ proceed: true })
    await expect(second).resolves.toBe('prepared')
  })

  it('resolves gone when the window is destroyed while preparing', async () => {
    const target = createTarget(1)
    const outcome = requestReloadPreparation(target, { timeoutMs: 5_000 })

    target.destroy()

    await expect(outcome).resolves.toBe('gone')
  })

  it('resolves gone without asking when the window is already destroyed', async () => {
    const target = createTarget(1)
    target.destroy()

    await expect(requestReloadPreparation(target, { timeoutMs: 5_000 })).resolves.toBe('gone')
    expect(target.sent).toEqual([])
  })

  it('keeps each window’s request separate', async () => {
    const a = createTarget(1)
    const b = createTarget(2)
    const outcomeA = requestReloadPreparation(a, { timeoutMs: 5_000 })
    const outcomeB = requestReloadPreparation(b, { timeoutMs: 5_000 })

    settleReloadPreparation(2, { requestId: lastRequestId(b), outcome: 'refused' })
    settleReloadPreparation(1, { requestId: lastRequestId(a), outcome: 'prepared' })

    await expect(outcomeA).resolves.toBe('prepared')
    await expect(outcomeB).resolves.toBe('refused')
  })
})
