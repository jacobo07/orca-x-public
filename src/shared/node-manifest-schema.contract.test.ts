import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { FleetObservation } from './fleet-placement-view'
import type { FleetPlacementMember } from './fleet-placement'
import { buildNodeManifests, DEFAULT_NODE_MAX_AGE_MS, type NodeManifest } from './node-manifest'
import type { FleetNodeResourcesObservation } from './node-resources'
import { RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import type { KnownRuntimeEnvironment } from './runtime-environments'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

type JsonObject = Record<string, unknown>

const GB = 1024 ** 3
const NOW = 10_000
const SCHEMA_PATH = join(process.cwd(), 'config', 'schemas', 'orca-node-manifest-1.schema.json')
const schemaDoc = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as JsonObject
const defs = schemaDoc.$defs as Record<string, JsonObject>

// Why: z.fromJSONSchema enforced every keyword the schema uses (05 Wave-0 SPIKE-ZOD), so no second validator is kept.
const validates = (schema: JsonObject, value: unknown): boolean =>
  z.fromJSONSchema(schema as never).safeParse(value).success
const accepts = (value: unknown): boolean => validates(schemaDoc, value)

const newKey = () => Buffer.from(nacl.box.keyPair().publicKey).toString('base64')
const localKey = newKey()

function environment(id: string, publicKeyB64: string): KnownRuntimeEnvironment {
  return {
    id,
    name: `env ${id}`,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 7,
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
const failed = (code: string): RuntimeRpcResponse<unknown> => ({
  id: 'r',
  ok: false,
  error: { code, message: code },
  _meta: { runtimeId: 'rt-x' }
})
const statusOf = (runtimeId: string) => ({
  runtimeId,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  hostPlatform: 'linux',
  capabilities: ['cap.a']
})
const memoryOf = (available: number) => ({
  processSweep: 'measured',
  host: { totalMemory: 32 * GB, availableMemory: available, availableMemorySource: 'proc-meminfo' }
})

type FleetEnvironmentCall = (call: {
  environmentId: string
  method: 'status.get' | 'diagnostics.memory'
  pairingRevision: number | undefined
  signal: AbortSignal
}) => Promise<RuntimeRpcResponse<unknown>>

// Why: a static src/main import from src/shared is rejected by the web and cli typecheck projects (TS6307);
// the specifier stays a variable so those projects never pull main in, while vitest still runs the real producer.
const FLEET_SERVICE = '../main/fleet/fleet-observation-service'
const FINGERPRINT_MODULE = '../main/runtime/host-key-fingerprint'

async function observe(
  callEnvironment: FleetEnvironmentCall,
  environments: KnownRuntimeEnvironment[] = [environment('vps', newKey())]
): Promise<FleetObservation> {
  const { observeFleet } = (await import(/* @vite-ignore */ FLEET_SERVICE)) as {
    observeFleet: (deps: object) => Promise<FleetObservation>
  }
  return observeFleet({
    now: () => NOW,
    readLocalPublicKey: () => localKey,
    getLocalStatus: () => ({
      runtimeId: 'rt-local',
      hostPlatform: 'win32',
      capabilities: ['cap.a']
    }),
    collectLocalSnapshot: async () => memoryOf(2 * GB),
    listEnvironments: () => environments,
    stepDeadlineMs: 200,
    callEnvironment
  })
}

const healthyRemote: FleetEnvironmentCall = async ({ method }) =>
  method === 'status.get' ? ok('rt-vps', statusOf('rt-vps')) : ok('rt-vps', memoryOf(9 * GB))

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function numbersIn(value: unknown): unknown[] {
  if (typeof value === 'number') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(numbersIn)
  }
  return value && typeof value === 'object' ? Object.values(value).flatMap(numbersIn) : []
}

const fullResources: FleetNodeResourcesObservation = {
  startedAt: NOW,
  runtimeId: 'rt-vps',
  disk: {
    outcome: 'measured',
    filesystems: [{ path: '/', totalBytes: 1870722568192, availableBytes: 34543001600 }]
  },
  gpu: {
    outcome: 'measured',
    gpus: [{ name: 'RTX 4000 SFF Ada', totalBytes: 20475 * 1024 ** 2, freeBytes: 3054 * 1024 ** 2 }]
  },
  models: {
    outcome: 'measured',
    endpoints: [{ port: 8081, modelIds: ['qwen3-coder-30b'] }],
    unansweredPorts: []
  }
}

async function manifestsWithResources(
  resources: FleetNodeResourcesObservation
): Promise<NodeManifest[]> {
  const observation = await observe(healthyRemote)
  const members: FleetPlacementMember[] = observation.members.map((member, index) =>
    index === 1 ? { ...member, nodeResources: resources } : member
  )
  return buildNodeManifests({ ...observation, members })
}

describe('node manifest schema contract', () => {
  it('validates the manifests the real observeFleet emits, one per member', async () => {
    const manifests = buildNodeManifests(await observe(healthyRemote))
    expect(manifests).toHaveLength(2)
    for (const manifest of manifests) {
      expect(accepts(manifest)).toBe(true)
    }
    const { fingerprintHostPublicKey } = (await import(/* @vite-ignore */ FINGERPRINT_MODULE)) as {
      fingerprintHostPublicKey: (key: string) => string
    }
    expect(manifests[0].node.fingerprint).toBe(fingerprintHostPublicKey(localKey))
  })

  it('stamps memory with the observer clock and leaves unmeasured families unknown without numbers', async () => {
    const observation = await observe(healthyRemote)
    const [local, remote] = buildNodeManifests(observation)
    for (const [manifest, member] of [
      [local, observation.members[0]],
      [remote, observation.members[1]]
    ] as const) {
      const memory = manifest.measurements.memory
      expect(memory).toMatchObject({
        status: 'measured',
        measured_at: member.sample.startedAt,
        max_age_ms: 60_000,
        source: 'proc-meminfo'
      })
      expect(member.sample.startedAt).toBe(NOW)
      for (const family of ['disk', 'vram', 'resident_model'] as const) {
        expect(manifest.measurements[family]).toMatchObject({
          status: 'unknown',
          reason: 'not-attempted'
        })
        expect(numbersIn(manifest.measurements[family])).toEqual([])
      }
    }
  })

  it.each([
    ['method_not_found', 'unsupported'],
    ['runtime_unavailable', 'rejected']
  ])('maps a %s reply on status.get to memory unknown %s', async (code, reason) => {
    const [, remote] = buildNodeManifests(await observe(async () => failed(code)))
    expect(remote.measurements.memory).toMatchObject({ status: 'unknown', reason })
    expect(numbersIn(remote.measurements.memory)).toEqual([])
    expect(accepts(remote)).toBe(true)
  })

  it('maps a host that throws to memory unknown unreachable', async () => {
    const [, remote] = buildNodeManifests(
      await observe(async () => {
        throw new Error('boom')
      })
    )
    expect(remote.measurements.memory).toMatchObject({ status: 'unknown', reason: 'unreachable' })
    expect(numbersIn(remote.measurements.memory)).toEqual([])
  })

  describe('refusals', () => {
    async function validManifest(): Promise<JsonObject> {
      return clone(buildNodeManifests(await observe(healthyRemote))[1] as unknown as JsonObject)
    }
    const memoryOfManifest = (manifest: JsonObject) =>
      (manifest.measurements as JsonObject).memory as JsonObject

    const invalidations: [string, (manifest: JsonObject) => void][] = [
      ['missing measured_at', (m) => delete memoryOfManifest(m).measured_at],
      ['max_age_ms 0', (m) => (memoryOfManifest(m).max_age_ms = 0)],
      ['max_age_ms negative', (m) => (memoryOfManifest(m).max_age_ms = -1)],
      ['known_heads empty list', (m) => (m.known_heads = [])],
      ['wrong version const', (m) => (m.schema = 'orca.node-manifest/2')],
      ['extra top-level property', (m) => (m.surprise = true)]
    ]

    it('accepts the untouched manifest (positive control)', async () => {
      expect(accepts(await validManifest())).toBe(true)
    })

    it.each(invalidations)('refuses: %s', async (_name, invalidate) => {
      const manifest = await validManifest()
      invalidate(manifest)
      expect(accepts(manifest)).toBe(false)
    })

    it('a validator over a stripped {} schema accepts every invalid manifest (not vacuous)', async () => {
      for (const [, invalidate] of invalidations) {
        const manifest = await validManifest()
        invalidate(manifest)
        expect(validates({}, manifest)).toBe(true)
      }
    })
  })

  it('treats known_heads as optional: absent validates, never emitted, present validates', async () => {
    const manifests = buildNodeManifests(await observe(healthyRemote))
    for (const manifest of manifests) {
      expect('known_heads' in manifest).toBe(false)
      expect(accepts(manifest)).toBe(true)
    }
    expect(accepts({ ...manifests[0], known_heads: ['abc123'] })).toBe(true)
  })

  it('emits exactly the property names the schema declares', async () => {
    const [manifest] = await manifestsWithResources(fullResources)
    const remote = (await manifestsWithResources(fullResources))[1]
    const keys = (value: object) => Object.keys(value).sort()
    const props = (doc: JsonObject) => keys(doc.properties as object)
    expect(keys(remote)).toEqual(props(schemaDoc).filter((key) => key !== 'known_heads'))
    expect(keys(remote.node)).toEqual(
      props((schemaDoc.properties as JsonObject).node as JsonObject)
    )
    expect(keys(remote.measurements)).toEqual(
      props((schemaDoc.properties as JsonObject).measurements as JsonObject)
    )
    const arms = {
      memory: 'memory_measured',
      disk: 'disk_measured',
      vram: 'vram_measured',
      resident_model: 'model_measured'
    } as const
    for (const [family, def] of Object.entries(arms)) {
      const measurement = remote.measurements[family as keyof typeof arms]
      expect(measurement.status).toBe('measured')
      expect(keys(measurement)).toEqual(props(defs[def]))
      expect(keys((measurement as { value: object }).value)).toEqual(
        props((defs[def].properties as JsonObject).value as JsonObject)
      )
    }
    const unknownProps = props(defs.unknown_measurement)
    for (const key of keys(manifest.measurements.disk)) {
      expect(unknownProps).toContain(key)
    }
  })

  it('maps measured disk, vram and model readings with the CTX-FRS-5 max ages and validates', async () => {
    const remote = (await manifestsWithResources(fullResources))[1]
    expect(remote.measurements.disk).toMatchObject({
      status: 'measured',
      measured_at: NOW,
      max_age_ms: DEFAULT_NODE_MAX_AGE_MS.disk
    })
    expect(remote.measurements.vram).toMatchObject({ max_age_ms: 60_000, source: 'nvidia-smi' })
    expect(remote.measurements.resident_model).toMatchObject({ max_age_ms: 300_000 })
    expect(DEFAULT_NODE_MAX_AGE_MS.disk).toBe(600_000)
    expect(accepts(remote)).toBe(true)
  })

  it('maps a gpu reading whose free exceeds total to unknown malformed, never a number', async () => {
    const remote = (
      await manifestsWithResources({
        ...fullResources,
        gpu: {
          outcome: 'measured',
          gpus: [{ name: 'g', totalBytes: 10, freeBytes: 11 }]
        }
      })
    )[1]
    expect(remote.measurements.vram).toMatchObject({ status: 'unknown', reason: 'malformed' })
    expect(numbersIn(remote.measurements.vram)).toEqual([])
    expect(accepts(remote)).toBe(true)
  })

  it('carries an unknown reading reason through without numbers', async () => {
    const remote = (
      await manifestsWithResources({
        ...fullResources,
        gpu: { outcome: 'unknown', reason: 'no-gpu-tool', detail: 'nvidia-smi not found' }
      })
    )[1]
    expect(remote.measurements.vram).toEqual({
      status: 'unknown',
      reason: 'no-gpu-tool',
      detail: 'nvidia-smi not found'
    })
  })
})
