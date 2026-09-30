import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import { planFleetPlacement } from '../../shared/fleet-placement'
import { RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { fingerprintHostPublicKey } from '../runtime/host-key-fingerprint'
import {
  FLEET_OBSERVATION_CONCURRENCY,
  observeFleet,
  type FleetEnvironmentCall,
  type FleetObservationDeps
} from './fleet-observation-service'
import { NODE_RESOURCES_SCHEMA } from './node-resources-measure'
import { NODE_RESOURCES_REPLY_SCHEMA } from '../../shared/node-resources-observation'

const GB = 1024 ** 3
const newKey = () => Buffer.from(nacl.box.keyPair().publicKey).toString('base64')
const localKey = newKey()

function environment(
  id: string,
  publicKeyB64: string,
  pairingRevision = 7
): KnownRuntimeEnvironment {
  return {
    id,
    name: `env ${id}`,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://x',
        deviceToken: 't',
        publicKeyB64
      }
    ],
    preferredEndpointId: `ws-${id}`
  }
}

const ok = (runtimeId: string, result: unknown): RuntimeRpcResponse<unknown> => ({
  id: 'r',
  ok: true,
  result,
  _meta: { runtimeId }
})
const statusOf = (runtimeId: string, protocol = RUNTIME_PROTOCOL_VERSION) => ({
  runtimeId,
  runtimeProtocolVersion: protocol,
  hostPlatform: 'linux',
  capabilities: ['cap.a']
})
const memoryOf = (available: number) => ({
  processSweep: 'measured',
  host: { totalMemory: 32 * GB, availableMemory: available, availableMemorySource: 'proc-meminfo' }
})

function deps(
  overrides: Partial<FleetObservationDeps> & { callEnvironment: FleetEnvironmentCall }
) {
  return {
    now: () => 10_000,
    readLocalPublicKey: () => localKey,
    getLocalStatus: () => ({
      runtimeId: 'rt-local',
      hostPlatform: 'win32',
      capabilities: ['cap.a']
    }),
    collectLocalSnapshot: async () => memoryOf(2 * GB),
    listEnvironments: () => [],
    stepDeadlineMs: 200,
    ...overrides
  } satisfies FleetObservationDeps
}

describe('fleet observation', () => {
  it('observes this host and a paired runtime, each under its own authenticated key', async () => {
    const vpsKey = newKey()
    const calls: { method: string; pairingRevision: number | undefined }[] = []
    const view = await observeFleet(
      deps({
        listEnvironments: () => [environment('vps', vpsKey, 42)],
        callEnvironment: async ({ method, pairingRevision }) => {
          calls.push({ method, pairingRevision })
          return method === 'status.get'
            ? ok('rt-vps', statusOf('rt-vps'))
            : ok('rt-vps', memoryOf(9 * GB))
        }
      })
    )
    expect(calls).toEqual([
      { method: 'status.get', pairingRevision: 42 },
      { method: 'diagnostics.memory', pairingRevision: 42 },
      { method: 'fleet.nodeResources', pairingRevision: 42 }
    ])
    expect(
      view.members.map((m) => [m.address, m.identity, m.sample.outcome, m.facts.protocol])
    ).toEqual([
      [
        LOCAL_EXECUTION_HOST_ID,
        { state: 'keyed', fingerprint: fingerprintHostPublicKey(localKey) },
        'measured',
        'not-applicable'
      ],
      [
        toRuntimeExecutionHostId('vps'),
        { state: 'keyed', fingerprint: fingerprintHostPublicKey(vpsKey) },
        'measured',
        'compatible'
      ]
    ])
    expect(view.coverage).toEqual({ runtimeEnvironments: 1, sshTargets: 'not-enumerated' })
  })

  it('reads a host that never answers as unreachable once its deadline passes', async () => {
    let aborted = false
    const started = Date.now()
    const view = await observeFleet(
      deps({
        listEnvironments: () => [environment('hung', newKey())],
        callEnvironment: ({ signal }) =>
          new Promise(() => {
            signal.addEventListener('abort', () => {
              aborted = true
            })
          })
      })
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(view.members[1].sample).toMatchObject({ outcome: 'unreachable' })
    expect(aborted).toBe(true)
  })

  it('does not ask a protocol-blocked host for its census', async () => {
    const methods: string[] = []
    const view = await observeFleet(
      deps({
        listEnvironments: () => [environment('old', newKey())],
        callEnvironment: async ({ method }) => {
          methods.push(method)
          return ok('rt-old', statusOf('rt-old', 0))
        }
      })
    )
    expect(methods).toEqual(['status.get'])
    expect(view.members[1].facts.protocol).toBe('blocked')
    expect(view.members[1].sample.outcome).toBe('not-attempted')
  })

  it('keeps an unreadable key unkeyed, and a missing local key absent', async () => {
    const view = await observeFleet(
      deps({
        readLocalPublicKey: () => undefined,
        listEnvironments: () => [environment('junk', 'not a key')],
        callEnvironment: async ({ method }) =>
          method === 'status.get' ? ok('rt', statusOf('rt')) : ok('rt', memoryOf(GB))
      })
    )
    expect(view.members.map((m) => m.identity)).toEqual([
      { state: 'unavailable', reason: 'no-key' },
      { state: 'unavailable', reason: 'key-unreadable' }
    ])
  })

  it('bounds concurrent hosts and returns them in address order', async () => {
    let inFlight = 0
    let peak = 0
    const ids = ['h9', 'h1', 'h5', 'h3', 'h7', 'h2', 'h8']
    const view = await observeFleet(
      deps({
        listEnvironments: () => ids.map((id) => environment(id, newKey())),
        callEnvironment: async ({ method, environmentId }) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return method === 'status.get'
            ? ok(`rt-${environmentId}`, statusOf(`rt-${environmentId}`))
            : ok(`rt-${environmentId}`, memoryOf(GB))
        }
      })
    )
    expect(peak).toBeLessThanOrEqual(FLEET_OBSERVATION_CONCURRENCY)
    expect(view.members.slice(1).map((m) => m.address)).toEqual(
      [...ids].sort().map((id) => toRuntimeExecutionHostId(id))
    )
  })

  it('judges this machine by its in-process reading when it is also paired as a runtime', async () => {
    const view = await observeFleet(
      deps({
        listEnvironments: () => [environment('self', localKey)],
        callEnvironment: async ({ method }) =>
          method === 'status.get'
            ? ok('rt-self', statusOf('rt-self'))
            : ok('rt-self', memoryOf(30 * GB))
      })
    )
    const plan = planFleetPlacement(view.members, { now: 10_000, maxSampleAgeMs: 60_000 })
    expect(plan.eligible).toHaveLength(1)
    expect(plan.selected).toMatchObject({
      addresses: [LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId('self')],
      evidenceAddress: LOCAL_EXECUTION_HOST_ID,
      availableMemory: 2 * GB
    })
  })
})

const resourcesReply = () => ({
  schema: NODE_RESOURCES_SCHEMA,
  disk: {
    outcome: 'measured',
    filesystems: [{ path: '/', totalBytes: 100 * GB, availableBytes: 40 * GB }]
  },
  gpu: { outcome: 'unknown', reason: 'no-gpu-tool' },
  models: { outcome: 'measured', endpoints: [{ port: 8081, modelIds: ['m'] }], unansweredPorts: [] }
})

type CallArgs = Parameters<FleetEnvironmentCall>[0]

const threeStepHost =
  (onResources: (args: CallArgs) => Promise<RuntimeRpcResponse<unknown>>) =>
  async (args: CallArgs) => {
    if (args.method === 'status.get') {
      return ok('rt-h', statusOf('rt-h'))
    }
    return args.method === 'diagnostics.memory' ? ok('rt-h', memoryOf(9 * GB)) : onResources(args)
  }

describe('fleet observation node resources', () => {
  it('pins the reply schema literal to the measurer', () => {
    expect(NODE_RESOURCES_REPLY_SCHEMA).toBe(NODE_RESOURCES_SCHEMA)
  })

  it('takes a third step and passes the probe ports as params, or none', async () => {
    const seen: { method: string; params: unknown; hasParams: boolean }[] = []
    const run = (options?: { modelProbePorts?: number[] }) =>
      observeFleet(
        deps({
          listEnvironments: () => [environment('h', newKey())],
          callEnvironment: threeStepHost(async (args) => {
            seen.push({ method: args.method, params: args.params, hasParams: 'params' in args })
            return ok('rt-h', resourcesReply())
          })
        }),
        options
      )
    const withPorts = await run({ modelProbePorts: [8081] })
    await run()
    expect(withPorts.members[1].nodeResources).toMatchObject({
      runtimeId: 'rt-h',
      disk: { outcome: 'measured' },
      gpu: { outcome: 'unknown', reason: 'no-gpu-tool' },
      models: { outcome: 'measured' }
    })
    expect(seen).toEqual([
      { method: 'fleet.nodeResources', params: { modelProbePorts: [8081] }, hasParams: true },
      { method: 'fleet.nodeResources', params: undefined, hasParams: false }
    ])
  })

  it('reads an old host as unsupported for the new families and leaves memory measured', async () => {
    const view = await observeFleet(
      deps({
        listEnvironments: () => [environment('h', newKey())],
        callEnvironment: threeStepHost(async () => ({
          id: 'r',
          ok: false,
          error: { code: 'method_not_found', message: 'no such method' },
          _meta: { runtimeId: 'rt-h' }
        }))
      })
    )
    const member = view.members[1]
    expect(member.sample.outcome).toBe('measured')
    for (const family of ['disk', 'gpu', 'models'] as const) {
      expect(member.nodeResources?.[family]).toMatchObject({
        outcome: 'unknown',
        reason: 'unsupported'
      })
    }
  })

  it('bounds a third step that never answers without touching the memory reading', async () => {
    const started = Date.now()
    const view = await observeFleet(
      deps({
        listEnvironments: () => [environment('h', newKey())],
        callEnvironment: threeStepHost(() => new Promise(() => {}))
      })
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(view.members[1].sample.outcome).toBe('measured')
    expect(view.members[1].nodeResources?.disk).toMatchObject({
      outcome: 'unknown',
      reason: 'unreachable'
    })
  })

  it('stamps the families with the observer clock, not the real one, for remote and local', async () => {
    const FAKE = 5_000_000
    const view = await observeFleet(
      deps({
        now: () => FAKE,
        listEnvironments: () => [environment('h', newKey())],
        collectLocalNodeResources: async () => resourcesReply(),
        callEnvironment: threeStepHost(async () => ok('rt-h', resourcesReply()))
      })
    )
    expect(Math.abs(Date.now() - FAKE)).toBeGreaterThan(1_000_000)
    expect(view.members[0].nodeResources?.startedAt).toBe(FAKE)
    expect(view.members[1].nodeResources?.startedAt).toBe(FAKE)
  })

  it('takes the local families from the collector and degrades a throw or an absent collector', async () => {
    const collect = async (impl?: () => Promise<unknown>) =>
      (
        await observeFleet(
          deps({
            ...(impl ? { collectLocalNodeResources: impl } : {}),
            callEnvironment: async () => ok('rt', {})
          })
        )
      ).members[0].nodeResources
    expect((await collect(async () => resourcesReply()))?.disk).toMatchObject({
      outcome: 'measured'
    })
    expect((await collect(async () => Promise.reject(new Error('boom'))))?.disk).toMatchObject({
      outcome: 'unknown',
      reason: 'unreachable'
    })
    expect((await collect())?.disk).toMatchObject({
      outcome: 'unknown',
      reason: 'not-attempted'
    })
  })

  it('does not take the third step for a protocol-blocked host', async () => {
    const methods: string[] = []
    const view = await observeFleet(
      deps({
        listEnvironments: () => [environment('old', newKey())],
        callEnvironment: async ({ method }) => {
          methods.push(method)
          return ok('rt-old', statusOf('rt-old', 0))
        }
      })
    )
    expect(methods).toEqual(['status.get'])
    expect(view.members[1].nodeResources?.gpu).toMatchObject({ reason: 'not-attempted' })
  })
})
