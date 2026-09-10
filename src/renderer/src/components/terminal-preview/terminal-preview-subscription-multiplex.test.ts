import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'
import {
  _resetTerminalPreviewSubscriptionMultiplexForTest,
  observeTerminalPreview
} from './terminal-preview-subscription-multiplex'

/**
 * Main keys a preview subscription by (webContents, ptyId) and disposes the existing one when the
 * same pair connects again. One window may now hold two observers of one terminal — the in-window
 * preview overlay and a hover card — so a second naive connect would silently kill the first.
 *
 * The multiplex is the answer that needs no wire change: one main-side subscription per pty per
 * renderer, fanned out to every observer, released only when the last one leaves.
 */

type DataListener = (payload: TerminalPreviewDataPayload) => void

function makeApi() {
  const listeners: DataListener[] = []
  const connect = vi.fn(async (_ptyId: string, _opts?: { scrollbackRows?: number }) => ({
    snapshot: { data: 'screen', cols: 80, rows: 24, seq: 1 },
    replay: []
  }))
  const unsubscribe = vi.fn(async () => undefined)
  const ack = vi.fn(async () => undefined)
  const offData = vi.fn()
  return {
    listeners,
    connect,
    unsubscribe,
    ack,
    offData,
    emit: (payload: TerminalPreviewDataPayload) => listeners.forEach((listener) => listener(payload)),
    install: () => {
      ;(globalThis as unknown as { window: unknown }).window = {
        api: {
          terminalPreview: {
            connect,
            unsubscribe,
            ack,
            onData: (listener: DataListener) => {
              listeners.push(listener)
              return offData
            }
          }
        }
      }
    }
  }
}

describe('terminal preview subscription multiplex', () => {
  let api: ReturnType<typeof makeApi>

  beforeEach(() => {
    _resetTerminalPreviewSubscriptionMultiplexForTest()
    api = makeApi()
    api.install()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('delivers live output to every observer of the same terminal', async () => {
    const first: string[] = []
    const second: string[] = []

    const releaseFirst = observeTerminalPreview('p1', {
      scrollbackRows: 8,
      onSnapshot: () => undefined,
      onData: (payload) => first.push(payload.data)
    })
    await vi.waitFor(() => expect(api.connect).toHaveBeenCalled())

    const releaseSecond = observeTerminalPreview('p1', {
      scrollbackRows: 8,
      onSnapshot: () => undefined,
      onData: (payload) => second.push(payload.data)
    })
    await vi.waitFor(() => expect(api.connect).toHaveBeenCalledTimes(2))

    api.emit({ type: 'data', ptyId: 'p1', data: 'hello', bytes: 5 })

    // The second observer must not have cost the first its stream: main disposed the old
    // subscription on reconnect, so a naive second consumer would leave this array empty.
    expect(first).toEqual(['hello'])
    expect(second).toEqual(['hello'])

    releaseFirst()
    releaseSecond()
  })

  it('keeps the subscription while any observer remains and releases it exactly once', async () => {
    const releaseFirst = observeTerminalPreview('p1', {
      onSnapshot: () => undefined,
      onData: () => undefined
    })
    const releaseSecond = observeTerminalPreview('p1', {
      onSnapshot: () => undefined,
      onData: () => undefined
    })
    await vi.waitFor(() => expect(api.connect).toHaveBeenCalled())

    releaseFirst()
    expect(api.unsubscribe).not.toHaveBeenCalled()

    releaseSecond()
    await vi.waitFor(() => expect(api.unsubscribe).toHaveBeenCalledTimes(1))
    expect(api.unsubscribe).toHaveBeenCalledWith('p1')

    // Releasing twice must not unsubscribe a subscription a later observer now owns.
    releaseSecond()
    expect(api.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('never routes another terminal output to this terminal observers', async () => {
    const seen: string[] = []
    const release = observeTerminalPreview('p1', {
      onSnapshot: () => undefined,
      onData: (payload) => seen.push(payload.data)
    })
    await vi.waitFor(() => expect(api.connect).toHaveBeenCalled())

    api.emit({ type: 'data', ptyId: 'p2', data: 'other terminal', bytes: 14 })
    api.emit({ type: 'data', ptyId: 'p1', data: 'mine', bytes: 4 })

    expect(seen).toEqual(['mine'])
    release()
  })

  it('acknowledges each delivered batch once, not once per observer', async () => {
    const releaseFirst = observeTerminalPreview('p1', {
      onSnapshot: () => undefined,
      onData: () => undefined
    })
    const releaseSecond = observeTerminalPreview('p1', {
      onSnapshot: () => undefined,
      onData: () => undefined
    })
    await vi.waitFor(() => expect(api.connect).toHaveBeenCalled())

    api.emit({ type: 'data', ptyId: 'p1', data: 'hello', bytes: 5 })

    // Main's flow control counts bytes per subscription; acking per observer would credit twice
    // and let the producer outrun a preview that had only parsed one copy.
    await vi.waitFor(() => expect(api.ack).toHaveBeenCalledTimes(1))
    expect(api.ack).toHaveBeenCalledWith('p1', 5)

    releaseFirst()
    releaseSecond()
  })

  it('tells a late observer the terminal is gone rather than leaving it blank', async () => {
    api.connect.mockResolvedValueOnce({ snapshot: null, replay: [] } as never)
    let unavailable = false

    const release = observeTerminalPreview('p1', {
      onSnapshot: () => undefined,
      onData: () => undefined,
      onUnavailable: () => {
        unavailable = true
      }
    })

    await vi.waitFor(() => expect(unavailable).toBe(true))
    release()
  })
})
