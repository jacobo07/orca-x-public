import { createHash, timingSafeEqual } from 'node:crypto'
import { OrchestrationError } from './orchestration-error'
import type { OrchestrationDb } from './db'

/**
 * A coordinator without a terminal (K4): a desktop cockpit such as the InfinityOps Sidecar owns a
 * Run as `headless:<name>`. The handle and its synthetic pane key are the same string. The caller
 * proves ownership with a 256-bit token it minted; the Run stores only the token's SHA-256.
 */
export const HEADLESS_HANDLE_PREFIX = 'headless:'

// Why these fields: every caller-supplied value a handler reads as "who is asking". A headless
// value in any of them is accepted only after the token verifies (spec K4 change 3).
export const HEADLESS_IDENTITY_FIELDS = [
  'from',
  'terminal',
  'terminalPaneKey',
  'senderPaneKey',
  'callerPaneKey',
  'callerTerminalHandle'
] as const

export const COORDINATOR_AUTH_FAILED = 'coordinator_auth_failed'

const NAME_PATTERN = /^[a-z0-9-]{3,40}$/
// Why refuse UUID-shaped names: `headless:<uuid>` would parse as tab `headless` + a UUID leaf and
// could suffix-match a real terminal pane bound to a Run.
const UUID_SHAPED = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export type HeadlessCoordinatorAuthority = {
  handle: string
  tokenHash: string
  /** Present on run-use when the caller also sent a replacement token (rotation). */
  newTokenHash?: string
}

export function isHeadlessHandle(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(HEADLESS_HANDLE_PREFIX)
}

export function assertHeadlessHandle(handle: string): void {
  const name = handle.slice(HEADLESS_HANDLE_PREFIX.length)
  if (!NAME_PATTERN.test(name) || UUID_SHAPED.test(name)) {
    throw new OrchestrationError(
      'invalid_argument',
      'A headless coordinator name is 3-40 characters of a-z, 0-9 and "-", and is not UUID-shaped.'
    )
  }
}

export function hashCoordinatorToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

function authFailed(message: string): OrchestrationError {
  return new OrchestrationError(COORDINATOR_AUTH_FAILED, `${message} No effects were applied.`, {
    effectsApplied: false
  })
}

function headlessValues(params: unknown): string[] {
  if (!params || typeof params !== 'object') {
    return []
  }
  const record = params as Record<string, unknown>
  return [
    ...new Set(HEADLESS_IDENTITY_FIELDS.map((field) => record[field]).filter(isHeadlessHandle))
  ]
}

function verifiedTokenHash(token: unknown): string {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw authFailed('A headless coordinator call needs its 256-bit token.')
  }
  return hashCoordinatorToken(token)
}

/**
 * The one gate for headless identity, run by the dispatcher before legacy routing, receipts and
 * handlers. Returns undefined when the request names no headless identity (nothing changes for
 * terminal coordinators). Throws coordinator_auth_failed on any doubt.
 */
export function authorizeHeadlessCoordinator(args: {
  method: string
  params: unknown
  token: unknown
  newToken?: unknown
  isLocalCaller: boolean
  // Why lazy: most requests name no headless identity and some runtimes have no orchestration db.
  getDb: () => OrchestrationDb
}): HeadlessCoordinatorAuthority | undefined {
  const record = (args.params && typeof args.params === 'object' ? args.params : {}) as Record<
    string,
    unknown
  >
  const values = headlessValues(record)
  // Why: a Run is also reached by its mailbox address (`check --terminal run:<id>`) and by id on
  // run-use. Those must be guarded too, or a headless Run is readable and takeable without its token.
  const addressedRunIds = HEADLESS_IDENTITY_FIELDS.map((field) => record[field])
    .filter((value): value is string => typeof value === 'string' && value.startsWith('run:'))
    .map((address) => address.slice('run:'.length))
  const runUseTarget =
    args.method === 'orchestration.runUse' && typeof record.id === 'string' ? record.id : undefined
  if (values.length === 0 && addressedRunIds.length === 0 && runUseTarget === undefined) {
    return undefined
  }

  if (values.length === 0) {
    refuseTokenGuardedRuns(args.getDb(), [
      ...addressedRunIds,
      ...(runUseTarget ? [runUseTarget] : [])
    ])
    return undefined
  }
  if (values.length > 1) {
    throw authFailed('A request may name only one headless coordinator.')
  }
  const handle = values[0]!
  assertHeadlessHandle(handle)
  if (!args.isLocalCaller) {
    throw authFailed('A headless coordinator is accepted from this host only.')
  }
  const tokenHash = verifiedTokenHash(args.token)
  const db = args.getDb()
  const bound = db.getCoordinatorTokenHashForPane(handle)
  for (const runId of addressedRunIds) {
    const addressed = db.getCoordinatorTokenHash(runId)
    if (addressed !== null && !hashesEqual(addressed, tokenHash)) {
      throw authFailed(`The token does not belong to Run ${runId}.`)
    }
  }
  const ownsBound = Boolean(bound?.tokenHash && hashesEqual(bound.tokenHash, tokenHash))

  if (args.method === 'orchestration.runCreate') {
    // Why: a new Run under a name that is already bound would unbind the owner's Run.
    if (bound && !ownsBound) {
      throw authFailed(`${handle} is bound to another Run; its token is required.`)
    }
    return { handle, tokenHash }
  }

  if (runUseTarget !== undefined) {
    const target = db.getCoordinatorTokenHash(runUseTarget)
    const newTokenHash = args.newToken === undefined ? undefined : verifiedTokenHash(args.newToken)
    // Why the second case: a retried rotation arrives after the hash already moved to the new
    // token; accepting it lets the stored receipt replay instead of leaving the caller unsure.
    const ownsTarget =
      target !== null &&
      (hashesEqual(target, tokenHash) ||
        (newTokenHash !== undefined && hashesEqual(target, newTokenHash)))
    if (!ownsTarget) {
      throw authFailed(`The token does not belong to Run ${runUseTarget}.`)
    }
    // Why: binding this name unbinds whatever Run holds it now; that Run's owner must agree.
    if (bound && bound.runId !== runUseTarget && !ownsBound) {
      throw authFailed(`${handle} is bound to another Run; its token is required.`)
    }
    return { handle, tokenHash, ...(newTokenHash ? { newTokenHash } : {}) }
  }

  if (!bound || !ownsBound) {
    throw authFailed(`The token does not match the Run bound to ${handle}.`)
  }
  return { handle, tokenHash }
}

// Why refuse rather than ask for a token: a caller without a headless identity is a terminal (or
// nobody), and a Run with a headless coordinator answers only to that coordinator's token.
function refuseTokenGuardedRuns(db: OrchestrationDb, runIds: readonly string[]): void {
  for (const runId of runIds) {
    if (db.getCoordinatorTokenHash(runId) !== null) {
      throw authFailed(`Run ${runId} has a headless coordinator; only its token holder may use it.`)
    }
  }
}

/**
 * The pane key of whoever is calling. A headless handle is its own synthetic key; anything else is a
 * terminal. Safe to trust a headless value here only because the dispatcher's gate verified it.
 */
export function resolveCallerPaneKey(
  runtime: { getTerminalPaneKey(handle: string): string | null | undefined },
  handle: string
): string | null {
  return isHeadlessHandle(handle) ? handle : (runtime.getTerminalPaneKey(handle) ?? null)
}
