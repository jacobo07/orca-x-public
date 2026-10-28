import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from '../runtime-rpc-mobile-ws-test-harness'
import { makeStore } from '../runtime-rpc-worktree-store-fixtures'

const PARAMS = {
  repo: 'id:r1',
  requirementId: 'shim',
  approvedContentHash: 'a'.repeat(64),
  approvedHostKey: 'local@0123456789abcdef'
}

async function openSession(scope: 'runtime' | 'mobile') {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-prepare-gate-'))
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const prepare = vi
    .spyOn(runtime, 'runEnvironmentPrepareStep')
    .mockResolvedValue({ status: 'refused', reason: 'approval-missing' })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  const offer = server.createPairingOffer({ address: '127.0.0.1', name: `gate-${scope}`, scope })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const session = await authenticateMobileWsSession(offer.pairingUrl)
  const responses = createEncryptedWsResponseReader(session)
  return { server, session, responses, prepare, deviceId: offer.deviceId }
}

describe('environment.runPrepareStep device gate', () => {
  it('control: a live runtime-scoped device reaches the handler', async () => {
    const { server, session, responses, prepare } = await openSession('runtime')
    try {
      sendEncryptedWsRequest(session, {
        id: 'ctl',
        method: 'environment.runPrepareStep',
        params: PARAMS
      })
      const reply = await responses.next('ctl')
      expect(reply).toMatchObject({ ok: true, result: { status: 'refused' } })
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(prepare).toHaveBeenCalledWith({
        repoSelector: 'id:r1',
        requirementId: 'shim',
        approvedContentHash: PARAMS.approvedContentHash,
        approvedHostKey: PARAMS.approvedHostKey,
        origin: 'runtime-rpc'
      })
    } finally {
      responses.dispose()
      session.ws.close()
      await server.stop()
    }
  })

  it('a revoked device is unauthorized and the handler is never called', async () => {
    const { server, session, responses, prepare, deviceId } = await openSession('runtime')
    try {
      // Why: correctness must not depend on the live-connection kill; keep the socket open so the
      // per-request device gate is what answers.
      vi.spyOn(server['mobileSocketWiring']!, 'terminateDeviceConnections').mockReturnValue(0)
      expect(server.revokeRuntimeAccess(deviceId)).toBe(true)
      expect(session.ws.readyState).toBe(session.ws.OPEN)
      sendEncryptedWsRequest(session, {
        id: 'revoked',
        method: 'environment.runPrepareStep',
        params: PARAMS
      })
      const reply = await responses.next('revoked')
      expect(reply).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      expect(prepare).not.toHaveBeenCalled()
    } finally {
      responses.dispose()
      session.ws.close()
      await server.stop()
    }
  })

  it('a mobile-scoped device is forbidden and the handler is never called', async () => {
    const { server, session, responses, prepare } = await openSession('mobile')
    try {
      sendEncryptedWsRequest(session, {
        id: 'mobile',
        method: 'environment.runPrepareStep',
        params: PARAMS
      })
      const reply = await responses.next('mobile')
      expect(reply).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(prepare).not.toHaveBeenCalled()
    } finally {
      responses.dispose()
      session.ws.close()
      await server.stop()
    }
  })
})
