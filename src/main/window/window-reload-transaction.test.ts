import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null }
}))

import { resetReloadPreparationForTest, settleReloadPreparation } from './reload-preparation'
import {
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

    await expect(requestWindowReload(b as never, { kind: 'force' })).resolves.toBe('reloaded')

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
    await expect(requestWindowReload(next as never, { kind: 'force' })).resolves.toBe('reloaded')
    expect(next.reloadIgnoringCache).toHaveBeenCalledTimes(1)
  })
})
