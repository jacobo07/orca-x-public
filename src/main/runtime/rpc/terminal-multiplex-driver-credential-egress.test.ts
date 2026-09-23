import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalDriverState, RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

// A mobile driver's clientId is that phone's pairing bearer token. Observers of the terminal
// (remote desktops, web) must learn WHICH device drives, never the credential it pairs with.
const PHONE_A_TOKEN = 'a1'.repeat(24)
const PHONE_B_TOKEN = 'b2'.repeat(24)

type DriverChanged = {
  type: 'driver-changed'
  streamId: number
  driver: RuntimeTerminalDriverState
}

async function subscribeAsDesktopObserver(initialDriver: RuntimeTerminalDriverState) {
  const messages: string[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const driverListener: { current?: (driver: RuntimeTerminalDriverState) => void } = {}
  const runtime = stubRuntime({
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    serializeAuthoritativeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn(
      (_ptyId: string, listener: (driver: RuntimeTerminalDriverState) => void) => {
        driverListener.current = listener
        return vi.fn()
      }
    ),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue(initialDriver),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  void dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (msg) => messages.push(msg),
    {
      connectionId: 'conn-desktop',
      sendBinary: () => {},
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    }
  )
  await vi.waitFor(() =>
    expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
  )
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 5,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          viewport: { cols: 120, rows: 40 }
        })
      })
    )!
  )
  await vi.waitFor(() => expect(driverListener.current).toBeDefined())
  const driverEvents = (): DriverChanged[] =>
    messages
      .map((msg) => JSON.parse(msg).result)
      .filter((result): result is DriverChanged => result?.type === 'driver-changed')
  return {
    messages,
    driverEvents,
    emitDriver: (d: RuntimeTerminalDriverState) => driverListener.current!(d)
  }
}

function mobileClientId(event: DriverChanged | undefined): string {
  if (event?.driver.kind !== 'mobile') {
    throw new Error(`expected a mobile driver-changed event, got ${JSON.stringify(event)}`)
  }
  return event.driver.clientId
}

describe('terminal multiplex: a driving phone credential never reaches an observer', () => {
  it('the snapshot driver sent on subscribe names the phone without its token', async () => {
    const { messages, driverEvents } = await subscribeAsDesktopObserver({
      kind: 'mobile',
      clientId: PHONE_A_TOKEN
    })
    await vi.waitFor(() => expect(driverEvents().length).toBeGreaterThan(0))

    expect(messages.join('\n')).not.toContain(PHONE_A_TOKEN)
    expect(mobileClientId(driverEvents()[0])).toMatch(/^observed:[0-9a-f]{32}$/)
  })

  it('a live driver change names the phone without its token, stably and per device', async () => {
    const { messages, driverEvents, emitDriver } = await subscribeAsDesktopObserver({
      kind: 'idle'
    })
    emitDriver({ kind: 'mobile', clientId: PHONE_A_TOKEN })
    emitDriver({ kind: 'mobile', clientId: PHONE_B_TOKEN })
    emitDriver({ kind: 'mobile', clientId: PHONE_A_TOKEN })

    const mobile = driverEvents().filter((event) => event.driver.kind === 'mobile')
    expect(mobile).toHaveLength(3)
    const [a1, b, a2] = mobile.map(mobileClientId)
    expect(messages.join('\n')).not.toContain(PHONE_A_TOKEN)
    expect(messages.join('\n')).not.toContain(PHONE_B_TOKEN)
    // The overlay keys its collapse state on this id: a reconnect must not re-open it, and a
    // hand-off between phones must still register as a new actor.
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
  })

  it('non-mobile drivers pass through unchanged', async () => {
    const { driverEvents, emitDriver } = await subscribeAsDesktopObserver({ kind: 'idle' })
    emitDriver({ kind: 'desktop' })

    expect(driverEvents().map((event) => event.driver)).toEqual([
      { kind: 'idle' },
      { kind: 'desktop' }
    ])
  })
})
