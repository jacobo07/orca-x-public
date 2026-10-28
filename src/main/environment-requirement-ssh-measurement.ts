import { SSH_MUX_REQUEST_TIMEOUT_CODE } from './ssh/ssh-channel-multiplexer'
import {
  REQUIREMENT_ID_PATTERN,
  toProbeRequests
} from '../shared/environment-requirement-probe-request'
import { splitByRequestCap } from '../shared/environment-requirement-probe-core'
import type {
  EnvironmentRequirement,
  HostMeasurement,
  MeasuredPlatform,
  RequirementProbeOutcome,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

export const ENVIRONMENT_REQUIREMENTS_CAPABILITY = 'environment.requirements.v1'
const STATUS_TIMEOUT_MS = 15_000
const MEASURE_TIMEOUT_MS = 60_000
const METHOD_NOT_FOUND = -32601
const PROBE_OUTCOMES: readonly string[] = [
  'found',
  'absent',
  'skipped-platform',
  'refused',
  'failed'
]

type MuxLike = {
  isDisposed(): boolean
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown>
}

export type SshMeasurementDeps = {
  getMultiplexer: (connectionId: string) => Promise<MuxLike | undefined> | MuxLike | undefined
  now: () => number
}

type NotMeasured = Exclude<HostMeasurement, { status: 'measured' }>

// Every wire failure keeps its own name; none of them is ever a measured result with no probes.
export function mapSshMeasurementFailure(
  error: unknown,
  base: { at: number; hostKey: string }
): NotMeasured {
  const code = (error as { code?: unknown } | null)?.code
  if (code === METHOD_NOT_FOUND) {
    return { ...base, status: 'host-predates-probes', detail: 'method-not-found' }
  }
  if (code === SSH_MUX_REQUEST_TIMEOUT_CODE) {
    return { ...base, status: 'timed-out', detail: 'request-timeout' }
  }
  if (code === 'CONNECTION_LOST' || code === 'DISPOSED') {
    return { ...base, status: 'unreachable', detail: String(code).toLowerCase() }
  }
  return {
    ...base,
    status: 'refused',
    detail: typeof code === 'number' ? `relay-error:${code}` : 'request-failed'
  }
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

// Accepts only the declared fields; anything else is dropped here and never forwarded.
function readProbe(value: unknown, requested: ReadonlySet<string>): RequirementProbeResult | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const entry = value as Record<string, unknown>
  if (
    typeof entry.id !== 'string' ||
    !REQUIREMENT_ID_PATTERN.test(entry.id) ||
    !requested.has(entry.id) ||
    typeof entry.outcome !== 'string' ||
    !PROBE_OUTCOMES.includes(entry.outcome)
  ) {
    return null
  }
  const probe: RequirementProbeResult = {
    id: entry.id,
    outcome: entry.outcome as RequirementProbeOutcome
  }
  if (entry.resolvedPath !== undefined) {
    if (!isShortString(entry.resolvedPath, 4096)) {
      return null
    }
    probe.resolvedPath = entry.resolvedPath
  }
  if (entry.version !== undefined) {
    if (
      typeof entry.version !== 'string' ||
      !/^\d{1,9}\.\d{1,9}(?:\.\d{1,9})?$/.test(entry.version)
    ) {
      return null
    }
    probe.version = entry.version
  }
  for (const flag of ['present', 'authenticated'] as const) {
    if (entry[flag] !== undefined) {
      if (typeof entry[flag] !== 'boolean') {
        return null
      }
      probe[flag] = entry[flag]
    }
  }
  if (entry.reason !== undefined) {
    if (!isShortString(entry.reason, 64)) {
      return null
    }
    probe.reason = entry.reason
  }
  return probe
}

function readMeasureResponse(
  value: unknown,
  requested: ReadonlySet<string>
): { platform: MeasuredPlatform; probes: RequirementProbeResult[] } | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const { platform, probes } = value as { platform?: unknown; probes?: unknown }
  const host = platform as Record<string, unknown> | null | undefined
  if (
    !host ||
    typeof host !== 'object' ||
    !isShortString(host.os, 32) ||
    !isShortString(host.arch, 32) ||
    !Array.isArray(probes) ||
    probes.length > requested.size
  ) {
    return null
  }
  const readProbes = probes.map((probe) => readProbe(probe, requested))
  if (readProbes.some((probe) => probe === null)) {
    return null
  }
  return {
    platform: { os: host.os, arch: host.arch },
    probes: readProbes as RequirementProbeResult[]
  }
}

async function defaultGetMultiplexer(connectionId: string): Promise<MuxLike | undefined> {
  // Why: loaded on demand so this module stays importable without the Electron-bound SSH layer.
  const { getActiveMultiplexer } = await import('./ipc/ssh')
  return getActiveMultiplexer(connectionId)
}

export async function measureRequirementsOverSsh(input: {
  connectionId: string
  hostKey: string
  workspacePath: string
  requirements: EnvironmentRequirement[]
  deps?: Partial<SshMeasurementDeps>
}): Promise<HostMeasurement> {
  const getMultiplexer = input.deps?.getMultiplexer ?? defaultGetMultiplexer
  const now = input.deps?.now ?? Date.now
  const base = () => ({ at: now(), hostKey: input.hostKey })
  const mux = await getMultiplexer(input.connectionId)
  if (!mux || mux.isDisposed()) {
    return { ...base(), status: 'unreachable', detail: 'no-connection' }
  }

  // Same contract as skillSshRelayCapabilities, read per call so a reconnect to an upgraded relay is seen.
  let capabilities: string[]
  try {
    const status = (await mux.request('relay.status', {}, { timeoutMs: STATUS_TIMEOUT_MS })) as {
      capabilities?: unknown
    } | null
    capabilities =
      status && Array.isArray(status.capabilities)
        ? status.capabilities.filter((value): value is string => typeof value === 'string')
        : []
  } catch (error) {
    return mapSshMeasurementFailure(error, base())
  }
  if (!capabilities.includes(ENVIRONMENT_REQUIREMENTS_CAPABILITY)) {
    return { ...base(), status: 'host-predates-probes', detail: 'capability-missing' }
  }

  const { accepted, overflow } = splitByRequestCap(toProbeRequests(input.requirements))
  let response: unknown
  try {
    response = await mux.request(
      'environment.measureRequirements',
      { workspacePath: input.workspacePath, requirements: accepted },
      { timeoutMs: MEASURE_TIMEOUT_MS }
    )
  } catch (error) {
    return mapSshMeasurementFailure(error, base())
  }
  const parsed = readMeasureResponse(response, new Set(accepted.map((request) => request.id)))
  if (!parsed) {
    return { ...base(), status: 'refused', detail: 'malformed-response' }
  }
  return {
    ...base(),
    status: 'measured',
    platform: parsed.platform,
    probes: [...parsed.probes, ...overflow]
  }
}
