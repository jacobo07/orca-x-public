// Capability probe for the SSH relay: ask `relay.status` once per git-provider generation.
// A relay that does not advertise a capability must never be sent that capability's calls.

export type RelayCapabilityRequest = (
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs: number }
) => Promise<unknown>

export const REPLICA_BUNDLE_CAPABILITY = 'git.replicaBundle'

const PROBE_TIMEOUT_MS = 15_000
const cache = new Map<string, { generation: number; capabilities: readonly string[] }>()

export async function probeSshRelayCapabilities(
  connectionId: string,
  generation: number,
  request: RelayCapabilityRequest
): Promise<readonly string[]> {
  const hit = cache.get(connectionId)
  if (hit && hit.generation === generation) {
    return hit.capabilities
  }
  // A failed probe is not cached: the next call asks again.
  const status = (await request('relay.status', {}, { timeoutMs: PROBE_TIMEOUT_MS })) as {
    capabilities?: unknown
  } | null
  const capabilities = Array.isArray(status?.capabilities)
    ? status.capabilities.filter((v): v is string => typeof v === 'string')
    : []
  cache.set(connectionId, { generation, capabilities })
  return capabilities
}

export async function relaySupportsReplicaBundle(
  connectionId: string,
  generation: number,
  request: RelayCapabilityRequest
): Promise<boolean> {
  return (await probeSshRelayCapabilities(connectionId, generation, request)).includes(
    REPLICA_BUNDLE_CAPABILITY
  )
}

export function resetSshRelayCapabilityCacheForTests(): void {
  cache.clear()
}
