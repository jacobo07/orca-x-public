import { afterEach, describe, expect, it } from 'vitest'
import { installFleetObservation } from '../../../fleet/fleet-observation-slot'
import type { RpcContext } from '../core'
import { FLEET_METHODS, type FleetPlacementViewResult } from './fleet'

const GB = 1024 ** 3
const method = FLEET_METHODS.find((entry) => entry.name === 'fleet.placementView')!
const call = (params: unknown, ctx: Partial<RpcContext> = {}) =>
  method.handler(params, {
    runtime: {} as RpcContext['runtime'],
    ...ctx
  }) as Promise<FleetPlacementViewResult>

let reads = 0
function installLocalOnly(): void {
  installFleetObservation({
    now: () => 50_000,
    readLocalPublicKey: () => Buffer.alloc(32, 3).toString('base64'),
    getLocalStatus: () => ({ runtimeId: 'rt-local' }),
    collectLocalSnapshot: async () => {
      reads += 1
      return {
        processSweep: 'measured',
        host: {
          totalMemory: 16 * GB,
          availableMemory: 4 * GB,
          availableMemorySource: 'free-memory'
        }
      }
    },
    listEnvironments: () => [],
    callEnvironment: () => Promise.reject(new Error('no remote in this test'))
  })
}

afterEach(() => {
  installFleetObservation(null)
  reads = 0
})

describe('fleet.placementView', () => {
  it('refuses every remote caller before reading anything', async () => {
    installLocalOnly()
    const remote: Partial<RpcContext>[] = [
      { clientKind: 'mobile' },
      { clientKind: 'runtime' },
      { pairedDeviceId: 'dev-1' },
      { clientId: 'token' },
      { connectionId: 'socket-1' },
      { authenticatedCallerFingerprint: 'fp' }
    ]
    for (const ctx of remote) {
      await expect(call(undefined, ctx)).resolves.toEqual({
        status: 'refused',
        reason: 'remote-caller'
      })
    }
    expect(reads).toBe(0)
  })

  it('says when no reader is installed rather than answering with an empty fleet', async () => {
    await expect(call(undefined)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-fleet-reader'
    })
  })

  it('answers a local caller with the observation and a proposal made from it', async () => {
    installLocalOnly()
    const result = await call({ minAvailableBytes: 1 * GB })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') {
      return
    }
    expect(reads).toBe(1)
    expect(result.request).toMatchObject({ minAvailableBytes: 1 * GB, maxSampleAgeMs: 60_000 })
    expect(result.proposal.selected).toMatchObject({
      availableMemory: 4 * GB,
      evidenceAddress: 'local'
    })
    expect(result.observation.coverage.sshTargets).toBe('not-enumerated')
  })
})
