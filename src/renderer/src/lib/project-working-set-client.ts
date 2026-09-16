import type {
  WorkingSetListResult,
  WorkingSetReadResult,
  WorkingSetRestoreEvidenceResult,
  WorkingSetSaveResult,
  WorkingSetScopeKey
} from '../../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'

/**
 * The renderer's only door to the sealed working-set store.
 *
 * Why every answer is checked against its status set: a client without the IPC (an older or
 * browser build reaching a name-guessing fallback) can answer `undefined` or `[]`, and an empty
 * list read as "no snapshots" is a lie about storage that does not exist.
 */

export type WorkingSetStoreBridge = {
  save: (candidate: unknown) => Promise<unknown>
  list: (scope: WorkingSetScopeKey) => Promise<unknown>
  read: (args: { scope: WorkingSetScopeKey; workingSetId: string }) => Promise<unknown>
  probeRestoreEvidence: (args: {
    scope: WorkingSetScopeKey
    workingSetId: string
  }) => Promise<unknown>
}

const READ_STATUSES = new Set([
  'valid',
  'unsupported-version',
  'corrupt',
  'unreadable',
  'missing',
  'invalid-request',
  'unavailable'
])
const LIST_STATUSES = new Set(['listed', 'unreadable', 'invalid-request', 'unavailable'])
const SAVE_STATUSES = new Set([
  'saved',
  'refused-invalid',
  'refused-unsupported-version',
  'identity-collision',
  'write-failed',
  'durability-failed',
  'publish-failed',
  'read-back-failed',
  'verify-failed',
  'unavailable'
])

const UNAVAILABLE = { status: 'unavailable' } as const

function hasStatus(value: unknown, statuses: ReadonlySet<string>): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const { status } = value as { status?: unknown }
  return typeof status === 'string' && statuses.has(status)
}

async function ask<T>(
  call: () => Promise<unknown>,
  statuses: ReadonlySet<string>,
  shapeOk: (value: T) => boolean = () => true
): Promise<T | typeof UNAVAILABLE> {
  let answer: unknown
  try {
    answer = await call()
  } catch {
    // Why unavailable rather than rethrown: a missing handler rejects exactly like no store.
    return UNAVAILABLE
  }
  return hasStatus(answer, statuses) && shapeOk(answer as T) ? (answer as T) : UNAVAILABLE
}

function defaultBridge(): WorkingSetStoreBridge {
  return window.api.workingSet
}

export function saveWorkingSetManifest(
  manifest: ProjectWorkingSetManifest,
  bridge: WorkingSetStoreBridge = defaultBridge()
): Promise<WorkingSetSaveResult> {
  return ask<WorkingSetSaveResult>(() => bridge.save(manifest), SAVE_STATUSES)
}

export function listWorkingSets(
  scope: WorkingSetScopeKey,
  bridge: WorkingSetStoreBridge = defaultBridge()
): Promise<WorkingSetListResult> {
  return ask<WorkingSetListResult>(
    () => bridge.list(scope),
    LIST_STATUSES,
    (answer) =>
      answer.status !== 'listed' || (Array.isArray(answer.valid) && Array.isArray(answer.problems))
  )
}

export function readWorkingSet(
  scope: WorkingSetScopeKey,
  workingSetId: string,
  bridge: WorkingSetStoreBridge = defaultBridge()
): Promise<WorkingSetReadResult> {
  return ask<WorkingSetReadResult>(() => bridge.read({ scope, workingSetId }), READ_STATUSES)
}

const PROBE_STATUSES = new Set([...READ_STATUSES].filter((s) => s !== 'valid').concat('probed'))

export function probeWorkingSetRestoreEvidence(
  scope: WorkingSetScopeKey,
  workingSetId: string,
  bridge: WorkingSetStoreBridge = defaultBridge()
): Promise<WorkingSetRestoreEvidenceResult> {
  return ask<WorkingSetRestoreEvidenceResult>(
    () => bridge.probeRestoreEvidence({ scope, workingSetId }),
    PROBE_STATUSES,
    (answer) =>
      answer.status !== 'probed' ||
      (typeof answer.evidence === 'object' &&
        answer.evidence !== null &&
        typeof answer.evidence.panes === 'object')
  )
}
