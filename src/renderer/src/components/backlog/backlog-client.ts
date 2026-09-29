// The renderer's backlog.* data seam (reads here, writes in backlog-mutation-client.ts). Every
// answer is a closed outcome with codes only: no transport or host text a surface could render.
import type {
  BacklogHealthReport,
  BacklogQuarantineEntry,
  BacklogStorageStage,
  BacklogUnreadableCode
} from '../../../../shared/backlog-outcomes'
import { toBacklogItemSummary, type BacklogItemSummary } from '../../../../shared/backlog-summary'
import type { BacklogItem } from '../../../../shared/backlog-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { BACKLOG_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { isRuntimeCompatBlockError } from '../../runtime/runtime-protocol-compat'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  hasRuntimeRpcErrorCode,
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from '../../runtime/runtime-rpc-client'

export type BacklogClientSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null

const BACKLOG_CALL_TIMEOUT_MS = 30_000

export type BacklogStorageFailedOutcome = {
  status: 'storage-failed'
  stage: BacklogStorageStage
  code: string | null
}

export type BacklogReadFailure =
  | { status: 'capability-unsupported' }
  | { status: 'forbidden' }
  | { status: 'unreachable' }
  | BacklogStorageFailedOutcome

export type BacklogListPageOutcome =
  | {
      status: 'ok'
      rows: BacklogItemSummary[]
      hostView: 'summary' | 'full'
      total: number
      nextCursor: string | null
      quarantinedCount: number
    }
  | BacklogReadFailure

export type BacklogQuarantineSummary = Omit<BacklogQuarantineEntry, 'reason'>

export type BacklogHealthOutcome =
  | {
      status: 'ok'
      report: Omit<BacklogHealthReport, 'quarantined'> & { quarantined: BacklogQuarantineSummary[] }
    }
  | BacklogReadFailure

export type BacklogRecordFailure =
  | { status: 'absent' }
  | { status: 'unreadable'; code: BacklogUnreadableCode }
  | { status: 'schema-too-new'; storedVersion: number }

export type BacklogGetOutcome =
  | { status: 'loaded'; item: BacklogItem }
  | BacklogRecordFailure
  | BacklogReadFailure

export type BacklogAnswer = Record<string, unknown> & { outcome?: unknown }

export type BacklogSendResult =
  | { sent: false; failure: BacklogReadFailure }
  | { sent: true; answer: BacklogAnswer }
  | { sent: true; thrown: unknown }

async function ensureCapability(target: RuntimeClientTarget): Promise<BacklogReadFailure | null> {
  // The local runtime is this build, so it always serves the ledger.
  if (target.kind === 'local') {
    return null
  }
  try {
    const supported = await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      BACKLOG_RUNTIME_CAPABILITY
    )
    return supported ? null : { status: 'capability-unsupported' }
  } catch {
    return { status: 'unreachable' }
  }
}

export async function sendBacklogRequest(
  settings: BacklogClientSettings,
  method: string,
  params?: unknown
): Promise<BacklogSendResult> {
  const target = getActiveRuntimeTarget(settings)
  const refused = await ensureCapability(target)
  if (refused) {
    return { sent: false, failure: refused }
  }
  try {
    const answer = await callRuntimeRpc<unknown>(target, method, params, {
      timeoutMs: BACKLOG_CALL_TIMEOUT_MS
    })
    return answer !== null && typeof answer === 'object'
      ? { sent: true, answer: answer as BacklogAnswer }
      : { sent: true, thrown: answer }
  } catch (error) {
    return { sent: true, thrown: error }
  }
}

export function classifyBacklogHostRefusal(error: unknown): BacklogReadFailure | null {
  if (
    hasRuntimeRpcErrorCode(error, 'method_not_found') ||
    hasRuntimeRpcErrorCode(error, 'capability_unsupported')
  ) {
    return { status: 'capability-unsupported' }
  }
  if (hasRuntimeRpcErrorCode(error, 'forbidden')) {
    return { status: 'forbidden' }
  }
  // A version block is thrown before the request leaves, so nothing was sent.
  return isRuntimeCompatBlockError(error) ? { status: 'unreachable' } : null
}

export function toBacklogStorageFailed(answer: BacklogAnswer): BacklogStorageFailedOutcome {
  return {
    status: 'storage-failed',
    stage: answer.stage as BacklogStorageStage,
    code: typeof answer.code === 'string' ? answer.code : null
  }
}

export function toBacklogRecordFailure(answer: BacklogAnswer): BacklogRecordFailure | null {
  switch (answer.outcome) {
    case 'absent':
      return { status: 'absent' }
    case 'unreadable':
      return { status: 'unreadable', code: answer.code as BacklogUnreadableCode }
    case 'schema-too-new':
      return { status: 'schema-too-new', storedVersion: Number(answer.storedVersion) }
    default:
      return null
  }
}

async function read<T>(
  settings: BacklogClientSettings,
  method: string,
  params: unknown,
  interpret: (answer: BacklogAnswer) => T | null
): Promise<T | BacklogReadFailure> {
  const result = await sendBacklogRequest(settings, method, params)
  if (!result.sent) {
    return result.failure
  }
  if ('thrown' in result) {
    return classifyBacklogHostRefusal(result.thrown) ?? { status: 'unreachable' }
  }
  if (result.answer.outcome === 'storage-failed') {
    return toBacklogStorageFailed(result.answer)
  }
  return interpret(result.answer) ?? { status: 'unreachable' }
}

export function listBacklogPage(
  settings: BacklogClientSettings,
  page: { cursor: string | null; limit: number }
): Promise<BacklogListPageOutcome> {
  const params =
    page.cursor === null
      ? { view: 'summary', limit: page.limit }
      : { view: 'summary', limit: page.limit, cursor: page.cursor }
  return read<BacklogListPageOutcome>(settings, 'backlog.list', params, (answer) => {
    if (answer.outcome !== 'listed' || !Array.isArray(answer.items)) {
      return null
    }
    return {
      status: 'ok',
      rows: (answer.items as BacklogItem[]).map((row) => toBacklogItemSummary(row)),
      // An older host strips the view param and echoes nothing: its rows are full records.
      hostView: answer.view === 'summary' ? 'summary' : 'full',
      total: Number(answer.total),
      nextCursor: typeof answer.nextCursor === 'string' ? answer.nextCursor : null,
      quarantinedCount: Number(answer.quarantinedCount)
    }
  })
}

export function readBacklogHealth(settings: BacklogClientSettings): Promise<BacklogHealthOutcome> {
  return read<BacklogHealthOutcome>(settings, 'backlog.health', undefined, (answer) => {
    if (answer.outcome !== 'opened') {
      return null
    }
    const report = answer as unknown as BacklogHealthReport
    const quarantined = (report.quarantined ?? []).map(({ reason: _reason, ...entry }) => entry)
    return { status: 'ok', report: { ...report, quarantined } }
  })
}

export function getBacklogItem(
  settings: BacklogClientSettings,
  id: string
): Promise<BacklogGetOutcome> {
  return read<BacklogGetOutcome>(settings, 'backlog.get', { id }, (answer) =>
    answer.outcome === 'loaded'
      ? { status: 'loaded', item: answer.record as BacklogItem }
      : toBacklogRecordFailure(answer)
  )
}
