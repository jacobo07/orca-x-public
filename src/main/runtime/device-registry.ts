// Why: per-device tokens replace the shared runtime auth token for WebSocket
// (mobile) connections. Each paired device gets its own revocable token so
// compromising one device doesn't expose others. The registry is a simple
// JSON file with hardened permissions matching the runtime metadata pattern.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import type { DeviceScope } from '../../shared/runtime-types'
import { DEVICE_REGISTRY_FILENAME, DEVICE_REVOCATIONS_FILENAME } from './mobile-pairing-files'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'

export type { DeviceScope }

export type DeviceEntry = {
  deviceId: string
  name: string
  token: string
  scope: DeviceScope
  pairedAt: number
  lastSeenAt: number
  relayBinding?: RelayDeviceBinding
  mobilePairingConnectionMode?: MobilePairingConnectionMode
  // Why: STA-2370 — a grant minted for "This computer only" proves nothing about off-host reach when its
  // client connects, so the bind decision must be able to tell it apart from a LAN/phone grant.
  pairingReach?: RuntimePairingReach
}

export type DeviceRegistryAvailability = { available: true } | { available: false; reason: string }

// Why: the token is a live credential, so a revocation record keeps only its digest.
export type RevocationTombstone = { deviceId: string; tokenHash: string; revokedAt: number }

const REGISTRY_FILE_VERSION = 2
// Why: tombstones only need to outlive a reconnecting client's retry horizon; unbounded growth is recurring-work debt.
const MAX_TOMBSTONES = 256
const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function pruneTombstones(tombstones: RevocationTombstone[], now: number): RevocationTombstone[] {
  return tombstones.filter((entry) => now - entry.revokedAt <= TOMBSTONE_MAX_AGE_MS).slice(-MAX_TOMBSTONES)
}

function validTombstones(value: unknown): RevocationTombstone[] {
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

// Why: a lastSeen refresh is pure bookkeeping, so coalesce reconnect bursts into one write instead of
// paying a secure-file rewrite (two synchronous PowerShell ACL spawns on Windows) per connection.
const LAST_SEEN_FLUSH_DELAY_MS = 250

export class DeviceRegistry {
  private readonly registryPath: string
  private readonly revocationsPath: string
  private devices: DeviceEntry[] = []
  private revoked: RevocationTombstone[] = []
  private tombstonesDirty = false
  private pendingLastSeenFlush: NodeJS.Timeout | null = null
  private unavailableReason: string | null = null

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    this.revocationsPath = join(userDataPath, DEVICE_REVOCATIONS_FILENAME)
    this.load()
    if (this.unavailableReason === null) {
      this.loadTombstones()
    }
  }

  getAvailability(): DeviceRegistryAvailability {
    return this.unavailableReason === null
      ? { available: true }
      : { available: false, reason: this.unavailableReason }
  }

  // Why: an unreadable registry is "unknown", not "empty"; publishing over it would erase every pairing.
  private assertAvailable(): void {
    if (this.unavailableReason !== null) {
      throw new Error(`device_registry_unavailable: ${this.unavailableReason}`)
    }
  }

  addDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network'
  ): DeviceEntry {
    this.assertAvailable()
    return this.createAndPersistDevice(this.devices, name, scope, pairingReach)
  }

  private createAndPersistDevice(
    existingDevices: DeviceEntry[],
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach
  ): DeviceEntry {
    const entry: DeviceEntry = {
      deviceId: randomUUID(),
      name,
      token: randomBytes(24).toString('hex'),
      scope,
      pairedAt: Date.now(),
      lastSeenAt: 0,
      pairingReach
    }
    const nextDevices = [...existingDevices, entry]
    // Why: a credential is not valid until its durable registry write succeeds.
    this.save(nextDevices)
    this.devices = nextDevices
    return entry
  }

  // Why: coalesce repeated QR-regenerate clicks onto a single pending token.
  // Each call to addDevice() produces a valid auth credential; without
  // coalescing, every renderer call to mobile:getPairingQR (e.g. the new
  // copy-button flow that encourages regeneration) leaves an orphaned token
  // forever. Returns an existing never-scanned entry if present; otherwise
  // mints a new one and drops any stale pending entries.
  getOrCreatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network'
  ): DeviceEntry {
    this.assertAvailable()
    const existing = this.devices.find((d) => d.lastSeenAt === 0 && d.scope === scope)
    if (existing) {
      // Why: the same pending token can be re-advertised at a broader reach; widen it but never narrow it,
      // or a link already handed out for off-host use would stop being served after the next launch.
      return pairingReach === 'network' && existing.pairingReach === 'this-computer'
        ? this.setPairingReach(existing, 'network')
        : existing
    }
    return this.addDevice(name, scope, pairingReach)
  }

  private setPairingReach(existing: DeviceEntry, pairingReach: RuntimePairingReach): DeviceEntry {
    const updated: DeviceEntry = { ...existing, pairingReach }
    const nextDevices = this.devices.map((device) =>
      device.deviceId === existing.deviceId ? updated : device
    )
    // Why: persist before the memory swap so a failed write cannot leave the bind decision reading a
    // reach that never reached disk.
    this.save(nextDevices)
    this.devices = nextDevices
    return updated
  }

  // Why: explicit rotation path for "Regenerate QR" — invalidates any
  // existing never-scanned token (e.g. one that was screenshotted, copied
  // to clipboard, or shown on a screen-share) and mints a fresh one. Without
  // this, getOrCreatePendingDevice keeps returning the same token forever
  // until a phone actually pairs, so users have no way to revoke a leaked
  // pre-pairing token.
  rotatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network'
  ): DeviceEntry {
    this.assertAvailable()
    const retainedDevices = this.devices.filter((d) => d.lastSeenAt !== 0 || d.scope !== scope)
    return this.createAndPersistDevice(retainedDevices, name, scope, pairingReach)
  }

  removeDevice(deviceId: string): boolean {
    this.assertAvailable()
    const removed = this.devices.find((d) => d.deviceId === deviceId)
    if (!removed) {
      return false
    }
    // Why: a revoke inverts the grant ordering — memory first, so a failed write can never leave the device
    // valid; the save error still propagates and the next successful save persists the revocation.
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId)
    this.revoked = pruneTombstones(
      [
        ...this.revoked,
        { deviceId, tokenHash: hashToken(removed.token), revokedAt: Date.now() }
      ],
      Date.now()
    )
    this.tombstonesDirty = true
    this.save(this.devices)
    return true
  }

  isRevokedToken(token: string): boolean {
    const tokenHash = hashToken(token)
    return this.revoked.some((entry) => entry.tokenHash === tokenHash)
  }

  getDevice(deviceId: string): DeviceEntry | null {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null
  }

  getPendingDevice(scope: DeviceScope = 'mobile'): DeviceEntry | null {
    return this.devices.find((device) => device.lastSeenAt === 0 && device.scope === scope) ?? null
  }

  setRelayBinding(deviceId: string, binding: RelayDeviceBinding): boolean {
    this.assertAvailable()
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1 || binding.relayDeviceId !== deviceId) {
      return false
    }
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, relayBinding: binding } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  setMobilePairingConnectionMode(deviceId: string, mode: MobilePairingConnectionMode): boolean {
    this.assertAvailable()
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1 || this.devices[index]?.scope !== 'mobile') {
      return false
    }
    // Why: persist before swapping memory so a failed write does not leave a
    // mode the UI/runtime believe was stored.
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, mobilePairingConnectionMode: mode } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  getMobilePairingConnectionMode(deviceId: string): MobilePairingConnectionMode | null {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId)
    if (!device || device.scope !== 'mobile') {
      return null
    }
    // Why: pairings created before this preference existed used automatic
    // direct-first Relay fallback, so missing state must preserve that behavior.
    return device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic'
  }

  listDevices(): readonly DeviceEntry[] {
    return this.devices
  }

  validateToken(token: string): DeviceEntry | null {
    if (this.unavailableReason !== null) {
      return null
    }
    return this.devices.find((d) => d.token === token) ?? null
  }

  updateLastSeen(deviceId: string): void {
    this.assertAvailable()
    const index = this.devices.findIndex((d) => d.deviceId === deviceId)
    if (index === -1) {
      return
    }
    // Why: persist before memory swap so a failed write cannot leave a scanned
    // device looking never-scanned on disk, where rotation would drop it.
    const seenAt = Date.now()
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, lastSeenAt: seenAt } : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    this.cancelPendingLastSeenFlush()
  }

  /**
   * Marks a device seen without blocking the caller on disk — the E2EE auth handshake runs this, and on
   * Windows every save spawns PowerShell synchronously to reapply the registry's ACL.
   * The first-ever sighting still persists inline: rotatePendingDevice drops entries that disk says were
   * never scanned, so only that 0 -> non-zero transition is load-bearing.
   */
  updateLastSeenDeferred(deviceId: string): void {
    // Why: runs on the E2EE handshake, which must not crash; an unavailable registry has nothing to mark.
    if (this.unavailableReason !== null) {
      return
    }
    const index = this.devices.findIndex((d) => d.deviceId === deviceId)
    if (index === -1) {
      return
    }
    if (this.devices[index]!.lastSeenAt === 0) {
      this.updateLastSeen(deviceId)
      return
    }
    const seenAt = Date.now()
    this.devices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, lastSeenAt: seenAt } : device
    )
    if (this.pendingLastSeenFlush) {
      return
    }
    this.pendingLastSeenFlush = setTimeout(
      () => this.flushPendingLastSeen(),
      LAST_SEEN_FLUSH_DELAY_MS
    )
    // Why: bookkeeping must never hold the process open.
    this.pendingLastSeenFlush.unref?.()
  }

  /** Persists a deferred lastSeen refresh now; no-op when nothing is pending. */
  flushPendingLastSeen(): void {
    if (!this.pendingLastSeenFlush || this.unavailableReason !== null) {
      return
    }
    this.cancelPendingLastSeenFlush()
    try {
      this.save(this.devices)
    } catch (error) {
      // Why: matches the async hardening path — a failed bookkeeping write must not take down the runtime.
      console.error('[mobile] Failed to persist device lastSeen:', error)
    }
  }

  private cancelPendingLastSeenFlush(): void {
    if (this.pendingLastSeenFlush) {
      clearTimeout(this.pendingLastSeenFlush)
      this.pendingLastSeenFlush = null
    }
  }

  private load(): void {
    if (!existsSync(this.registryPath)) {
      this.devices = []
      return
    }
    let raw: string
    try {
      hardenExistingSecureFile(this.registryPath)
      raw = readFileSync(this.registryPath, 'utf-8')
    } catch (error) {
      // Why: an I/O failure (EBUSY, EPERM) says nothing about the bytes; leave them for the next launch.
      this.devices = []
      this.revoked = []
      this.unavailableReason = `read failed: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      // Why: v1 was a bare array (no tombstones); v2 is an envelope. Any other shape, including a newer
      // version, is unreadable to this build and must be preserved rather than reinterpreted.
      let stored: unknown
      if (Array.isArray(parsed)) {
        stored = parsed
      } else if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { version?: unknown }).version === REGISTRY_FILE_VERSION &&
        Array.isArray((parsed as { devices?: unknown }).devices)
      ) {
        stored = (parsed as { devices: unknown }).devices
        // Why: a dev build wrote tombstones inside the devices file; carry them to the sibling file on the next save.
        this.revoked = validTombstones((parsed as { revoked?: unknown }).revoked)
        this.tombstonesDirty = this.revoked.length > 0
      } else {
        throw new Error('registry is neither a bare array nor a v2 envelope')
      }
      this.devices = (stored as DeviceEntry[]).map((device) => ({
        ...device,
        // Why: older registries only existed for phone pairing. Treat missing
        // scope as mobile so legacy device tokens do not gain new CLI powers.
        scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
        relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
        mobilePairingConnectionMode:
          device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
        // Why: registries written before this field existed only ever held network-reach grants (phones and
        // LAN links), so a missing value must keep binding every interface on reconnect.
        pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network'
      }))
    } catch (error) {
      this.devices = []
      this.revoked = []
      this.tombstonesDirty = false
      this.unavailableReason = error instanceof Error ? error.message : String(error)
      // Why: keep the unreadable bytes for recovery; the next save would otherwise overwrite them.
      try {
        renameSync(this.registryPath, `${this.registryPath}.corrupt-${Date.now()}`)
      } catch {
        // Why: the registry stays unavailable either way, so a failed rename only costs the recovery copy.
      }
    }
  }

  // Why: a missing or unreadable tombstone file only loses the refusal reason (a revoked token reads
  // unknown_token, still refused); it must never make the registry unavailable or re-authorize anyone.
  private loadTombstones(): void {
    let stored: RevocationTombstone[] = []
    try {
      stored = validTombstones(JSON.parse(readFileSync(this.revocationsPath, 'utf-8')))
    } catch {
      // Why: see above — absence and damage degrade to "no reasons".
    }
    const known = new Set(this.revoked.map((entry) => entry.tokenHash))
    this.revoked = pruneTombstones(
      [...stored.filter((entry) => !known.has(entry.tokenHash)), ...this.revoked],
      Date.now()
    )
  }

  private save(devices: DeviceEntry[]): void {
    // Why: devices first, so a failed tombstone write can only lose the reason, never resurrect a device.
    writeDurableSecureJsonFile(this.registryPath, devices)
    if (this.tombstonesDirty) {
      const revoked = pruneTombstones(this.revoked, Date.now())
      writeDurableSecureJsonFile(this.revocationsPath, revoked)
      this.revoked = revoked
      this.tombstonesDirty = false
    }
    // Why: every registry save includes the latest in-memory timestamps, so a later timer would rewrite it.
    this.cancelPendingLastSeenFlush()
  }
}
