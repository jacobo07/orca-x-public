import { describe, expect, it, vi } from 'vitest'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../shared/renderer-shutdown-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../shared/updater-renderer-events'
import {
  answerReloadPreparationRequests,
  prepareAndInvokeUpdaterInstall,
  registerRendererRestartIpcRelays
} from './renderer-restart-wiring'

describe('renderer restart wiring', () => {
  it('relays updater status, aborted installs, and prevented unload events', () => {
    const eventTarget = new EventTarget()
    const unloadPrevented = vi.fn()
    const restartAborted = vi.fn()
    const handleStatus = vi.fn()
    const abort = vi.fn()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const ipcRenderer = {
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener)
        return ipcRenderer
      })
    } as unknown as Parameters<typeof registerRendererRestartIpcRelays>[0]
    eventTarget.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, unloadPrevented)
    eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, restartAborted)

    registerRendererRestartIpcRelays(ipcRenderer, eventTarget, { handleStatus, abort })
    listeners.get('updater:status')?.({}, { state: 'error', message: 'install failed' })
    // Why: main abandons an install without any status when its verdict outlived the cycle.
    listeners.get('updater:quitAndInstallAborted')?.({})
    listeners.get('window:unload-prevented')?.({})

    expect(ipcRenderer.on).toHaveBeenCalledTimes(3)
    expect(handleStatus).toHaveBeenCalledWith({ state: 'error', message: 'install failed' })
    expect(abort).toHaveBeenCalledTimes(1)
    expect(unloadPrevented).toHaveBeenCalledTimes(1)
    expect(restartAborted).toHaveBeenCalledTimes(1)
  })

  it('marks preparation before invoking main and aborts on IPC failure', async () => {
    const eventTarget = new EventTarget()
    const calls: string[] = []
    eventTarget.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, () => {
      calls.push('prepared')
    })
    const relay = {
      markPrepared: () => calls.push('marked'),
      abort: () => calls.push('aborted')
    }
    const invoke = vi.fn(async () => {
      calls.push('invoked')
      throw new Error('IPC failed')
    })

    await expect(
      prepareAndInvokeUpdaterInstall(eventTarget, relay, invoke, async () => {
        calls.push('checkpoint-flushed')
      })
    ).rejects.toThrow('IPC failed')

    expect(calls).toEqual(['prepared', 'checkpoint-flushed', 'marked', 'invoked', 'aborted'])
  })

  describe('answerReloadPreparationRequests', () => {
    function setup(reply: unknown, awaitCheckpoint: () => Promise<void>) {
      const eventTarget = new EventTarget()
      const events: string[] = []
      eventTarget.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, () => events.push('started'))
      eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, () => events.push('aborted'))
      const listeners = new Map<string, (...args: unknown[]) => void>()
      const ipcRenderer = {
        on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
          listeners.set(channel, listener)
          return ipcRenderer
        }),
        invoke: vi.fn(async () => reply)
      }
      answerReloadPreparationRequests(ipcRenderer as never, eventTarget, awaitCheckpoint)
      const ask = (requestId: string) =>
        listeners.get('app:prepareForReload')?.({}, { requestId })
      return { ipcRenderer, events, ask }
    }

    it('lands the checkpoint, then reports prepared and keeps the bypass when main proceeds', async () => {
      const calls: string[] = []
      const { ipcRenderer, events, ask } = setup({ proceed: true }, async () => {
        calls.push('checkpoint')
      })

      ask('r1')

      await vi.waitFor(() => expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1))
      expect(calls).toEqual(['checkpoint'])
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('app:reloadPreparationSettled', {
        requestId: 'r1',
        outcome: 'prepared'
      })
      expect(events).toEqual(['started'])
    })

    it('reports refused when the checkpoint cannot be written', async () => {
      const { ipcRenderer, events, ask } = setup({ proceed: false }, () =>
        Promise.reject(new Error('disk full'))
      )

      ask('r2')

      await vi.waitFor(() => expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1))
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('app:reloadPreparationSettled', {
        requestId: 'r2',
        outcome: 'refused'
      })
      expect(events).toEqual(['started', 'aborted'])
    })

    it('stands the bypass down when main will not reload for this answer', async () => {
      const { ipcRenderer, events, ask } = setup({ proceed: false }, async () => {})

      ask('r3')

      await vi.waitFor(() => expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1))
      // Otherwise the next real close would skip the unsaved-changes prompt.
      await vi.waitFor(() => expect(events).toEqual(['started', 'aborted']))
    })
  })

  it('never installs the update when the shutdown checkpoint fails to persist', async () => {
    const eventTarget = new EventTarget()
    const invoke = vi.fn(() => Promise.resolve())
    const relay = { markPrepared: vi.fn(), abort: vi.fn() }

    await expect(
      prepareAndInvokeUpdaterInstall(eventTarget, relay, invoke, () =>
        Promise.reject(new Error('Failed to persist renderer state before unload.'))
      )
    ).rejects.toThrow('Failed to persist renderer state before unload.')

    expect(invoke).not.toHaveBeenCalled()
    expect(relay.markPrepared).not.toHaveBeenCalled()
  })
})
