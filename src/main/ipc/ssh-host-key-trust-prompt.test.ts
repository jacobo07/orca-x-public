import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      ipc.handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipc.handlers.delete(channel)
    })
  }
}))

import {
  registerHostKeyTrustHandler,
  requestHostKeyTrust,
  resetHostKeyTrustPromptsForTests,
  type HostKeyTrustPromptRequest
} from './ssh-host-key-trust-prompt'

const REQUEST: HostKeyTrustPromptRequest = {
  targetId: 'ssh-1',
  label: 'Build box',
  host: '10.0.0.5',
  port: 22,
  offeredFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  algorithm: 'ssh-ed25519'
}

function makeWindow(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } }
}

function requestIdOf(win: ReturnType<typeof makeWindow>): string {
  const call = win.webContents.send.mock.calls.find(
    ([channel]) => channel === 'ssh:host-key-trust-request'
  )
  return (call![1] as { requestId: string }).requestId
}

function submit(requestId: string, trust: unknown): void {
  ipc.handlers.get('ssh:submitHostKeyTrust')!(null, { requestId, trust })
}

describe('ssh host key trust prompt', () => {
  beforeEach(() => {
    ipc.handlers.clear()
    resetHostKeyTrustPromptsForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('V-PROMPT-ROUNDTRIP: sends the fingerprint and resolves true only on an explicit trust', async () => {
    const win = makeWindow()
    registerHostKeyTrustHandler(() => win as never)

    const answer = requestHostKeyTrust(() => win as never, REQUEST)

    expect(win.webContents.send).toHaveBeenCalledWith(
      'ssh:host-key-trust-request',
      expect.objectContaining({
        targetId: 'ssh-1',
        label: 'Build box',
        offeredFingerprint: REQUEST.offeredFingerprint,
        algorithm: 'ssh-ed25519'
      })
    )
    const requestId = requestIdOf(win)
    submit(requestId, true)

    await expect(answer).resolves.toBe(true)
    expect(win.webContents.send).toHaveBeenCalledWith('ssh:host-key-trust-resolved', { requestId })
  })

  it('resolves false when the person declines', async () => {
    const win = makeWindow()
    registerHostKeyTrustHandler(() => win as never)
    const answer = requestHostKeyTrust(() => win as never, REQUEST)

    submit(requestIdOf(win), false)

    await expect(answer).resolves.toBe(false)
  })

  it('V-PROMPT-LITERAL-TRUE: a truthy non-boolean answer does not trust', async () => {
    const win = makeWindow()
    registerHostKeyTrustHandler(() => win as never)
    const answer = requestHostKeyTrust(() => win as never, REQUEST)

    submit(requestIdOf(win), 'true')

    await expect(answer).resolves.toBe(false)
  })

  it('V-PROMPT-TIMEOUT-DENIES: an unanswered prompt resolves false after 120 s and cannot be answered later', async () => {
    vi.useFakeTimers()
    const win = makeWindow()
    registerHostKeyTrustHandler(() => win as never)
    const answer = requestHostKeyTrust(() => win as never, REQUEST)
    const requestId = requestIdOf(win)

    await vi.advanceTimersByTimeAsync(119_999)
    let settled = false
    void answer.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(answer).resolves.toBe(false)
    expect(win.webContents.send).toHaveBeenCalledWith('ssh:host-key-trust-resolved', { requestId })
    // A late click must not revive a request the connection already gave up on.
    submit(requestId, true)
    expect(
      win.webContents.send.mock.calls.filter(([c]) => c === 'ssh:host-key-trust-resolved')
    ).toHaveLength(1)
  })

  it('resolves false immediately with no window, leaving no timer behind', async () => {
    vi.useFakeTimers()

    await expect(requestHostKeyTrust(() => null, REQUEST)).resolves.toBe(false)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves false immediately when the window is destroyed', async () => {
    const win = makeWindow(true)

    await expect(requestHostKeyTrust(() => win as never, REQUEST)).resolves.toBe(false)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('ignores an answer for an unknown request id', () => {
    const win = makeWindow()
    registerHostKeyTrustHandler(() => win as never)

    submit('not-a-request', true)

    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
