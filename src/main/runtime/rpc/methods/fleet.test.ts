import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { NodeManifestsResult } from '../../../../shared/node-manifest'
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

  // Why: fleet-placement.ts says a proposal authorizes nothing. This makes that a check: the view
  // never reaches the runtime service that could act, and what it returns carries no capability.
  // The remote side is already pinned to status.get + diagnostics.memory in the observer's tests.
  it('never touches the runtime it could act through, and returns inert data', async () => {
    const touched: PropertyKey[] = []
    const trap = new Proxy({} as RpcContext['runtime'], {
      get: (_target, key) => {
        touched.push(key)
        throw new Error(`placement view reached runtime.${String(key)}`)
      }
    })
    // Positive control: an access is recorded, so a zero below is a measurement, not a blind spot.
    expect(() => (trap as unknown as Record<string, unknown>).probe).toThrow()
    expect(touched).toEqual(['probe'])
    touched.length = 0
    installLocalOnly()

    const result = await call({ minAvailableBytes: 1 * GB }, { runtime: trap })

    expect(result.status).toBe('ok')
    expect(touched).toEqual([])
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})

describe('fleet.nodeManifests', () => {
  const manifestMethod = FLEET_METHODS.find((entry) => entry.name === 'fleet.nodeManifests')!
  const callManifests = (params: unknown, ctx: Partial<RpcContext> = {}) =>
    manifestMethod.handler(params, {
      runtime: {} as RpcContext['runtime'],
      ...ctx
    }) as Promise<NodeManifestsResult>
  const schema = JSON.parse(
    readFileSync(
      join(process.cwd(), 'config', 'schemas', 'orca-node-manifest-1.schema.json'),
      'utf8'
    )
  ) as never

  it('answers a local caller with schema-valid manifests, one per observed member', async () => {
    installLocalOnly()
    const result = await callManifests(undefined)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') {
      return
    }
    expect(result.observedAt).toBe(50_000)
    expect(result.manifests).toHaveLength(1)
    const validator = z.fromJSONSchema(schema)
    for (const manifest of result.manifests) {
      expect(validator.safeParse(JSON.parse(JSON.stringify(manifest))).success).toBe(true)
    }
    expect(result.manifests[0].measurements.memory).toMatchObject({
      status: 'measured',
      source: 'free-memory'
    })
  })

  it('refuses every remote caller without calling the observation reader', async () => {
    installLocalOnly()
    const remote: Partial<RpcContext>[] = [
      { clientKind: 'mobile' },
      { pairedDeviceId: 'dev-1' },
      { connectionId: 'socket-1' }
    ]
    for (const ctx of remote) {
      await expect(callManifests(undefined, ctx)).resolves.toEqual({
        status: 'refused',
        reason: 'remote-caller'
      })
    }
    expect(reads).toBe(0)
  })

  it('says when no reader is installed', async () => {
    await expect(callManifests(undefined)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-fleet-reader'
    })
  })

  it('has strict params and never touches the runtime it could act through', async () => {
    const params = manifestMethod.params!
    expect(params.safeParse(undefined).success).toBe(true)
    expect(params.safeParse({}).success).toBe(true)
    expect(params.safeParse({ unknownKey: 1 }).success).toBe(false)
    const touched: PropertyKey[] = []
    const trap = new Proxy({} as RpcContext['runtime'], {
      get: (_target, key) => {
        touched.push(key)
        throw new Error(`node manifests reached runtime.${String(key)}`)
      }
    })
    installLocalOnly()
    const result = await callManifests(undefined, { runtime: trap })
    expect(result.status).toBe('ok')
    expect(touched).toEqual([])
  })
})
