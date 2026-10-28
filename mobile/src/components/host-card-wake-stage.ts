import { composeWakeProgress, type HostWakeStageRecord } from '../../../src/shared/host-wake'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'

type WakeStage = HostWakeStageRecord['stage']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Why: the broker's clock is not the phone's, so every readable record is placed at the phone-observed reply.
export function rebaseBrokerStages(brokerStages: unknown, repliedAt: number): unknown {
  if (!Array.isArray(brokerStages)) {
    return brokerStages
  }
  return brokerStages.map((record: unknown) =>
    isRecord(record) && typeof record.observedAt === 'number' && Number.isFinite(record.observedAt)
      ? { ...record, observedAt: repliedAt }
      : record
  )
}

// Why: only the target's answer on a connection made after the press, observed after the reply, is this wake's.
export function targetAnswerAfterPress(input: {
  pressedAt: number
  repliedAt: number
  snapshot: HomeHostStatusSnapshot | undefined
  lastConnectedAt: number | null
}): { observedAt: number; graphStatus?: string } | null {
  const { snapshot, lastConnectedAt } = input
  if (snapshot === undefined || lastConnectedAt === null || !isRecord(snapshot.result)) {
    return null
  }
  const afterPress =
    lastConnectedAt > input.pressedAt &&
    snapshot.observedAt >= lastConnectedAt &&
    snapshot.observedAt > input.repliedAt
  if (!afterPress) {
    return null
  }
  const graphStatus = snapshot.result.graphStatus
  return typeof graphStatus === 'string'
    ? { observedAt: snapshot.observedAt, graphStatus }
    : { observedAt: snapshot.observedAt }
}

// Why a rank, not array order: the order a broker lists its records in is not evidence order.
const STAGE_RANK: Record<WakeStage, number> = {
  requested: 1,
  authorized: 2,
  'packet-send-failed': 3,
  'packet-sent': 4,
  'host-announced': 5,
  'runtime-ready': 6
}

export function furthestWakeStage(records: readonly HostWakeStageRecord[]): WakeStage | null {
  let furthest: WakeStage | null = null
  for (const record of records) {
    if (furthest === null || STAGE_RANK[record.stage] > STAGE_RANK[furthest]) {
      furthest = record.stage
    }
  }
  return furthest
}

type WakeAttemptEvidence = {
  pressedAt: number
  repliedAt: number | null
  refusalCode: string | null
  brokerStages: unknown
}

// Why one composition: the card, its focus re-read and attempt pruning must agree on how far a wake got.
export function wakeAttemptFurthestStage(
  attempt: WakeAttemptEvidence,
  snapshot: HomeHostStatusSnapshot | undefined,
  lastConnectedAt: number | null
): WakeStage | null {
  const { repliedAt } = attempt
  if (repliedAt === null || attempt.refusalCode !== null) {
    return null
  }
  const progress = composeWakeProgress(
    rebaseBrokerStages(attempt.brokerStages, repliedAt),
    targetAnswerAfterPress({ pressedAt: attempt.pressedAt, repliedAt, snapshot, lastConnectedAt })
  )
  return furthestWakeStage(progress)
}

export function isTargetObservedStage(stage: WakeStage | null): boolean {
  return stage === 'host-announced' || stage === 'runtime-ready'
}

// Why: the target's own answer outranks any read; wake_unknown (record forgotten) keeps what the broker saw.
export function statusReadHidesStage(
  stage: WakeStage,
  statusReadCode: string | undefined
): boolean {
  return (
    !isTargetObservedStage(stage) &&
    statusReadCode !== undefined &&
    statusReadCode !== 'wake_unknown'
  )
}
