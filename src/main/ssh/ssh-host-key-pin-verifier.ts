import { createHash } from 'node:crypto'
import {
  SSH_HOST_KEY_REFUSED_CODE,
  type SshHostIdentityStatus,
  type SshHostKeyPin,
  type SshHostKeyPinSource,
  type SshHostKeyRefusalReason
} from '../../shared/ssh-types'

const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/
const PIN_SOURCES: ReadonlySet<string> = new Set<SshHostKeyPinSource>([
  'tofu-confirmed',
  'imported-known-hosts',
  'manual'
])

export type OfferedHostKey = {
  fingerprint: string
  host: string
  port: number
  algorithm?: string
  publicKeyBase64?: string
}

export type HostKeyVerdict =
  | { kind: 'pinned-match' }
  | { kind: 'unpinned' }
  | { kind: 'changed'; pinnedFingerprint: string }
  | { kind: 'unverifiable' }

// Why: one function computes the string so the relay lock namespace and the pin can never disagree.
export function computeHostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

// Why: the wire blob begins with an ssh-string naming the algorithm.
export function readHostKeyAlgorithm(key: Buffer): string | undefined {
  if (key.length < 4) {
    return undefined
  }
  const length = key.readUInt32BE(0)
  if (length === 0 || length > 64 || key.length < 4 + length) {
    return undefined
  }
  const name = key.subarray(4, 4 + length).toString('latin1')
  return /^[\x21-\x7e]+$/.test(name) ? name : undefined
}

export function isWellFormedHostKeyFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value)
}

export function parseHostKeyPin(value: unknown): SshHostKeyPin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (
    !isWellFormedHostKeyFingerprint(raw.fingerprint) ||
    typeof raw.host !== 'string' ||
    raw.host.length === 0 ||
    typeof raw.port !== 'number' ||
    !Number.isInteger(raw.port) ||
    raw.port < 1 ||
    raw.port > 65535 ||
    typeof raw.pinnedAt !== 'number' ||
    !Number.isFinite(raw.pinnedAt) ||
    typeof raw.source !== 'string' ||
    !PIN_SOURCES.has(raw.source) ||
    (raw.algorithm !== undefined && typeof raw.algorithm !== 'string') ||
    (raw.publicKeyBase64 !== undefined && typeof raw.publicKeyBase64 !== 'string')
  ) {
    return null
  }
  return {
    fingerprint: raw.fingerprint,
    ...(raw.algorithm !== undefined ? { algorithm: raw.algorithm as string } : {}),
    ...(raw.publicKeyBase64 !== undefined
      ? { publicKeyBase64: raw.publicKeyBase64 as string }
      : {}),
    host: raw.host,
    port: raw.port,
    pinnedAt: raw.pinnedAt,
    source: raw.source as SshHostKeyPinSource
  }
}

// Why: `pin` is unknown because it comes off disk; a damaged record must read unverifiable, never unpinned.
export function verifyHostKeyAgainstPin(pin: unknown, offered: OfferedHostKey): HostKeyVerdict {
  // Why: clearing a pin deletes the key, so a persisted null is damage, not "no pin".
  if (pin === undefined) {
    return { kind: 'unpinned' }
  }
  const parsed = parseHostKeyPin(pin)
  if (!parsed) {
    return { kind: 'unverifiable' }
  }
  if (parsed.host.toLowerCase() !== offered.host.toLowerCase() || parsed.port !== offered.port) {
    return { kind: 'unpinned' }
  }
  return parsed.fingerprint === offered.fingerprint
    ? { kind: 'pinned-match' }
    : { kind: 'changed', pinnedFingerprint: parsed.fingerprint }
}

// Why: only a match, or first contact on an automatic attempt (OD-2), may proceed; the rest are refused.
export function hostKeyVerdictAllowsConnect(
  verdict: HostKeyVerdict,
  interactive: boolean
): boolean {
  if (verdict.kind === 'pinned-match') {
    return true
  }
  return verdict.kind === 'unpinned' && !interactive
}

const unpinnedAutomaticConnects = new Map<string, number>()

// Why: OD-2 lets legacy targets reconnect unpinned; the counter keeps that grace visible (surfaced by 14-05).
export function noteUnpinnedAutomaticConnect(targetId: string, offered: OfferedHostKey): void {
  const count = (unpinnedAutomaticConnects.get(targetId) ?? 0) + 1
  unpinnedAutomaticConnects.set(targetId, count)
  console.warn(
    `[ssh-host-key] unpinned automatic connect to ${offered.host}:${offered.port} (${offered.fingerprint}); no pin recorded (#${count} for ${targetId})`
  )
}

export function getUnpinnedAutomaticConnectCount(targetId: string): number {
  return unpinnedAutomaticConnects.get(targetId) ?? 0
}

export function resetUnpinnedAutomaticConnectCounts(): void {
  unpinnedAutomaticConnects.clear()
}

// Why: a confirmed pin is adopted only if it names exactly the key this attempt was offered.
export function adoptableTrustedPin(pin: unknown, offered: OfferedHostKey): SshHostKeyPin | null {
  const parsed = parseHostKeyPin(pin)
  if (!parsed || parsed.source !== 'tofu-confirmed') {
    return null
  }
  return verifyHostKeyAgainstPin(parsed, offered).kind === 'pinned-match' ? parsed : null
}

export class SshHostKeyRefusedError extends Error {
  readonly code = SSH_HOST_KEY_REFUSED_CODE
  constructor(
    readonly reason: SshHostKeyRefusalReason,
    readonly offered: OfferedHostKey,
    readonly pinnedFingerprint?: string
  ) {
    super(describeRefusal(reason, offered, pinnedFingerprint))
    this.name = 'SshHostKeyRefusedError'
  }
}

export function isSshHostKeyRefusedError(err: unknown): err is SshHostKeyRefusedError {
  return err instanceof SshHostKeyRefusedError
}

export function refusalFromVerdict(
  verdict: HostKeyVerdict,
  offered: OfferedHostKey
): SshHostKeyRefusedError {
  if (verdict.kind === 'changed') {
    return new SshHostKeyRefusedError('host_key_changed', offered, verdict.pinnedFingerprint)
  }
  return new SshHostKeyRefusedError(
    verdict.kind === 'unverifiable' ? 'host_key_unverifiable' : 'host_key_unpinned',
    offered
  )
}

export function hostIdentityForRefusal(reason: SshHostKeyRefusalReason): SshHostIdentityStatus {
  if (reason === 'host_key_changed') {
    return 'refused-changed'
  }
  return reason === 'host_key_unpinned' ? 'refused-unpinned' : 'unverifiable'
}

function describeRefusal(
  reason: SshHostKeyRefusalReason,
  offered: OfferedHostKey,
  pinnedFingerprint: string | undefined
): string {
  const where = `${offered.host}:${offered.port}`
  if (reason === 'host_key_changed') {
    return `Host key for ${where} changed: pinned ${pinnedFingerprint}, offered ${offered.fingerprint}. Connection refused.`
  }
  if (reason === 'host_key_unpinned') {
    return `Host key for ${where} (${offered.fingerprint}) is not trusted yet. Connection refused.`
  }
  return `Stored host key record for ${where} is unreadable. Connection refused.`
}
