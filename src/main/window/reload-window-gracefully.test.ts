import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null }
}))

import { resetReloadPreparationForTest, settleReloadPreparation } from './reload-preparation'
import { GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS, reloadWindowGracefully } from './reload-window-gracefully'

function createWebContents(id: number) {
  const order: string[] = []
  const sent: { channel: string; payload: { requestId: string } }[] = []
  const webContents = {
    id,
    order,
    sent,
    isDestroyed: () => false,
    send: vi.fn((channel: string, payload: { requestId: string }) => {
      order.push('prepare')
      sent.push({ channel, payload })
    }),
    once: vi.fn(),
    removeListener: vi.fn(),
    capturePage: vi.fn(() => {
      order.push('capture')
      return Promise.reject(new Error('no frame in tests'))
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

describe('reloadWindowGracefully', () => {
  afterEach(() => {
    resetReloadPreparationForTest()
    vi.useRealTimers()
  })

  it('prepares the renderer before it captures and reloads', async () => {
    const webContents = createWebContents(11)
    const onBeforeReload = vi.fn()
    const result = reloadWindowGracefully(webContents as never, { onBeforeReload })

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
    const result = reloadWindowGracefully(webContents as never, { onBeforeReload })

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
    const result = reloadWindowGracefully(webContents as never, {})

    await vi.advanceTimersByTimeAsync(GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS)

    await expect(result).resolves.toBe('timeout')
    expect(webContents.reload).not.toHaveBeenCalled()
  })
})
