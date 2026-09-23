import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from './execution-host'

// Why: an address is a route relative to the viewer; only a key Orca authenticates is a
// host identity. A host's statement about itself never reaches this module.
export type FleetHostIdentity =
  | { state: 'keyed'; fingerprint: string }
  | { state: 'unavailable'; reason: 'no-key' | 'key-unreadable' }

export type FleetHostAddressIdentity = {
  address: ExecutionHostId
  identity: FleetHostIdentity
}

export type FleetHostGroup<T extends FleetHostAddressIdentity = FleetHostAddressIdentity> = {
  /** `fingerprint:<fp>` for a keyed host, `address:<id>` for anything unkeyed. */
  key: string
  fingerprint: string | null
  addresses: ExecutionHostId[]
  members: T[]
}

/**
 * The key a call actually proves: `undefined` when none is recorded, `null` when the recorded
 * key could not be fingerprinted.
 */
export function identityFromKeyFingerprint(
  fingerprint: string | null | undefined
): FleetHostIdentity {
  if (fingerprint === undefined) {
    return { state: 'unavailable', reason: 'no-key' }
  }
  if (fingerprint === null) {
    return { state: 'unavailable', reason: 'key-unreadable' }
  }
  return { state: 'keyed', fingerprint }
}

export function compareFleetAddresses(a: ExecutionHostId, b: ExecutionHostId): number {
  if (a === b) {
    return 0
  }
  if (a === LOCAL_EXECUTION_HOST_ID) {
    return -1
  }
  if (b === LOCAL_EXECUTION_HOST_ID) {
    return 1
  }
  return a < b ? -1 : 1
}

/** Addresses that authenticate with one key are one host; nothing unkeyed is ever merged. */
export function groupFleetHostsByIdentity<T extends FleetHostAddressIdentity>(
  entries: readonly T[]
): FleetHostGroup<T>[] {
  const groups = new Map<string, FleetHostGroup<T>>()
  for (const entry of entries) {
    const fingerprint = entry.identity.state === 'keyed' ? entry.identity.fingerprint : null
    const key = fingerprint ? `fingerprint:${fingerprint}` : `address:${entry.address}`
    const group = groups.get(key) ?? { key, fingerprint, addresses: [], members: [] }
    group.members.push(entry)
    groups.set(key, group)
  }
  const ordered = [...groups.values()].map((group) => {
    const members = [...group.members].sort((a, b) => compareFleetAddresses(a.address, b.address))
    return { ...group, members, addresses: members.map((member) => member.address) }
  })
  // Why: keyed hosts first, then unkeyed; each by key so input order never changes the result.
  return ordered.sort((a, b) => {
    if ((a.fingerprint === null) !== (b.fingerprint === null)) {
      return a.fingerprint === null ? 1 : -1
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}
