import { identityFromKeyFingerprint } from '../../shared/fleet-host-identity'
import type { FleetPlacementMember } from '../../shared/fleet-placement'
import type { FleetSshHostObservation } from '../../shared/fleet-placement-view'
import {
  fleetHostFactsFromStatus,
  fleetSampleFromSnapshot,
  type FleetResourceSample
} from '../../shared/fleet-resource-observation'
import {
  FLEET_RESOURCES_RELAY_CAPABILITY,
  FLEET_RESOURCES_RELAY_METHOD,
  sshHostKeyPlacementFingerprint
} from '../../shared/fleet-relay-resources'

export type FleetSshResourcesCall = (args: {
  targetId: string
  method: typeof FLEET_RESOURCES_RELAY_METHOD
  timeoutMs: number
  signal: AbortSignal
}) => Promise<unknown>

export type FleetSshMemberDeps = {
  now: () => number
  call: FleetSshResourcesCall
  /** The pinned SSH host key's fingerprint only while the target reads `pinned`; else null. */
  readPinnedFingerprint: (targetId: string) => string | null
  deadlineMs: number
}

async function askResources(
  targetId: string,
  deps: FleetSshMemberDeps
): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, deps.deadlineMs)
  })
  try {
    const reply = await Promise.race([
      deps.call({
        targetId,
        method: FLEET_RESOURCES_RELAY_METHOD,
        timeoutMs: deps.deadlineMs,
        signal: controller.signal
      }),
      deadline
    ])
    return reply === 'timeout'
      ? { ok: false, detail: `no answer within ${deps.deadlineMs} ms` }
      : { ok: true, value: reply }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function memberOf(
  host: Extract<FleetSshHostObservation, { outcome: 'measured' }>,
  deps: FleetSshMemberDeps
): Promise<FleetPlacementMember> {
  const pinned = deps.readPinnedFingerprint(host.targetId)
  const capabilities = [...host.relayCapabilities].sort()
  const startedAt = deps.now()
  let sample: FleetResourceSample
  let platform: NodeJS.Platform | null = null
  // Why: an older relay never sees the method, so no unadvertised request crosses the wire.
  if (!capabilities.includes(FLEET_RESOURCES_RELAY_CAPABILITY)) {
    sample = {
      outcome: 'unsupported',
      runtimeId: null,
      startedAt,
      detail: `relay does not advertise ${FLEET_RESOURCES_RELAY_CAPABILITY}`
    }
  } else {
    const reply = await askResources(host.targetId, deps)
    if (!reply.ok) {
      sample = { outcome: 'unreachable', runtimeId: null, startedAt, detail: reply.detail }
    } else {
      sample = fleetSampleFromSnapshot(reply.value, null, startedAt)
      const record = typeof reply.value === 'object' && reply.value !== null ? reply.value : {}
      platform = fleetHostFactsFromStatus(
        { hostPlatform: (record as Record<string, unknown>).platform },
        null
      ).platform
    }
  }
  return {
    address: host.address,
    label: host.label,
    // Why: only a key the connection verified is an identity; an unpinned target is never merged or ranked.
    identity: pinned
      ? identityFromKeyFingerprint(sshHostKeyPlacementFingerprint(pinned))
      : { state: 'unavailable', reason: 'no-key' },
    // Why: the relay is not an Orca runtime, so runtime protocol negotiation does not apply.
    facts: { runtimeId: null, platform, capabilities, protocol: 'not-applicable' },
    sample
  }
}

/** Members for the connected SSH targets whose relay answered; unconnected ones stay in coverage only. */
export async function observeSshPlacementMembers(
  hosts: readonly FleetSshHostObservation[] | undefined,
  deps: FleetSshMemberDeps
): Promise<FleetPlacementMember[]> {
  const measured = (hosts ?? []).filter(
    (host): host is Extract<FleetSshHostObservation, { outcome: 'measured' }> =>
      host.outcome === 'measured'
  )
  return Promise.all(measured.map((host) => memberOf(host, deps)))
}
