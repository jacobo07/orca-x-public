import {
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  toRuntimeExecutionHostId
} from '../../shared/execution-host'
import { compareFleetAddresses, identityFromKeyFingerprint } from '../../shared/fleet-host-identity'
import type { FleetPlacementMember } from '../../shared/fleet-placement'
import type { FleetObservation } from '../../shared/fleet-placement-view'
import {
  classifyRemoteFleetObservation,
  fleetHostFactsFromStatus,
  fleetSampleFromSnapshot,
  type FleetRpcStep
} from '../../shared/fleet-resource-observation'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { fingerprintHostPublicKey } from '../runtime/host-key-fingerprint'

export const FLEET_STEP_DEADLINE_MS = 5_000
export const FLEET_OBSERVATION_CONCURRENCY = 4

export type FleetEnvironmentCall = (args: {
  environmentId: string
  method: 'status.get' | 'diagnostics.memory'
  /** Refuses the call if the environment was re-paired since its key was read. */
  pairingRevision: number | undefined
  timeoutMs: number
  signal: AbortSignal
}) => Promise<RuntimeRpcResponse<unknown>>

export type FleetObservationDeps = {
  now: () => number
  /** `undefined` = no key file, `null` = unreadable. Must never create a key. */
  readLocalPublicKey: () => string | null | undefined
  getLocalStatus: () => { runtimeId: string }
  collectLocalSnapshot: () => Promise<unknown>
  listEnvironments: () => readonly KnownRuntimeEnvironment[]
  callEnvironment: FleetEnvironmentCall
  stepDeadlineMs?: number
}

export type { FleetObservation }

function fingerprintOf(key: string | null | undefined): string | null | undefined {
  return typeof key === 'string' ? fingerprintHostPublicKey(key) : key
}

function environmentFingerprint(environment: KnownRuntimeEnvironment): string | null | undefined {
  try {
    // Why: the call proves only the preferred endpoint's key, so that key is the identity.
    return fingerprintOf(getPreferredPairingOffer(environment).publicKeyB64)
  } catch {
    return undefined
  }
}

async function boundedStep(
  run: (signal: AbortSignal) => Promise<RuntimeRpcResponse<unknown>>,
  deadlineMs: number
): Promise<FleetRpcStep> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Why: the per-environment queue ignores the signal while waiting, so the deadline races
  // the whole call; aborting still cancels the request once it has started.
  const deadline = new Promise<FleetRpcStep>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ kind: 'threw', message: `no answer within ${deadlineMs} ms` })
    }, deadlineMs)
  })
  const call = run(controller.signal).then(
    (response): FleetRpcStep =>
      response.ok
        ? { kind: 'ok', runtimeId: response._meta.runtimeId, value: response.result }
        : { kind: 'error', code: response.error.code, message: response.error.message },
    (error: unknown): FleetRpcStep => ({
      kind: 'threw',
      message: error instanceof Error ? error.message : String(error)
    })
  )
  try {
    return await Promise.race([call, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function observeEnvironment(
  environment: KnownRuntimeEnvironment,
  deps: FleetObservationDeps,
  deadlineMs: number
): Promise<FleetPlacementMember> {
  const identity = identityFromKeyFingerprint(environmentFingerprint(environment))
  const startedAt = deps.now()
  const call = (method: 'status.get' | 'diagnostics.memory') =>
    boundedStep(
      (signal) =>
        deps.callEnvironment({
          environmentId: environment.id,
          method,
          pairingRevision: environment.pairingRevision,
          timeoutMs: deadlineMs,
          signal
        }),
      deadlineMs
    )
  const status = await call('status.get')
  const blocked =
    status.kind === 'ok' && fleetHostFactsFromStatus(status.value, null).protocol === 'blocked'
  const memory = status.kind === 'ok' && !blocked ? await call('diagnostics.memory') : null
  const { sample, facts } = classifyRemoteFleetObservation({ startedAt, status, memory })
  return {
    address: toRuntimeExecutionHostId(environment.id),
    label: environment.name,
    identity,
    facts,
    sample
  }
}

async function observeLocal(deps: FleetObservationDeps): Promise<FleetPlacementMember> {
  const identity = identityFromKeyFingerprint(fingerprintOf(deps.readLocalPublicKey()))
  const startedAt = deps.now()
  const status = deps.getLocalStatus()
  const snapshot = await deps.collectLocalSnapshot()
  return {
    address: LOCAL_EXECUTION_HOST_ID,
    label: getLocalExecutionHostLabel(),
    identity,
    // Why: this process is the host, so protocol negotiation does not apply to it.
    facts: { ...fleetHostFactsFromStatus(status, status.runtimeId), protocol: 'not-applicable' },
    sample: fleetSampleFromSnapshot(snapshot, status.runtimeId, startedAt)
  }
}

/** One bounded pass over this host and its paired runtimes. Reads only; arms no timer beyond it. */
export async function observeFleet(deps: FleetObservationDeps): Promise<FleetObservation> {
  const deadlineMs = deps.stepDeadlineMs ?? FLEET_STEP_DEADLINE_MS
  const observedAt = deps.now()
  const environments = [...deps.listEnvironments()]
  const remote: FleetPlacementMember[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < environments.length) {
      const environment = environments[next++]
      remote.push(await observeEnvironment(environment, deps, deadlineMs))
    }
  }
  const workers = Array.from(
    { length: Math.min(FLEET_OBSERVATION_CONCURRENCY, environments.length) },
    worker
  )
  const [local] = await Promise.all([observeLocal(deps), Promise.all(workers)])
  return {
    observedAt,
    completedAt: deps.now(),
    members: [local, ...remote.sort((a, b) => compareFleetAddresses(a.address, b.address))],
    coverage: { runtimeEnvironments: environments.length, sshTargets: 'not-enumerated' }
  }
}
