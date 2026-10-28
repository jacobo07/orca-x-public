// Capability probe for the SSH relay: ask `relay.status` once per git-provider generation.
// A relay that does not advertise a capability must never be sent that capability's calls.

export type RelayCapabilityRequest = (
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs: number }
) => Promise<unknown>

import { isMethodNotFoundError } from './ssh-filesystem-stream-reader'

export const REPLICA_BUNDLE_CAPABILITY = 'git.replicaBundle'
export const SYNC_CAPABILITY = 'sync.v1'
export const FABRIC_CAPABILITY = 'fabric.v1'

// Method-prefix -> capability a relay must advertise before the client sends it anything in that family.
const GATED_METHOD_FAMILIES: readonly (readonly [string, string])[] = [
  ['sync.', SYNC_CAPABILITY],
  ['fabric.', FABRIC_CAPABILITY]
]

export function requiredCapabilityForMethod(method: string): string | null {
  for (const [prefix, capability] of GATED_METHOD_FAMILIES) {
    if (method.startsWith(prefix)) {
      return capability
    }
  }
  return null
}

export class RelayCapabilityUnsupportedError extends Error {
  readonly code = 'RELAY_CAPABILITY_UNSUPPORTED'
  constructor(
    readonly method: string,
    readonly capability: string
  ) {
    super(`Relay does not support ${capability}; refusing ${method} (mixed relay version)`)
  }
}

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

function evictCapabilities(connectionId: string): void {
  cache.delete(connectionId)
}

/** Send a sync/fabric method only to a relay that advertised its capability. Fails closed: an old relay
 * (no capability, no relay.status, or MethodNotFound) yields RelayCapabilityUnsupportedError and the
 * method is never sent or retried in a widened form. Ungated methods pass straight through. */
export async function requestGatedRelayMethod(
  connectionId: string,
  generation: number,
  request: RelayCapabilityRequest,
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs: number }
): Promise<unknown> {
  const capability = requiredCapabilityForMethod(method)
  if (capability === null) {
    return request(method, params, options)
  }
  let capabilities: readonly string[]
  try {
    capabilities = await probeSshRelayCapabilities(connectionId, generation, request)
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      throw new RelayCapabilityUnsupportedError(method, capability)
    }
    throw error
  }
  if (!capabilities.includes(capability)) {
    throw new RelayCapabilityUnsupportedError(method, capability)
  }
  try {
    return await request(method, params, options)
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      // The relay was swapped for an older one mid-session: forget what it advertised.
      evictCapabilities(connectionId)
      throw new RelayCapabilityUnsupportedError(method, capability)
    }
    throw error
  }
}
