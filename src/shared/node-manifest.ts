import type { FleetObservation } from './fleet-placement-view'
import type { FleetPlacementMember } from './fleet-placement'
import type { FleetNodeResourcesObservation } from './node-resources'

export const NODE_MANIFEST_SCHEMA = 'orca.node-manifest/1' as const

// Why: memory/VRAM move in seconds, a model swap takes minutes, disk drifts slowly (GEX44 sat at 99%).
export const DEFAULT_NODE_MAX_AGE_MS = {
  memory: 60_000,
  vram: 60_000,
  resident_model: 300_000,
  disk: 600_000
} as const

export type NodeMeasurement<V> =
  | { status: 'measured'; value: V; measured_at: number; max_age_ms: number; source: string }
  | { status: 'unknown'; reason: string; detail?: string }

export type NodeManifest = {
  schema: typeof NODE_MANIFEST_SCHEMA
  observed_at: number
  node: {
    address: string
    label: string
    fingerprint: string | null
    runtime_id: string | null
    platform: string | null
    /** `null` = the host did not say, which is not "has none". */
    capabilities: string[] | null
  }
  /** Absent means unknown; an empty list is never emitted. */
  known_heads?: string[]
  measurements: {
    memory: NodeMeasurement<{
      total_bytes: number
      available_bytes: number
      available_source: string
    }>
    disk: NodeMeasurement<{
      filesystems: { path: string; total_bytes: number; available_bytes: number }[]
    }>
    vram: NodeMeasurement<{ gpus: { name: string; total_bytes: number; free_bytes: number }[] }>
    resident_model: NodeMeasurement<{
      endpoints: { port: number; model_ids: string[] }[]
      unanswered_ports: number[]
    }>
  }
}

export type NodeManifestsResult =
  | { status: 'refused'; reason: 'remote-caller' }
  | { status: 'unavailable'; reason: 'no-fleet-reader' }
  | { status: 'ok'; observedAt: number; manifests: NodeManifest[] }

type Unknown = { status: 'unknown'; reason: string; detail?: string }

function unknown(reason: string, detail?: string): Unknown {
  return detail === undefined
    ? { status: 'unknown', reason }
    : { status: 'unknown', reason, detail }
}

function isBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function measured<V>(
  value: V,
  measuredAt: number,
  maxAgeMs: number,
  source: string
): NodeMeasurement<V> {
  return { status: 'measured', value, measured_at: measuredAt, max_age_ms: maxAgeMs, source }
}

function memoryOf(sample: FleetPlacementMember['sample']): NodeManifest['measurements']['memory'] {
  if (sample.outcome !== 'measured') {
    return unknown(sample.outcome, sample.detail)
  }
  const { totalMemory: total, availableMemory: available } = sample
  if (!isBytes(total) || !isBytes(available) || available > total || !isBytes(sample.startedAt)) {
    return unknown('malformed', 'host memory is not an integer byte count')
  }
  return measured(
    {
      total_bytes: total,
      available_bytes: available,
      available_source: sample.availableMemorySource
    },
    sample.startedAt,
    DEFAULT_NODE_MAX_AGE_MS.memory,
    sample.availableMemorySource
  )
}

function diskOf(resources: FleetNodeResourcesObservation): NodeManifest['measurements']['disk'] {
  const { disk, startedAt } = resources
  if (disk.outcome === 'unknown') {
    return unknown(disk.reason, disk.detail)
  }
  const valid =
    isBytes(startedAt) &&
    disk.filesystems.length > 0 &&
    disk.filesystems.every(
      (fs) =>
        isText(fs.path) &&
        isBytes(fs.totalBytes) &&
        isBytes(fs.availableBytes) &&
        fs.availableBytes <= fs.totalBytes
    )
  if (!valid) {
    return unknown('malformed', 'disk reading is not a byte count')
  }
  return measured(
    {
      filesystems: disk.filesystems.map((fs) => ({
        path: fs.path,
        total_bytes: fs.totalBytes,
        available_bytes: fs.availableBytes
      }))
    },
    startedAt,
    DEFAULT_NODE_MAX_AGE_MS.disk,
    'statfs'
  )
}

function vramOf(resources: FleetNodeResourcesObservation): NodeManifest['measurements']['vram'] {
  const { gpu, startedAt } = resources
  if (gpu.outcome === 'unknown') {
    return unknown(gpu.reason, gpu.detail)
  }
  const valid =
    isBytes(startedAt) &&
    gpu.gpus.length > 0 &&
    gpu.gpus.every(
      (entry) =>
        isText(entry.name) &&
        isBytes(entry.totalBytes) &&
        isBytes(entry.freeBytes) &&
        entry.freeBytes <= entry.totalBytes
    )
  if (!valid) {
    return unknown('malformed', 'gpu reading is not a byte count')
  }
  return measured(
    {
      gpus: gpu.gpus.map((entry) => ({
        name: entry.name,
        total_bytes: entry.totalBytes,
        free_bytes: entry.freeBytes
      }))
    },
    startedAt,
    DEFAULT_NODE_MAX_AGE_MS.vram,
    'nvidia-smi'
  )
}

function residentModelOf(
  resources: FleetNodeResourcesObservation
): NodeManifest['measurements']['resident_model'] {
  const { models, startedAt } = resources
  if (models.outcome === 'unknown') {
    return unknown(models.reason, models.detail)
  }
  if (models.endpoints.length === 0) {
    return unknown('endpoint-unreachable', 'no probed endpoint answered')
  }
  const valid =
    isBytes(startedAt) &&
    models.unansweredPorts.every(isPort) &&
    models.endpoints.every(
      (endpoint) =>
        isPort(endpoint.port) && endpoint.modelIds.length > 0 && endpoint.modelIds.every(isText)
    )
  if (!valid) {
    return unknown('malformed', 'model reading is not a port and model id list')
  }
  return measured(
    {
      endpoints: models.endpoints.map((endpoint) => ({
        port: endpoint.port,
        model_ids: [...endpoint.modelIds]
      })),
      unanswered_ports: [...models.unansweredPorts]
    },
    startedAt,
    DEFAULT_NODE_MAX_AGE_MS.resident_model,
    'v1-models'
  )
}

function manifestOf(member: FleetPlacementMember, observedAt: number): NodeManifest {
  const resources = member.nodeResources
  const notAttempted = unknown('not-attempted', 'node resources were not collected')
  return {
    schema: NODE_MANIFEST_SCHEMA,
    observed_at: observedAt,
    node: {
      address: member.address,
      label: member.label,
      fingerprint: member.identity.state === 'keyed' ? member.identity.fingerprint : null,
      runtime_id: member.facts.runtimeId,
      platform: member.facts.platform,
      capabilities: member.facts.capabilities ? [...member.facts.capabilities] : null
    },
    measurements: {
      memory: memoryOf(member.sample),
      disk: resources ? diskOf(resources) : notAttempted,
      vram: resources ? vramOf(resources) : notAttempted,
      resident_model: resources ? residentModelOf(resources) : notAttempted
    }
  }
}

// Why: every measured_at is the observer's clock reading; a node-supplied time never enters the manifest.
export function buildNodeManifests(observation: FleetObservation): NodeManifest[] {
  return observation.members.map((member) => manifestOf(member, observation.completedAt))
}
