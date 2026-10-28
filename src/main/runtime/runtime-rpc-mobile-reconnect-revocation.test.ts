import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { sendRequest } from './runtime-rpc-test-harness'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const WORKTREE = 'id:repo-1::/tmp/worktree-a'
const PTY_ID = 'reconnect-pty'

type ListedTerminal = { handle: string; ptyId: string | null }

async function openPairedHost() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
  const writes: { terminal: string; text: string }[] = []
  const spawn = vi.fn().mockResolvedValue({ id: PTY_ID })
  const kill = vi.fn(() => true)
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn,
    write: (ptyId, data) => {
      writes.push({ terminal: ptyId, text: data })
      return true
    },
    kill,
    getForegroundProcess: async () => null
  })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'phone', scope: 'runtime' })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const metadata = readRuntimeMetadata(userDataPath)
  await sendRequest(metadata!.transports[0]!.endpoint, {
    id: 'laptop_create',
    authToken: metadata!.authToken,
    method: 'terminal.create',
    params: {
      worktree: WORKTREE,
      command: 'reconnect-shell',
      tabId: 'reconnect-tab',
      leafId: '33333333-3333-4333-8333-333333333333',
      activate: true
    }
  })
  // Why: the pairing URL carries the device token, so authenticating again with it is the same device reconnecting.
  const connect = async () => {
    const session = await authenticateMobileWsSession(offer.pairingUrl)
    const responses = createEncryptedWsResponseReader(session)
    let seq = 0
    const call = async (method: string, params: unknown = {}) => {
      const id = `${method}-${++seq}`
      sendEncryptedWsRequest(session, { id, method, params })
      return (await responses.next(id)) as Record<string, unknown>
    }
    const list = async (): Promise<ListedTerminal[]> => {
      const reply = await call('terminal.list', { worktree: WORKTREE })
      return (reply.result as { terminals: ListedTerminal[] }).terminals
    }
    return { session, call, list }
  }
  return { server, writes, spawn, kill, offer, connect }
}

describe('phone reconnect keeps session identity; revocation holds at the next mutation', () => {
  it('a disconnect does not kill the PTY and the reconnected phone sees the same terminal, no duplicate', async () => {
    const host = await openPairedHost()
    try {
      const first = await host.connect()
      const before = await first.list()
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({ ptyId: PTY_ID })

      first.session.ws.close()
      await waitForWsClose(first.session.ws)

      const second = await host.connect()
      const after = await second.list()

      expect(host.kill).not.toHaveBeenCalled()
      expect(host.spawn).toHaveBeenCalledTimes(1)
      expect(after.map((t) => [t.handle, t.ptyId])).toEqual(before.map((t) => [t.handle, t.ptyId]))

      // The pre-disconnect handle still drives the same PTY after the reconnect.
      const sent = await second.call('terminal.send', {
        terminal: before[0]!.handle,
        text: 'after-reconnect',
        enter: true
      })
      expect(sent).toMatchObject({ ok: true })
      expect(
        host.writes
          .filter((w) => w.terminal === PTY_ID)
          .map((w) => w.text)
          .join('')
      ).toContain('after-reconnect')
      second.session.ws.close()
    } finally {
      await host.server.stop()
    }
  })

  it('control: an authorized phone terminal.send is written', async () => {
    const host = await openPairedHost()
    try {
      const phone = await host.connect()
      const [terminal] = await phone.list()
      const reply = await phone.call('terminal.send', {
        terminal: terminal!.handle,
        text: 'authorized',
        enter: false
      })
      expect(reply).toMatchObject({ ok: true })
      expect(host.writes).toContainEqual({ terminal: PTY_ID, text: 'authorized' })
      phone.session.ws.close()
    } finally {
      await host.server.stop()
    }
  })

  it('a revoked phone whose socket survived is refused at its next terminal.send with device_revoked and nothing is written', async () => {
    const host = await openPairedHost()
    try {
      const phone = await host.connect()
      const [terminal] = await phone.list()
      // Why: correctness must not depend on the live-connection kill landing.
      vi.spyOn(host.server['mobileSocketWiring']!, 'terminateDeviceConnections').mockReturnValue(0)
      expect(host.server.revokeRuntimeAccess(host.offer.deviceId)).toBe(true)
      expect(phone.session.ws.readyState).toBe(phone.session.ws.OPEN)

      const reply = await phone.call('terminal.send', {
        terminal: terminal!.handle,
        text: 'after-revoke',
        enter: true
      })

      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'unauthorized', data: { reason: 'device_revoked' } }
      })
      expect(host.writes.map((w) => w.text).join('')).not.toContain('after-revoke')
      phone.session.ws.close()
    } finally {
      await host.server.stop()
    }
  })
})
