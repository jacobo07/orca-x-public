import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodePairingOffer } from '../../shared/pairing'
import { loadOrCreateE2EEKeypair } from './e2ee-keypair'
import { fingerprintHostPublicKey } from './host-key-fingerprint'
import { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest } from './rpc/core'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { wakeBrokerHost } from './wake-broker-host'

// UNIT in-process (real RuntimeRpcServer): the readout must name the key this server pairs with and publishes,
// never a key resolved from another path (plan check W2).

const dirs: string[] = []
let server: OrcaRuntimeRpcServer | null = null

afterEach(async () => {
  await server?.stop()
  server = null
  wakeBrokerHost.attachPairingKeySource(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-wake-host-key-'))
  dirs.push(dir)
  return dir
}

// Why the dispatcher with no options: that is exactly the local caller an Owner shell reaches.
async function localCall(method: string): Promise<Record<string, unknown>> {
  const replies: string[] = []
  await server!['dispatcher'].dispatchStreaming(
    { id: 'host-key-1', method, params: null } as RpcRequest,
    (response: string) => replies.push(response)
  )
  return JSON.parse(replies[0]!) as Record<string, unknown>
}

describe('host.wake.admin.hostKey on a real RuntimeRpcServer', () => {
  it('reads the fingerprint of the key in this server pairing offer, on a host that is no wake broker', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)
    server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: tempUserData(),
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'phone',
      scope: 'mobile'
    })
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    const offered = fingerprintHostPublicKey(decodePairingOffer(offer.pairingUrl).publicKeyB64)
    expect(offered).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(wakeBrokerHost.current()).toBeNull()

    const reply = await localCall('host.wake.admin.hostKey')
    expect(reply).toMatchObject({ ok: true, result: { hostKey: offered } })

    // Why: a keypair minted elsewhere must fingerprint differently, or the equality above proves nothing.
    const elsewhere = fingerprintHostPublicKey(loadOrCreateE2EEKeypair(tempUserData()).publicKeyB64)
    expect(elsewhere).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(elsewhere).not.toBe(offered)
    expect((reply.result as { hostKey: string }).hostKey).not.toBe(elsewhere)
  })
})
