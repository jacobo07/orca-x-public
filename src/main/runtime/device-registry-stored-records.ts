// What orca-devices.json and orca-device-revocations.json hold, and how a loaded file becomes registry
// state. Pure: no file I/O, so DeviceRegistry keeps sole ownership of reads and durable writes.
import { createHash } from 'node:crypto'
import type { DeviceScope } from '../../shared/runtime-types'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'

export type DeviceEntry = {
  deviceId: string
  name: string
  // Why (D2): only the digest rests on disk once paired. The raw token is known in memory while pending
  // (its QR is re-advertised) or after the device authenticated this run; live sockets are keyed by it.
  token?: string
  tokenHash: string
  scope: DeviceScope
  pairedAt: number
  lastSeenAt: number
  relayBinding?: RelayDeviceBinding
  mobilePairingConnectionMode?: MobilePairingConnectionMode
  // Why: STA-2370 — a grant minted for "This computer only" proves nothing about off-host reach when its
  // client connects, so the bind decision must be able to tell it apart from a LAN/phone grant.
  pairingReach?: RuntimePairingReach
}

/** A minted or never-scanned entry: its raw token is what a pairing offer advertises. */
export type PendingDeviceEntry = DeviceEntry & { token: string }

// Why: the token is a live credential, so a revocation record keeps only its digest.
export type RevocationTombstone = { deviceId: string; tokenHash: string; revokedAt: number }

const REGISTRY_FILE_VERSION = 2
// Why: tombstones only need to outlive a reconnecting client's retry horizon; unbounded growth is recurring-work debt.
const MAX_TOMBSTONES = 256
const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export function hasRawToken(device: DeviceEntry): device is PendingDeviceEntry {
  return typeof device.token === 'string'
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Why (D2): a paired token rests only as its digest; the pending one stays raw so its QR survives a restart.
// An older build matches `d.token === token`, so a stripped entry is refused there, never accepted.
export function toStoredDevice(device: DeviceEntry): DeviceEntry {
  if (device.lastSeenAt === 0) {
    return device
  }
  const { token: _inMemoryOnly, ...stored } = device
  return stored
}

export function replaceDeviceAt(
  devices: DeviceEntry[],
  index: number,
  patch: Partial<DeviceEntry>
): DeviceEntry[] {
  return devices.map((device, candidateIndex) =>
    candidateIndex === index ? { ...device, ...patch } : device
  )
}

export function pruneTombstones(
  tombstones: RevocationTombstone[],
  now: number
): RevocationTombstone[] {
  return tombstones
    .filter((entry) => now - entry.revokedAt <= TOMBSTONE_MAX_AGE_MS)
    .slice(-MAX_TOMBSTONES)
}

export function validTombstones(value: unknown): RevocationTombstone[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter(
    (entry): entry is RevocationTombstone =>
      !!entry &&
      typeof entry.deviceId === 'string' &&
      typeof entry.tokenHash === 'string' &&
      typeof entry.revokedAt === 'number' &&
      Number.isFinite(entry.revokedAt)
  )
}

function validRelayBinding(value: unknown, deviceId: string): RelayDeviceBinding | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const binding = value as Partial<RelayDeviceBinding>
  return binding.relayDeviceId === deviceId &&
    typeof binding.relayHostId === 'string' &&
    typeof binding.ownerIdentityKey === 'string'
    ? {
        relayHostId: binding.relayHostId,
        relayDeviceId: binding.relayDeviceId,
        ownerIdentityKey: binding.ownerIdentityKey,
        ...(typeof binding.inviteExpiresAt === 'number' && Number.isFinite(binding.inviteExpiresAt)
          ? { inviteExpiresAt: binding.inviteExpiresAt }
          : {})
      }
    : undefined
}

function normalizeStoredDevice({
  token: rawToken,
  tokenHash,
  ...device
}: DeviceEntry): DeviceEntry {
  return {
    ...device,
    ...(typeof rawToken === 'string' ? { token: rawToken } : {}),
    // Why (D2): registries written before the digest existed hold only the raw token; derive it, and the
    // registry's migration save then drops the raw value for every paired entry.
    tokenHash:
      typeof tokenHash === 'string'
        ? tokenHash
        : typeof rawToken === 'string'
          ? hashToken(rawToken)
          : '',
    // Why: older registries only existed for phone pairing. Treat missing
    // scope as mobile so legacy device tokens do not gain new CLI powers.
    scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
    relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
    mobilePairingConnectionMode:
      device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
    // Why: registries written before this field existed only ever held network-reach grants (phones and
    // LAN links), so a missing value must keep binding every interface on reconnect.
    pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network'
  }
}

/** Throws on any shape this build cannot read, so the caller preserves the bytes instead of reinterpreting them. */
export function parseStoredRegistry(raw: string): {
  devices: DeviceEntry[]
  revoked: RevocationTombstone[]
} {
  const parsed: unknown = JSON.parse(raw)
  // Why: v1 was a bare array (no tombstones); v2 is an envelope. Any other shape, including a newer
  // version, is unreadable to this build and must be preserved rather than reinterpreted.
  if (Array.isArray(parsed)) {
    return { devices: (parsed as DeviceEntry[]).map(normalizeStoredDevice), revoked: [] }
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { version?: unknown }).version === REGISTRY_FILE_VERSION &&
    Array.isArray((parsed as { devices?: unknown }).devices)
  ) {
    return {
      devices: (parsed as { devices: DeviceEntry[] }).devices.map(normalizeStoredDevice),
      revoked: validTombstones((parsed as { revoked?: unknown }).revoked)
    }
  }
  throw new Error('registry is neither a bare array nor a v2 envelope')
}
