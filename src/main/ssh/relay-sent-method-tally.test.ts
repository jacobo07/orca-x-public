import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeFrame, MessageType } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'

const KEY = '__orcaRelaySentMethods'

function transport(): MultiplexerTransport & { feed: (b: Buffer) => void; written: Buffer[] } {
  const onData: ((b: Buffer) => void)[] = []
  const written: Buffer[] = []
  return {
    write: (b: Buffer) => {
      written.push(b)
    },
    onData: (cb) => onData.push(cb),
    onClose: () => {},
    feed: (b) => onData.forEach((cb) => cb(b)),
    written
  }
}

async function loadMux(tally: string | undefined) {
  vi.resetModules()
  delete (globalThis as Record<string, unknown>)[KEY]
  if (tally === undefined) {
    vi.stubEnv('ORCA_E2E_RELAY_METHOD_TALLY', '')
  } else {
    vi.stubEnv('ORCA_E2E_RELAY_METHOD_TALLY', tally)
  }
  return (await import('./ssh-channel-multiplexer')).SshChannelMultiplexer
}

function sentTally(): Record<string, number> | undefined {
  return (globalThis as unknown as Record<string, Record<string, number> | undefined>)[KEY]
}

describe('relay sent-method tally', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    delete (globalThis as Record<string, unknown>)[KEY]
  })

  it('counts requests and notifications at the write, never responses', async () => {
    const Mux = await loadMux('1')
    const t = transport()
    const mux = new Mux(t)
    void mux.request('git.replicaTips', { repoPath: '/r' }).catch(() => {})
    void mux.request('git.replicaTips', { repoPath: '/r' }).catch(() => {})
    mux.notify('sync.replicaFacts', { a: 1 })
    // An inbound request with no handler makes the mux write a response; that write has no method.
    const inbound = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'x.unknown' }))
    t.feed(encodeFrame(MessageType.Regular, 1, 0, inbound))
    await new Promise((r) => setImmediate(r))
    mux.dispose()
    expect(t.written.length).toBeGreaterThanOrEqual(4)
    expect(sentTally()).toEqual({ 'git.replicaTips': 2, 'sync.replicaFacts': 1 })
  })

  it('records nothing unless the e2e switch is on', async () => {
    const Mux = await loadMux(undefined)
    const t = transport()
    const mux = new Mux(t)
    mux.notify('sync.replicaFacts', {})
    mux.dispose()
    expect(t.written.length).toBeGreaterThan(0)
    expect(sentTally()).toBeUndefined()
  })
})
