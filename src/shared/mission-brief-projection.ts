import {
  parseGsdInspect,
  parseGsdRoadmap,
  parseGsdSmartEntry,
  scopedValue,
  type GsdInspect,
  type GsdSmartEntry
} from './mission-brief-gsd-schema'
import { projectStages } from './mission-brief-stages'
import type {
  AutonomousWork,
  HumanAttentionItem,
  MissionBrief,
  MissionFreshness,
  MissionReadings,
  MissionSignal,
  MissionStage,
  StateMdRecord
} from './mission-brief-types'
import { normalizePhaseId } from './mission-phase-dependencies'

/** A running mission whose heartbeat is older than this is not reported as progressing. */
export const LIVE_HEARTBEAT_MS = 10 * 60_000

function objectiveOf(inspect: GsdInspect | null): MissionBrief['objective'] {
  const milestone = inspect?.milestone
  if (!milestone || milestone.scope === 'unscoped') {
    return { kind: 'unknown' }
  }
  // Why strip: a truncated read can carry the frontmatter's own quoting.
  const text = (milestone.version ?? milestone.name ?? '').replace(/^[\s"'\\]+|[\s"'\\]+$/g, '')
  return text ? { kind: 'known', text, partial: milestone.scope !== 'complete' } : { kind: 'unknown' }
}

function nextActionOf(smart: GsdSmartEntry | null): MissionBrief['nextAction'] {
  if (!smart) {
    return { kind: 'unknown' }
  }
  const action =
    smart.actions.find((candidate) => candidate.id === smart.recommended) ??
    smart.actions.find((candidate) => candidate.recommended === true)
  return action
    ? { kind: 'known', label: action.label, command: action.command, situation: smart.situation }
    : { kind: 'unknown' }
}

function lastVerifiedOf(stages: MissionStage[]): MissionBrief['lastVerified'] {
  const proven = stages.filter((stage) => stage.state === 'proven').at(-1)
  if (proven) {
    return { kind: 'verified', stageId: proven.id, name: proven.name }
  }
  const nearest = stages
    .filter((stage) => stage.verification !== null && stage.verification !== 'missing')
    .at(-1)
  return {
    kind: 'none',
    nearest: nearest?.verification ? { stageId: nearest.id, verification: nearest.verification } : null
  }
}

/** Phases the frontier makes reachable: it is their last unproven dependency and nothing external remains. */
function unlocksOf(stages: MissionStage[], frontierId: string | null): MissionBrief['unlocks'] {
  if (!frontierId) {
    return []
  }
  const proven = new Set(stages.filter((stage) => stage.state === 'proven').map((stage) => stage.id))
  return stages
    .filter(
      (stage) =>
        stage.state !== 'proven' &&
        stage.externalDependency === null &&
        stage.dependsOn.includes(frontierId) &&
        stage.dependsOn.every((id) => id === frontierId || proven.has(id))
    )
    .map((stage) => ({ stageId: stage.id, name: stage.name }))
}

function freshnessOf(record: StateMdRecord | null, git: MissionReadings['git']): MissionFreshness {
  const recordedHead = record?.recordedHead ?? null
  if (!recordedHead) {
    return { kind: 'unknown', reason: 'no-recorded-head' }
  }
  if (git.kind !== 'read') {
    return { kind: 'unknown', reason: 'git-unreadable' }
  }
  return git.head === recordedHead
    ? { kind: 'current', recordedHead }
    : { kind: 'stale', recordedHead, head: git.head, commitsSince: git.commitsSinceRecorded }
}

function signalOf(
  human: HumanAttentionItem[],
  autonomous: AutonomousWork[],
  next: MissionBrief['nextAction']
): MissionSignal {
  if (human.length > 0) {
    return 'needs-you'
  }
  if (autonomous.some((work) => work.live)) {
    return 'autonomous'
  }
  return next.kind === 'known' ? 'next' : 'unknown'
}

export function projectMissionBrief(readings: MissionReadings, now: number): MissionBrief {
  const inspect = parseGsdInspect(readings.inspect)
  const roadmap = parseGsdRoadmap(readings.roadmap)
  const smart = parseGsdSmartEntry(readings.smartEntry)

  const activeRaw = scopedValue(inspect?.active?.phase)
  const activeId = activeRaw ? normalizePhaseId(activeRaw) : null
  const { stages, contradictions, humanVerification } = projectStages(roadmap, inspect, activeId)
  const frontierStage = stages.find((stage) => stage.id === activeId)

  const positionId = readings.stateRecord?.positionPhase
    ? normalizePhaseId(readings.stateRecord.positionPhase)
    : null
  if (activeId && positionId && positionId !== activeId) {
    contradictions.unshift({ kind: 'frontier-disagrees', recorded: positionId, active: activeId })
  }

  // Why only the latest record: older ones on the same path are history, not current state.
  const latest = readings.missions[0] ?? null
  const human: HumanAttentionItem[] = [
    ...(latest?.state === 'BLOCKED'
      ? [{ source: 'ralph-mission' as const, missionId: latest.missionId, reason: latest.reason }]
      : []),
    ...(readings.stateRecord?.ownerDecisions ?? []).map((text) => ({
      source: 'state-md' as const,
      text
    })),
    ...humanVerification.map((item) => ({ source: 'gsd-verification' as const, ...item }))
  ]
  const autonomous: AutonomousWork[] =
    latest?.state === 'RUNNING'
      ? [
          {
            missionId: latest.missionId,
            reason: latest.reason,
            heartbeatAgeMs: latest.heartbeatAtMs === null ? null : Math.max(0, now - latest.heartbeatAtMs),
            live: latest.heartbeatAtMs !== null && now - latest.heartbeatAtMs < LIVE_HEARTBEAT_MS
          }
        ]
      : []
  const nextAction = nextActionOf(smart)
  const blockers = readings.stateRecord?.blockers

  return {
    workstream: readings.workstream,
    objective: objectiveOf(inspect),
    stages,
    frontier: activeId
      ? {
          kind: 'known',
          stageId: activeId,
          name: frontierStage?.name ?? null,
          status: scopedValue(inspect?.active?.status)
        }
      : { kind: 'unknown' },
    lastVerified: lastVerifiedOf(stages),
    nextAction,
    unlocks: unlocksOf(stages, activeId),
    humanAttention: human,
    autonomous,
    blockers: blockers ? { kind: 'recorded', lines: blockers } : { kind: 'not-recorded' },
    haltedRun:
      latest?.state === 'HALTED' ? { missionId: latest.missionId, reason: latest.reason } : null,
    contradictions,
    freshness: freshnessOf(readings.stateRecord, readings.git),
    signal: signalOf(human, autonomous, nextAction),
    readAt: readings.readAt
  }
}
