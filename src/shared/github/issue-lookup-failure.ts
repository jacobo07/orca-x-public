import type { ClassifiedError } from '../classified-error'

// Why: a failed issue lookup crosses IPC and the runtime RPC as a bare Error message, so the message is the only
// channel a paired client has. Fixed per-class strings let it tell a retry-worthy failure from a permanent one
// without a new wire field; an unrecognised message (older host) reads as transient.
export const ISSUE_LOOKUP_FAILURE_MESSAGES = {
  permission_denied: 'Issue lookup failed: permission denied',
  issues_disabled: 'Issue lookup failed: issues are disabled for this repository',
  validation_error: 'Issue lookup failed: invalid request',
  rate_limited: 'Issue lookup failed: GitHub rate limit hit',
  network_error: 'Issue lookup failed: network error',
  unknown: 'Failed to load issue',
  unresolved_repository: 'Could not resolve GitHub owner/repo for this repository'
} as const satisfies Record<
  Exclude<ClassifiedError['type'], 'not_found'> | 'unresolved_repository',
  string
>

export type IssueLookupFailureKind = 'permanent' | 'rate_limited' | 'transient'

const KIND_BY_MESSAGE: readonly (readonly [string, IssueLookupFailureKind])[] = [
  [ISSUE_LOOKUP_FAILURE_MESSAGES.permission_denied, 'permanent'],
  [ISSUE_LOOKUP_FAILURE_MESSAGES.issues_disabled, 'permanent'],
  [ISSUE_LOOKUP_FAILURE_MESSAGES.validation_error, 'permanent'],
  [ISSUE_LOOKUP_FAILURE_MESSAGES.unresolved_repository, 'permanent'],
  [ISSUE_LOOKUP_FAILURE_MESSAGES.rate_limited, 'rate_limited']
]

export function classifyIssueLookupFailure(err: unknown): IssueLookupFailureKind {
  const message = err instanceof Error ? err.message : String(err)
  // Why: Electron wraps an invoke rejection as "Error invoking remote method ...: <message>", so match by inclusion.
  return KIND_BY_MESSAGE.find(([text]) => message.includes(text))?.[1] ?? 'transient'
}

const BACKOFF_BASE_MS = 5_000
const TRANSIENT_BACKOFF_CAP_MS = 120_000
const RATE_LIMITED_BACKOFF_MS = 300_000
const PERMANENT_BACKOFF_MS = 300_000

// Why: the failed lookup is not cached as an answer, so this is what keeps a hover or sweep from re-asking gh each time.
export function issueLookupBackoffMs(kind: IssueLookupFailureKind, attempts: number): number {
  if (kind === 'permanent') {
    return PERMANENT_BACKOFF_MS
  }
  if (kind === 'rate_limited') {
    return RATE_LIMITED_BACKOFF_MS
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), TRANSIENT_BACKOFF_CAP_MS)
}
