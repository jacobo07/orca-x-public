import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SshTarget } from '../../shared/ssh-types'
import {
  SshHostKeyRefusedError,
  hostKeyVerdictAllowsConnect,
  refusalFromVerdict,
  verifyHostKeyAgainstPin,
  type OfferedHostKey
} from './ssh-host-key-pin-verifier'
import type { SshResolvedConfig } from './ssh-config-parser'
import { resolveEffectiveHost, resolveEffectivePort } from './ssh-connection-utils'
import { getOrcaControlSocketPath } from './ssh-system-fallback'
import { buildSshArgs, type SystemSshBuildArgsOptions } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'

export type ObservedHostKey = { algorithm: string; fingerprint: string }

export type HostKeyObservation =
  | { kind: 'observed'; key: ObservedHostKey }
  | { kind: 'unobservable'; reason: UnobservableReason }

type ParseFailure = 'no-line' | 'ambiguous' | 'malformed'
export type UnobservableReason = ParseFailure | 'not-bound'

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

const UNOBSERVABLE_DETAIL: Record<UnobservableReason, string> = {
  'not-bound': 'this connection is not carried by an Orca-owned reusable OpenSSH session',
  'no-line': 'OpenSSH did not report it',
  ambiguous: 'OpenSSH reported more than one key',
  malformed: 'OpenSSH reported it in a form Orca does not recognize'
}

// Why: a refusal without a fingerprint to show; the reason says the key was never seen, not that a record is damaged.
export class SystemSshHostKeyUnobservableError extends SshHostKeyRefusedError {
  constructor(
    endpoint: { host: string; port: number },
    readonly unobservableReason: UnobservableReason
  ) {
    super('host_key_unverifiable', { fingerprint: '', ...endpoint })
    this.message = `Orca could not read the host key that system OpenSSH verified for ${endpoint.host}:${endpoint.port} (${UNOBSERVABLE_DETAIL[unobservableReason]}). Connection refused; connect from the host's menu to continue with OpenSSH's own host-key check.`
  }
}

export type SystemSshHostKeyDecision =
  | { kind: 'pinned' }
  | { kind: 'delegated' }
  | { kind: 'refused'; error: SshHostKeyRefusedError }

export type SystemSshHostKeyJudgement = {
  stderr: string
  // Why: only the probe that became the Orca ControlMaster is the session later commands ride.
  bound: boolean
  pin: unknown
  endpoint: { host: string; port: number }
  interactive: boolean
  pinWasReset: boolean
}

/**
 * Judges the key OpenSSH verified for the session against the pin with the ssh2 path's own verdict
 * functions. Unobservable never yields pinned: automatic connects refuse, interactive ones stay delegated.
 */
export function decideSystemSshHostKey(input: SystemSshHostKeyJudgement): SystemSshHostKeyDecision {
  const observation: HostKeyObservation = input.bound
    ? parseSystemSshHostKeyObservation(input.stderr)
    : { kind: 'unobservable', reason: 'not-bound' }
  if (observation.kind === 'unobservable') {
    return input.interactive
      ? { kind: 'delegated' }
      : {
          kind: 'refused',
          error: new SystemSshHostKeyUnobservableError(input.endpoint, observation.reason)
        }
  }
  const offered = hostKeyObservationToOffered(observation.key, input.endpoint)
  const verdict = verifyHostKeyAgainstPin(input.pin, offered)
  if (hostKeyVerdictAllowsConnect(verdict, input.interactive, input.pinWasReset)) {
    return { kind: 'pinned' }
  }
  return { kind: 'refused', error: refusalFromVerdict(verdict, offered) }
}

/**
 * Throws the refusal, or returns the identity the session may report: `pinned` for an observed
 * match, undefined for an interactive connect that stays delegated to OpenSSH.
 */
export function judgeIdentity(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  session: { stderr: string; controlPath: string | null; interactive: boolean }
): 'pinned' | undefined {
  const decision = decideSystemSshHostKey({
    stderr: session.stderr,
    bound: session.controlPath !== null,
    interactive: session.interactive,
    pin: target.hostKeyPin,
    // Why: the pin is recorded from the ssh2 path's effective endpoint, so the system path names the same one.
    endpoint: {
      host: resolveEffectiveHost(target, resolved),
      port: resolveEffectivePort(target, resolved)
    },
    pinWasReset: target.hostKeyPinReset === true
  })
  if (decision.kind === 'refused') {
    throw decision.error
  }
  return decision.kind === 'pinned' ? 'pinned' : undefined
}

const CONTROL_EXIT_TIMEOUT_MS = 5000

/**
 * Asks the Orca-owned master for this target to exit and returns its control path (null when the
 * session is not bound to one). Used to retire a master left by an earlier session so the next probe
 * handshakes and is observed, and to drop one whose key was refused. Resolves either way.
 */
export function retireControlMaster(
  target: SshTarget,
  buildArgsOptions: SystemSshBuildArgsOptions
): Promise<string | null> {
  const controlPath = getOrcaControlSocketPath(target, buildArgsOptions)
  const sshPath = findSystemSsh()
  if (!controlPath || !sshPath || !existsSync(controlPath)) {
    return Promise.resolve(controlPath)
  }
  return new Promise((resolve) => {
    execFile(
      sshPath,
      ['-O', 'exit', ...buildSshArgs(target, buildArgsOptions)],
      { timeout: CONTROL_EXIT_TIMEOUT_MS, windowsHide: true },
      () => resolve(controlPath)
    )
  })
}
