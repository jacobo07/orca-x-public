import type { SshHostIdentityStatus, SshHostKeyPin, SshHostKeyPinSource } from './ssh-types'

const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/
const PIN_SOURCES: ReadonlySet<string> = new Set<SshHostKeyPinSource>([
  'tofu-confirmed',
  'imported-known-hosts',
  'manual'
])

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

/**
 * What a person or observer may say about a target's host identity. The live
 * connection outranks the saved pin, but nothing may read as verified without a
 * valid pin for this very endpoint, and a delegated transport never reads as pinned.
 */
export function resolveSshHostIdentityStatus(
  target: { host: string; port: number; hostKeyPin?: unknown },
  live: SshHostIdentityStatus | undefined
): SshHostIdentityStatus {
  if (live === 'delegated-to-openssh') {
    return live
  }
  // Why: a persisted null is damage (clearing deletes the key), so only `undefined` means no pin.
  if (target.hostKeyPin === undefined) {
    return live === 'refused-unpinned' ? live : 'unpinned-legacy'
  }
  const pin = parseHostKeyPin(target.hostKeyPin)
  if (!pin) {
    return 'unverifiable'
  }
  if (pin.host.toLowerCase() !== target.host.toLowerCase() || pin.port !== target.port) {
    // Why: a pin for another endpoint grants no automatic grace, so it never reads as legacy.
    return 'refused-unpinned'
  }
  return live && live !== 'pinned' ? live : 'pinned'
}
