import { toSshExecutionHostId } from '../../shared/execution-host'
import { compareFleetAddresses } from '../../shared/fleet-host-identity'
import type {
  FleetSshHostIdentityCounts,
  FleetSshHostObservation
} from '../../shared/fleet-placement-view'
import type { SshHostIdentityStatus } from '../../shared/ssh-types'

export type FleetSshTarget = { id: string; label: string; status: string | null }

/** Asks one connected target's relay. Must not connect or deploy anything. */
export type FleetSshRelayCall = (args: {
  targetId: string
  method: 'relay.status' | 'fleet.resources'
  timeoutMs: number
  signal: AbortSignal
}) => Promise<unknown>

export type FleetSshHostIdentityListing = () => readonly {
  targetId: string
  status: SshHostIdentityStatus
}[]

async function observeSshHost(
  target: FleetSshTarget,
  call: FleetSshRelayCall,
  now: () => number,
  deadlineMs: number
): Promise<FleetSshHostObservation> {
  const base = {
    targetId: target.id,
    address: toSshExecutionHostId(target.id),
    label: target.label
  }
  const observedAt = now()
  const unknown = (
    reason: 'not-connected' | 'unreachable' | 'timeout' | 'malformed',
    detail: string
  ): FleetSshHostObservation => ({
    ...base,
    outcome: 'unknown',
    observedAt,
    reason,
    connection: target.status,
    detail
  })
  // Why: a probe must not dial; only a live relay link can answer.
  if (target.status !== 'connected') {
    return unknown('not-connected', `connection is ${target.status ?? 'unknown'}`)
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, deadlineMs)
  })
  try {
    const reply = await Promise.race([
      call({
        targetId: target.id,
        method: 'relay.status',
        timeoutMs: deadlineMs,
        signal: controller.signal
      }),
      deadline
    ])
    if (reply === 'timeout') {
      return unknown('timeout', `no answer within ${deadlineMs} ms`)
    }
    const record =
      typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : null
    const uptime = record?.uptimeMs
    if (
      !record ||
      typeof uptime !== 'number' ||
      !Number.isFinite(uptime) ||
      uptime < 0 ||
      !Array.isArray(record.capabilities)
    ) {
      return unknown('malformed', 'relay.status reply lacks uptimeMs or capabilities')
    }
    return {
      ...base,
      outcome: 'measured',
      observedAt,
      answeredAt: now(),
      relayUptimeMs: uptime,
      relayCapabilities: record.capabilities.filter((v): v is string => typeof v === 'string')
    }
  } catch (error) {
    return unknown('unreachable', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}

export async function observeSshHosts(args: {
  listSshTargets: (() => readonly FleetSshTarget[]) | undefined
  callSshRelay: FleetSshRelayCall | undefined
  now: () => number
  deadlineMs: number
  concurrency: number
}): Promise<FleetSshHostObservation[] | undefined> {
  const { listSshTargets, callSshRelay: call, now, deadlineMs, concurrency } = args
  if (!listSshTargets || !call) {
    return undefined
  }
  let targets: readonly FleetSshTarget[]
  try {
    targets = listSshTargets()
  } catch {
    // Why: an unreadable list is unknown; an empty list would read as "no SSH hosts".
    return undefined
  }
  const out: FleetSshHostObservation[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      out.push(await observeSshHost(targets[next++], call, now, deadlineMs))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  return out.sort((a, b) => compareFleetAddresses(a.address, b.address))
}

export function countSshHostIdentities(
  listSshHostIdentities: FleetSshHostIdentityListing | undefined
): FleetSshHostIdentityCounts | undefined {
  if (!listSshHostIdentities) {
    return undefined
  }
  let identities: ReturnType<FleetSshHostIdentityListing>
  try {
    identities = listSshHostIdentities()
  } catch {
    // Why: an unreadable snapshot is unknown, and zero counts would read as "no SSH hosts".
    return undefined
  }
  const counts: FleetSshHostIdentityCounts = {
    pinned: 0,
    unpinnedLegacy: 0,
    unverifiable: 0,
    delegated: 0,
    refusedChanged: 0
  }
  for (const { status } of identities) {
    switch (status) {
      case 'pinned':
        counts.pinned++
        break
      case 'delegated-to-openssh':
        counts.delegated++
        break
      case 'refused-changed':
        counts.refusedChanged++
        break
      case 'unverifiable':
        counts.unverifiable++
        break
      case 'unpinned-legacy':
      case 'refused-unpinned':
        counts.unpinnedLegacy++
        break
    }
  }
  return counts
}
