import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { replaceUnansweringRenderer } = vi.hoisted(() => ({
  replaceUnansweringRenderer: vi.fn(async (): Promise<string> => 'replaced')
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null }
}))
vi.mock('./force-reload-replacement', () => ({ replaceUnansweringRenderer }))

import { resetReloadPreparationForTest, settleReloadPreparation } from './reload-preparation'
import {
  FORCE_RELOAD_PREPARE_TIMEOUT_MS,
  GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS,
  requestWindowReload,
  resetWindowReloadTransactionsForTest
} from './window-reload-transaction'

function createWebContents(
  id: number,
  { capturePage }: { capturePage?: () => Promise<unknown> } = {}
) {
  const order: string[] = []
  const sent: { channel: string; payload: { requestId: string } }[] = []
  const destroyedListeners: (() => void)[] = []
  let destroyed = false
  const webContents = {
    id,
    order,
    sent,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
      for (const listener of destroyedListeners.splice(0)) {
        listener()
      }
    },
    send: vi.fn((channel: string, payload: { requestId: string }) => {
      order.push('prepare')
      sent.push({ channel, payload })
    }),
    once: vi.fn((_event: 'destroyed', listener: () => void) => {
      destroyedListeners.push(listener)
    }),
    removeListener: vi.fn((_event: 'destroyed', listener: () => void) => {
      const index = destroyedListeners.indexOf(listener)
      if (index !== -1) {
        destroyedListeners.splice(index, 1)
      }
    }),
    capturePage: vi.fn(() => {
      order.push('capture')
      return capturePage?.() ?? Promise.reject(new Error('no frame in tests'))
    }),
    reload: vi.fn(() => {
      order.push('reload')
    }),
    reloadIgnoringCache: vi.fn(() => {
      order.push('reloadIgnoringCache')
    })
  }
  return webContents
}

async function waitForPrepareRequest(webContents: ReturnType<typeof createWebContents>) {
  await vi.waitFor(() => expect(webContents.sent).toHaveLength(1))
  return webContents.sent[0].payload.requestId
}

describe('requestWindowReload', () => {
  afterEach(() => {
    resetReloadPreparationForTest()
    resetWindowReloadTransactionsForTest()
    vi.useRealTimers()
  })

  it('prepares the renderer before it captures and reloads', async () => {
    const webContents = createWebContents(11)
    const onBeforeReload = vi.fn()
    const result = requestWindowReload(webContents as never, { kind: 'graceful', onBeforeReload })

    const requestId = await waitForPrepareRequest(webContents)
    expect(webContents.reload).not.toHaveBeenCalled()
    settleReloadPreparation(11, { requestId, outcome: 'prepared' })

    await expect(result).resolves.toBe('reloaded')
    expect(webContents.order).toEqual(['prepare', 'capture', 'reload'])
    expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled()
    expect(onBeforeReload).toHaveBeenCalledWith({ ignoreCache: false, webContentsId: 11 })
  })

  it('does not reload a window whose renderer refused to prepare', async () => {
    const webContents = createWebContents(12)
    const onBeforeReload = vi.fn()
    const result = requestWindowReload(webContents as never, { kind: 'graceful', onBeforeReload })

    settleReloadPreparation(12, {
      requestId: await waitForPrepareRequest(webContents),
      outcome: 'refused'
    })

    await expect(result).resolves.toBe('refused')
    expect(webContents.capturePage).not.toHaveBeenCalled()
    expect(webContents.reload).not.toHaveBeenCalled()
    expect(onBeforeReload).not.toHaveBeenCalled()
  })

  it('does not reload a window whose renderer never answers', async () => {
    vi.useFakeTimers()
    const webContents = createWebContents(13)
    const result = requestWindowReload(webContents as never, { kind: 'graceful' })

    await vi.advanceTimersByTimeAsync(GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS)

    await expect(result).resolves.toBe('timeout')
    expect(webContents.reload).not.toHaveBeenCalled()
  })

  it("lets the renderer's own already-prepared reload override a preparation main is waiting on", async () => {
    const webContents = createWebContents(14)
    const menuHook = vi.fn()
    const rendererHook = vi.fn()
    const menu = requestWindowReload(webContents as never, {
      kind: 'graceful',
      onBeforeReload: menuHook
    })
    const requestId = await waitForPrepareRequest(webContents)

    const renderer = requestWindowReload(webContents as never, {
      kind: 'prepared',
      onBeforeReload: rendererHook
    })

    await expect(renderer).resolves.toBe('reloaded')
    await expect(menu).resolves.toBe('reloaded')
    expect(webContents.reload).toHaveBeenCalledTimes(1)
    expect(rendererHook).toHaveBeenCalledWith({ ignoreCache: false, webContentsId: 14 })
    expect(menuHook).not.toHaveBeenCalled()
    // The shared unload bypass must survive: the late answer is told a reload is on its way.
    expect(settleReloadPreparation(14, { requestId, outcome: 'prepared' })).toEqual({ proceed: true })
    expect(webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('upgrades a reload already capturing to bypass the cache when Force Reload arrives', async () => {
    let releaseCapture: (() => void) | undefined
    const webContents = createWebContents(15, {
      capturePage: () =>
        new Promise((resolve) => {
          releaseCapture = () => resolve(null)
        })
    })
    const first = requestWindowReload(webContents as never, { kind: 'prepared' })
    await vi.waitFor(() => expect(releaseCapture).toBeDefined())

    const force = requestWindowReload(webContents as never, { kind: 'force' })
    releaseCapture?.()

    await expect(first).resolves.toBe('reloaded')
    await expect(force).resolves.toBe('reloaded')
    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    expect(webContents.reload).not.toHaveBeenCalled()
    expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1)
  })

  it('keeps each window’s transaction separate', async () => {
    const a = createWebContents(16)
    const b = createWebContents(17)
    const reloadA = requestWindowReload(a as never, { kind: 'graceful' })
    await waitForPrepareRequest(a)

    const forceB = requestWindowReload(b as never, { kind: 'force' })
    settleReloadPreparation(17, {
      requestId: await waitForPrepareRequest(b),
      outcome: 'prepared'
    })
    await expect(forceB).resolves.toBe('reloaded')

    expect(b.reloadIgnoringCache).toHaveBeenCalledTimes(1)
    expect(a.capturePage).not.toHaveBeenCalled()
    settleReloadPreparation(16, { requestId: a.sent[0].payload.requestId, outcome: 'prepared' })
    await expect(reloadA).resolves.toBe('reloaded')
    expect(a.reload).toHaveBeenCalledTimes(1)
    expect(a.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('settles as gone when the window closes while preparing, and a later reload starts fresh', async () => {
    const webContents = createWebContents(18)
    const result = requestWindowReload(webContents as never, { kind: 'graceful' })
    await waitForPrepareRequest(webContents)

    webContents.destroy()

    await expect(result).resolves.toBe('gone')
    expect(webContents.capturePage).not.toHaveBeenCalled()
    // The closed window's transaction is gone, not left to swallow a later request under that id.
    const next = createWebContents(18)
    const force = requestWindowReload(next as never, { kind: 'force' })
    settleReloadPreparation(18, { requestId: await waitForPrepareRequest(next), outcome: 'prepared' })
    await expect(force).resolves.toBe('reloaded')
    expect(next.reloadIgnoringCache).toHaveBeenCalledTimes(1)
  })
})

describe('Force Reload', () => {
  beforeEach(() => {
    replaceUnansweringRenderer.mockReset()
    replaceUnansweringRenderer.mockResolvedValue('replaced')
  })
  afterEach(() => {
    resetReloadPreparationForTest()
    resetWindowReloadTransactionsForTest()
    vi.useRealTimers()
  })

  it('keeps the same-process cache-bypass reload for a renderer that answers', async () => {
    const webContents = createWebContents(31)
    const onBeforeReload = vi.fn()
    const result = requestWindowReload(webContents as never, { kind: 'force', onBeforeReload })

    settleReloadPreparation(31, {
      requestId: await waitForPrepareRequest(webContents),
      outcome: 'prepared'
    })

    await expect(result).resolves.toBe('reloaded')
    expect(webContents.order).toEqual(['prepare', 'capture', 'reloadIgnoringCache'])
    expect(onBeforeReload).toHaveBeenCalledWith({ ignoreCache: true, webContentsId: 31 })
    expect(replaceUnansweringRenderer).not.toHaveBeenCalled()
  })

  it('replaces a renderer that refused to prepare, and never reloads it in place', async () => {
    const webContents = createWebContents(32)
    const onBeforeReload = vi.fn()
    const result = requestWindowReload(webContents as never, { kind: 'force', onBeforeReload })

    settleReloadPreparation(32, {
      requestId: await waitForPrepareRequest(webContents),
      outcome: 'refused'
    })

    await expect(result).resolves.toBe('replaced')
    expect(replaceUnansweringRenderer).toHaveBeenCalledWith(webContents)
    expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled()
    expect(webContents.reload).not.toHaveBeenCalled()
    // The replacer owns the mark for a replacement; this hook marks a same-process reload.
    expect(onBeforeReload).not.toHaveBeenCalled()
  })

  it('gives a silent renderer 1.5 s, then replaces it and tells a late answer not to proceed', async () => {
    vi.useFakeTimers()
    const webContents = createWebContents(33)
    const result = requestWindowReload(webContents as never, { kind: 'force' })
    // Read directly: vi.waitFor advances fake timers, which would spend part of the bound.
    const requestId = webContents.sent[0].payload.requestId

    await vi.advanceTimersByTimeAsync(FORCE_RELOAD_PREPARE_TIMEOUT_MS - 1)
    expect(replaceUnansweringRenderer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toBe('replaced')
    // A late answer must release the renderer's unload bypass, or a Cancel would leave it armed.
    expect(settleReloadPreparation(33, { requestId, outcome: 'prepared' })).toEqual({
      proceed: false
    })
    expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('leaves the window untouched when the user cancels the replacement', async () => {
    replaceUnansweringRenderer.mockResolvedValue('cancelled')
    const webContents = createWebContents(34)
    const result = requestWindowReload(webContents as never, { kind: 'force' })
    settleReloadPreparation(34, {
      requestId: await waitForPrepareRequest(webContents),
      outcome: 'refused'
    })

    await expect(result).resolves.toBe('cancelled')
    expect(webContents.capturePage).not.toHaveBeenCalled()
    expect(webContents.reload).not.toHaveBeenCalled()
    expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('escalates a Reload still preparing: 1.5 s from the Force, not the 5 s Reload bound', async () => {
    vi.useFakeTimers()
    const webContents = createWebContents(35)
    const graceful = requestWindowReload(webContents as never, { kind: 'graceful' })
    await waitForPrepareRequest(webContents)
    await vi.advanceTimersByTimeAsync(1_000)

    const force = requestWindowReload(webContents as never, { kind: 'force' })
    await vi.advanceTimersByTimeAsync(FORCE_RELOAD_PREPARE_TIMEOUT_MS)

    await expect(force).resolves.toBe('replaced')
    await expect(graceful).resolves.toBe('replaced')
    expect(replaceUnansweringRenderer).toHaveBeenCalledTimes(1)
    // One preparation for the joined requests, never a second one for the Force.
    expect(webContents.sent).toHaveLength(1)
  })

  it('an escalated Reload whose renderer then answers reloads once, bypassing the cache', async () => {
    const webContents = createWebContents(36)
    const graceful = requestWindowReload(webContents as never, { kind: 'graceful' })
    const requestId = await waitForPrepareRequest(webContents)

    const force = requestWindowReload(webContents as never, { kind: 'force' })
    settleReloadPreparation(36, { requestId, outcome: 'prepared' })

    await expect(force).resolves.toBe('reloaded')
    await expect(graceful).resolves.toBe('reloaded')
    expect(webContents.reload).not.toHaveBeenCalled()
    expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1)
    expect(replaceUnansweringRenderer).not.toHaveBeenCalled()
  })

  it('a Reload that is not escalated still reports a refusal instead of replacing', async () => {
    const webContents = createWebContents(37)
    const graceful = requestWindowReload(webContents as never, { kind: 'graceful' })
    settleReloadPreparation(37, {
      requestId: await waitForPrepareRequest(webContents),
      outcome: 'refused'
    })
    await expect(graceful).resolves.toBe('refused')
    expect(replaceUnansweringRenderer).not.toHaveBeenCalled()
  })
})
