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
  MissionMilestone,
  MissionReadings,
  MissionRecordRole,
  MissionSignal,
  MissionStage,
  ProjectGoalGap,
  StateMdRecord
} from './mission-brief-types'
import { normalizePhaseId } from './mission-phase-dependencies'

/** A running mission whose heartbeat is older than this is not reported as progressing. */
export const LIVE_HEARTBEAT_MS = 10 * 60_000

function milestoneOf(inspect: GsdInspect | null): MissionMilestone {
  const milestone = inspect?.milestone
  if (!milestone || milestone.scope === 'unscoped') {
    return { kind: 'unknown' }
  }
  // Why strip: a truncated read can carry the frontmatter's own quoting.
  const text = (milestone.version ?? milestone.name ?? '').replace(/^[\s"'\\]+|[\s"'\\]+$/g, '')
  return text
    ? { kind: 'known', text, partial: milestone.scope !== 'complete' }
    : { kind: 'unknown' }
}

function objectiveOf(
  readings: MissionReadings,
  milestone: MissionMilestone
): MissionBrief['objective'] {
  const { projectFile, projectRecord } = readings
  if (projectFile && projectRecord?.whatThisIs) {
    const text = projectRecord.whatThisIs
    return { kind: 'known', source: 'project-md', section: 'what-this-is', text, file: projectFile }
  }
  if (projectFile && projectRecord?.coreValue) {
    const text = projectRecord.coreValue
    return { kind: 'known', source: 'project-md', section: 'core-value', text, file: projectFile }
  }
  const projectGap: ProjectGoalGap = !projectFile
    ? 'absent'
    : projectRecord
      ? 'no-goal-section'
      : 'unreadable'
  return milestone.kind === 'known'
    ? {
        kind: 'known',
        source: 'milestone',
        text: milestone.text,
        partial: milestone.partial,
        projectGap
      }
    : { kind: 'unknown', projectGap }
}

const ROLE_BY_NAME: Record<string, MissionRecordRole> = {
  'PROJECT.md': 'project',
  'STATE.md': 'state',
  'ROADMAP.md': 'roadmap',
  'REQUIREMENTS.md': 'requirements',
  'config.json': 'config'
}

function recordRole(file: string): MissionRecordRole {
  const segments = file.split('/')
  const byName = ROLE_BY_NAME[segments.at(-1) ?? '']
  if (byName) {
    return byName
  }
  if (segments.includes('phases')) {
    return 'phase'
  }
  return segments.includes('research') ? 'research' : 'other'
}

function recordsOf(readings: MissionReadings): MissionBrief['records'] {
  if (readings.recordFiles.kind === 'unreadable') {
    return { kind: 'unreadable' }
  }
  const read = new Set([readings.stateFile, readings.projectFile])
  return {
    kind: 'listed',
    files: readings.recordFiles.files.map((file) => ({
      path: file,
      role: recordRole(file),
      readByOrca: read.has(file)
    })),
    truncated: readings.recordFiles.truncated
  }
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
  const proven = stages.findLast((stage) => stage.state === 'proven')
  if (proven) {
    return { kind: 'verified', stageId: proven.id, name: proven.name }
  }
  const nearest = stages.findLast(
    (stage) => stage.verification !== null && stage.verification !== 'missing'
  )
  return {
    kind: 'none',
    nearest: nearest?.verification
      ? { stageId: nearest.id, verification: nearest.verification }
      : null
  }
}

/** Phases the frontier makes reachable: it is their last unproven dependency and nothing external remains. */
function unlocksOf(stages: MissionStage[], frontierId: string | null): MissionBrief['unlocks'] {
  if (!frontierId) {
    return []
  }
  const proven = new Set(
    stages.filter((stage) => stage.state === 'proven').map((stage) => stage.id)
  )
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
            heartbeatAgeMs:
              latest.heartbeatAtMs === null ? null : Math.max(0, now - latest.heartbeatAtMs),
            live: latest.heartbeatAtMs !== null && now - latest.heartbeatAtMs < LIVE_HEARTBEAT_MS
          }
        ]
      : []
  const nextAction = nextActionOf(smart)
  const blockers = readings.stateRecord?.blockers
  const milestone = milestoneOf(inspect)

  return {
    workstream: readings.workstream,
    stateFile: readings.stateFile,
    objective: objectiveOf(readings, milestone),
    milestone,
    records: recordsOf(readings),
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
