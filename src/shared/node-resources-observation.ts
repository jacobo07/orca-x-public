import type { FleetRpcStep } from './fleet-resource-observation'
import type {
  DiskReading,
  FleetNodeResourcesObservation,
  GpuReading,
  ModelReading,
  NodeResourceUnknownReason
} from './node-resources'

// Why a copy: this pure module cannot import the main-process measurer; the service test pins equality.
export const NODE_RESOURCES_REPLY_SCHEMA = 'orca.node-resources/1'

const UNKNOWN_REASONS: ReadonlySet<string> = new Set<NodeResourceUnknownReason>([
  'no-gpu-tool',
  'tool-failed',
  'timeout',
  'malformed',
  'no-probe-configured',
  'endpoint-unreachable',
  'unsupported',
  'unreachable',
  'rejected',
  'incarnation-changed',
  'not-attempted',
  'measurer-not-installed'
])

type Unknown = { outcome: 'unknown'; reason: NodeResourceUnknownReason; detail?: string }

const unknownOf = (reason: NodeResourceUnknownReason, detail?: string): Unknown =>
  detail === undefined ? { outcome: 'unknown', reason } : { outcome: 'unknown', reason, detail }

const allUnknown = (reason: NodeResourceUnknownReason, detail?: string) => ({
  disk: unknownOf(reason, detail),
  gpu: unknownOf(reason, detail),
  models: unknownOf(reason, detail)
})

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const isByteCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

const malformed = (what: string): Unknown => unknownOf('malformed', what)

function unknownArm(record: Record<string, unknown>): Unknown | null {
  if (record.outcome !== 'unknown') {
    return null
  }
  return typeof record.reason === 'string' && UNKNOWN_REASONS.has(record.reason)
    ? unknownOf(
        record.reason as NodeResourceUnknownReason,
        typeof record.detail === 'string' ? record.detail : undefined
      )
    : malformed('unknown reading with an unrecognised reason')
}

function nonEmptyList(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null
}

function parseDisk(value: unknown): DiskReading {
  const record = asRecord(value)
  if (!record) {
    return malformed('disk is not an object')
  }
  const arm = unknownArm(record)
  if (arm) {
    return arm
  }
  const list = record.outcome === 'measured' ? nonEmptyList(record.filesystems) : null
  if (!list) {
    return malformed('disk has no filesystems')
  }
  const filesystems: { path: string; totalBytes: number; availableBytes: number }[] = []
  for (const entry of list) {
    const fs = asRecord(entry)
    if (
      !fs ||
      !isText(fs.path) ||
      !isByteCount(fs.totalBytes) ||
      !isByteCount(fs.availableBytes) ||
      fs.availableBytes > fs.totalBytes
    ) {
      return malformed('a filesystem entry is not a valid byte reading')
    }
    filesystems.push({
      path: fs.path,
      totalBytes: fs.totalBytes,
      availableBytes: fs.availableBytes
    })
  }
  return { outcome: 'measured', filesystems }
}

function parseGpu(value: unknown): GpuReading {
  const record = asRecord(value)
  if (!record) {
    return malformed('gpu is not an object')
  }
  const arm = unknownArm(record)
  if (arm) {
    return arm
  }
  const list = record.outcome === 'measured' ? nonEmptyList(record.gpus) : null
  if (!list) {
    return malformed('gpu has no devices')
  }
  const gpus: { name: string; totalBytes: number; freeBytes: number }[] = []
  for (const entry of list) {
    const gpu = asRecord(entry)
    if (
      !gpu ||
      !isText(gpu.name) ||
      !isByteCount(gpu.totalBytes) ||
      !isByteCount(gpu.freeBytes) ||
      gpu.freeBytes > gpu.totalBytes
    ) {
      return malformed('a gpu entry is not a valid byte reading')
    }
    gpus.push({ name: gpu.name, totalBytes: gpu.totalBytes, freeBytes: gpu.freeBytes })
  }
  return { outcome: 'measured', gpus }
}

function parseModels(value: unknown): ModelReading {
  const record = asRecord(value)
  if (!record) {
    return malformed('models is not an object')
  }
  const arm = unknownArm(record)
  if (arm) {
    return arm
  }
  if (record.outcome !== 'measured' || !Array.isArray(record.endpoints)) {
    return malformed('models has no endpoints list')
  }
  const isPort = (port: unknown): port is number =>
    typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
  const endpoints: { port: number; modelIds: string[] }[] = []
  for (const entry of record.endpoints) {
    const endpoint = asRecord(entry)
    if (
      !endpoint ||
      !isPort(endpoint.port) ||
      !Array.isArray(endpoint.modelIds) ||
      !endpoint.modelIds.every(isText)
    ) {
      return malformed('a models endpoint is not a valid reading')
    }
    endpoints.push({ port: endpoint.port, modelIds: [...(endpoint.modelIds as string[])] })
  }
  const unanswered = record.unansweredPorts
  if (!Array.isArray(unanswered) || !unanswered.every(isPort)) {
    return malformed('unansweredPorts is not a port list')
  }
  return { outcome: 'measured', endpoints, unansweredPorts: [...(unanswered as number[])] }
}

/** Validates each family alone, so one bad family never blinds the others. */
export function parseNodeResourcesReply(
  value: unknown
): Pick<FleetNodeResourcesObservation, 'disk' | 'gpu' | 'models'> {
  const record = asRecord(value)
  if (!record || record.schema !== NODE_RESOURCES_REPLY_SCHEMA) {
    return allUnknown('malformed', 'reply is not an orca.node-resources/1 object')
  }
  return {
    disk: parseDisk(record.disk),
    gpu: parseGpu(record.gpu),
    models: parseModels(record.models)
  }
}

export function notAttemptedNodeResources(
  startedAt: number,
  runtimeId: string | null,
  detail: string
): FleetNodeResourcesObservation {
  return { startedAt, runtimeId, ...allUnknown('not-attempted', detail) }
}

/** The observer's own clock stamps the reading; nothing the node reports about time is read. */
export function classifyNodeResourcesStep(input: {
  startedAt: number
  statusRuntimeId: string
  step: FleetRpcStep
}): FleetNodeResourcesObservation {
  const { startedAt, statusRuntimeId, step } = input
  if (step.kind === 'threw') {
    return { startedAt, runtimeId: statusRuntimeId, ...allUnknown('unreachable', step.message) }
  }
  if (step.kind === 'error') {
    return {
      startedAt,
      runtimeId: statusRuntimeId,
      ...allUnknown(
        step.code === 'method_not_found' ? 'unsupported' : 'rejected',
        `${step.code}: ${step.message}`
      )
    }
  }
  if (step.runtimeId !== statusRuntimeId) {
    return {
      startedAt,
      runtimeId: step.runtimeId,
      ...allUnknown(
        'incarnation-changed',
        `status from ${statusRuntimeId}, resources from ${step.runtimeId}`
      )
    }
  }
  return { startedAt, runtimeId: step.runtimeId, ...parseNodeResourcesReply(step.value) }
}
