import type { OfferedHostKey } from './ssh-host-key-pin-verifier'

export type ObservedHostKey = { algorithm: string; fingerprint: string }

export type HostKeyObservation =
  | { kind: 'observed'; key: ObservedHostKey }
  | { kind: 'unobservable'; reason: 'no-line' | 'ambiguous' | 'malformed' }

// Why: with LogLevel=DEBUG1 the ssh that handshakes logs the key it verified, before it authenticates; a ControlPersist master drops stderr after backgrounding only when -v is absent, so this option (never -v) keeps the probe's pipe closable.
export const SYSTEM_SSH_HOST_KEY_LOG_OPTION = 'LogLevel=DEBUG1'

const OBSERVATION_PREFIX = 'debug1: Server host key: '
// Why: the fingerprint form is exactly computeHostKeyFingerprint's (SHA256: + 43 unpadded base64), so it compares with a pin byte for byte; a certificate line carries more text and fails the anchor on purpose.
const OBSERVATION_LINE =
  /^debug1: Server host key: ([a-z0-9][a-z0-9@._-]*) (SHA256:[A-Za-z0-9+/]{43})$/

/**
 * Reads the key a system `ssh` verified from the stderr of the connection that handshook.
 * Exactly one line is accepted: a server can print a look-alike through its banner, and a jump
 * host that logs adds a second line, so any other count is not trusted.
 */
export function parseSystemSshHostKeyObservation(stderr: string): HostKeyObservation {
  if (typeof stderr !== 'string') {
    return { kind: 'unobservable', reason: 'no-line' }
  }
  const candidates = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith(OBSERVATION_PREFIX.trimEnd()))
  if (candidates.length === 0) {
    return { kind: 'unobservable', reason: 'no-line' }
  }
  if (candidates.length > 1) {
    return { kind: 'unobservable', reason: 'ambiguous' }
  }
  const match = OBSERVATION_LINE.exec(candidates[0])
  if (!match) {
    return { kind: 'unobservable', reason: 'malformed' }
  }
  return { kind: 'observed', key: { algorithm: match[1], fingerprint: match[2] } }
}

export function hostKeyObservationToOffered(
  key: ObservedHostKey,
  endpoint: { host: string; port: number }
): OfferedHostKey {
  return {
    fingerprint: key.fingerprint,
    algorithm: key.algorithm,
    host: endpoint.host,
    port: endpoint.port
  }
}

// Why: the observation option makes ssh narrate its handshake; none of that belongs in an error a person reads or in a classifier.
export function stripOpenSshDebugLines(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('debug1: '))
    .join('\n')
    .trim()
}
