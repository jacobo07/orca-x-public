import { runtimeCompatibility } from './execution-host-registry'
import type { HostAvailableMemorySource } from './process-stats-types'

/** One RPC reply as the fleet reader saw it; `runtimeId` comes from the reply's own meta. */
export type FleetRpcStep =
  | { kind: 'ok'; runtimeId: string; value: unknown }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'threw'; message: string }

export type FleetProtocolState = 'compatible' | 'blocked' | 'unknown' | 'not-applicable'

export type FleetHostFacts = {
  runtimeId: string | null
  platform: NodeJS.Platform | null
  /** `null` = the host did not say, which is not "has none". */
  capabilities: readonly string[] | null
  protocol: FleetProtocolState
}

export type FleetProcessSweep = 'measured' | 'failed' | 'unknown'

export type FleetUnmeasuredOutcome =
  | 'unreachable'
  | 'rejected'
  | 'unsupported'
  | 'incarnation-changed'
  | 'malformed'
  | 'not-attempted'

// Why: only `measured` carries numbers, so an unmeasured host can never read as a host with 0 bytes.
export type FleetResourceSample =
  | {
      outcome: 'measured'
      runtimeId: string | null
      startedAt: number
      totalMemory: number
      availableMemory: number
      availableMemorySource: HostAvailableMemorySource | 'unknown'
      /** Orca's own attribution; host memory is OS-derived and valid either way. */
      processSweep: FleetProcessSweep
    }
  | { outcome: FleetUnmeasuredOutcome; runtimeId: string | null; startedAt: number; detail: string }

const PLATFORMS: ReadonlySet<string> = new Set([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32'
])
const MEMORY_SOURCES: ReadonlySet<string> = new Set([
  'memory-pressure',
  'proc-meminfo',
  'free-memory'
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function fleetHostFactsFromStatus(
  status: unknown,
  runtimeId: string | null
): FleetHostFacts {
  const record = asRecord(status) ?? {}
  const platform = typeof record.hostPlatform === 'string' ? record.hostPlatform : null
  const capabilities =
    Array.isArray(record.capabilities) &&
    record.capabilities.every((entry) => typeof entry === 'string')
      ? [...(record.capabilities as string[])].sort()
      : null
  const verdict = runtimeCompatibility({
    runtimeProtocolVersion: record.runtimeProtocolVersion as number | undefined,
    protocolVersion: record.protocolVersion as number | undefined,
    minCompatibleRuntimeClientVersion: record.minCompatibleRuntimeClientVersion as
      | number
      | undefined,
    minCompatibleMobileVersion: record.minCompatibleMobileVersion as number | undefined
  })
  return {
    runtimeId,
    platform: platform && PLATFORMS.has(platform) ? (platform as NodeJS.Platform) : null,
    capabilities,
    protocol: !verdict ? 'unknown' : verdict.kind === 'blocked' ? 'blocked' : 'compatible'
  }
}

export function fleetSampleFromSnapshot(
  snapshot: unknown,
  runtimeId: string | null,
  startedAt: number
): FleetResourceSample {
  const host = asRecord(asRecord(snapshot)?.host)
  const total = host?.totalMemory
  const available = host?.availableMemory
  if (!isByteCount(total) || !isByteCount(available) || available > total) {
    return { outcome: 'malformed', runtimeId, startedAt, detail: 'host memory is not a byte count' }
  }
  const source = host?.availableMemorySource
  const sweep = asRecord(snapshot)?.processSweep
  return {
    outcome: 'measured',
    runtimeId,
    startedAt,
    totalMemory: total,
    availableMemory: available,
    availableMemorySource:
      typeof source === 'string' && MEMORY_SOURCES.has(source)
        ? (source as HostAvailableMemorySource)
        : 'unknown',
    processSweep: sweep === 'measured' || sweep === 'failed' ? sweep : 'unknown'
  }
}

function unmeasured(
  outcome: FleetUnmeasuredOutcome,
  runtimeId: string | null,
  startedAt: number,
  detail: string
): FleetResourceSample {
  return { outcome, runtimeId, startedAt, detail }
}

function failedStep(
  step: Exclude<FleetRpcStep, { kind: 'ok' }>,
  runtimeId: string | null,
  startedAt: number
): FleetResourceSample {
  if (step.kind === 'threw') {
    return unmeasured('unreachable', runtimeId, startedAt, step.message)
  }
  return unmeasured(
    step.code === 'method_not_found' ? 'unsupported' : 'rejected',
    runtimeId,
    startedAt,
    `${step.code}: ${step.message}`
  )
}

/**
 * Status then census from one remote host. Both replies name the incarnation that produced
 * them; a census from another incarnation than the status is not attributable to those facts.
 */
export function classifyRemoteFleetObservation(input: {
  startedAt: number
  status: FleetRpcStep
  memory: FleetRpcStep | null
}): { sample: FleetResourceSample; facts: FleetHostFacts } {
  const { startedAt, status, memory } = input
  if (status.kind !== 'ok') {
    return {
      sample: failedStep(status, null, startedAt),
      facts: { runtimeId: null, platform: null, capabilities: null, protocol: 'unknown' }
    }
  }
  const facts = fleetHostFactsFromStatus(status.value, status.runtimeId)
  if (!memory) {
    return {
      sample: unmeasured('not-attempted', status.runtimeId, startedAt, 'census not requested'),
      facts
    }
  }
  if (memory.kind !== 'ok') {
    return { sample: failedStep(memory, status.runtimeId, startedAt), facts }
  }
  if (memory.runtimeId !== status.runtimeId) {
    return {
      sample: unmeasured(
        'incarnation-changed',
        memory.runtimeId,
        startedAt,
        `status from ${status.runtimeId}, census from ${memory.runtimeId}`
      ),
      facts
    }
  }
  return { sample: fleetSampleFromSnapshot(memory.value, memory.runtimeId, startedAt), facts }
}

/** Age from the observation's start, the conservative end; clock skew never reads as fresher. */
export function fleetSampleAgeMs(
  sample: Pick<FleetResourceSample, 'startedAt'>,
  now: number
): number {
  return Math.max(0, now - sample.startedAt)
}
