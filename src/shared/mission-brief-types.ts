import type { ExecutionHostId } from './execution-host'

/**
 * The Mission Brief: a projection of a workspace's own mission records (GSD `.planning`, Ralph
 * mission records, git). It stores nothing; every field names what decided it, and a field with no
 * producer answer says so instead of showing an empty or a zero.
 */

export type MissionBriefRequest = {
  hostId: ExecutionHostId
  workspaceKey: string
  /** A workstream under `.planning/workstreams/`; main refuses a name it did not list. */
  workstream?: string
}

/** Raw Ralph mission record fields the brief reads, from `~/.claude/state/gsd-mission-*.json`. */
export type RalphMissionRecord = {
  missionId: string
  state: string
  reason: string
  workstream: string | null
  heartbeatAtMs: number | null
  updatedAtMs: number | null
}

/** What `.planning/STATE.md` records, quoted rather than interpreted. */
export type StateMdRecord = {
  recordedHead: string | null
  /** The `Phase:` line under "Current Position" — prose the frontmatter can disagree with. */
  positionPhase: string | null
  /** `null` = no blockers section exists; `[]` = the section exists and is empty. */
  blockers: string[] | null
  ownerDecisions: string[]
}

export type GitHeadReading =
  | { kind: 'read'; head: string; commitsSinceRecorded: number | null }
  | { kind: 'unreadable' }

/** Everything main read for one workspace. The GSD outputs stay `unknown` until validated. */
export type MissionReadings = {
  workstream: string | null
  inspect: unknown
  roadmap: unknown
  smartEntry: unknown
  stateRecord: StateMdRecord | null
  git: GitHeadReading
  /** Latest record first; only records whose cwd is this workspace. */
  missions: RalphMissionRecord[]
  readAt: number
}

export type MissionStageState = 'proven' | 'claimed' | 'current' | 'future'

export type MissionStage = {
  id: string
  name: string
  goal: string | null
  state: MissionStageState
  /** GSD's verification verdict for the phase, verbatim; `null` = GSD has no directory for it. */
  verification: string | null
  dependsOn: string[]
  /** Dependency text that names something other than a phase (an external condition). */
  externalDependency: string | null
}

export type MissionContradiction =
  | { kind: 'frontier-disagrees'; recorded: string; active: string }
  | { kind: 'claimed-without-verification'; stageId: string; verification: string | null }
  | { kind: 'claimed-with-open-dependency'; stageId: string; dependencyId: string }

export type MissionFreshness =
  | { kind: 'current'; recordedHead: string }
  | { kind: 'stale'; recordedHead: string; head: string; commitsSince: number | null }
  | { kind: 'unknown'; reason: 'no-recorded-head' | 'git-unreadable' }

export type HumanAttentionItem =
  | { source: 'ralph-mission'; missionId: string; reason: string }
  | { source: 'state-md'; text: string }
  | { source: 'gsd-verification'; stageId: string; nextAction: string }

export type AutonomousWork = {
  missionId: string
  reason: string
  /** `null` = the record carries no heartbeat, so liveness is not known. */
  heartbeatAgeMs: number | null
  live: boolean
}

export type MissionSignal = 'needs-you' | 'autonomous' | 'next' | 'unknown'

export type MissionBrief = {
  workstream: string | null
  objective: { kind: 'known'; text: string; partial: boolean } | { kind: 'unknown' }
  stages: MissionStage[]
  frontier: { kind: 'known'; stageId: string; name: string | null; status: string | null } | { kind: 'unknown' }
  lastVerified:
    | { kind: 'verified'; stageId: string; name: string | null }
    | { kind: 'none'; nearest: { stageId: string; verification: string } | null }
  nextAction:
    | { kind: 'known'; label: string; command: string; situation: string }
    | { kind: 'unknown' }
  unlocks: { stageId: string; name: string }[]
  humanAttention: HumanAttentionItem[]
  autonomous: AutonomousWork[]
  blockers: { kind: 'recorded'; lines: string[] } | { kind: 'not-recorded' }
  haltedRun: { missionId: string; reason: string } | null
  contradictions: MissionContradiction[]
  freshness: MissionFreshness
  signal: MissionSignal
  readAt: number
}

export type MissionBriefResult =
  | { status: 'read'; brief: MissionBrief }
  | { status: 'no-mission' }
  | { status: 'choose-workstream'; workstreams: string[] }
  | {
      status: 'unavailable'
      reason: 'remote-host' | 'workspace-unknown' | 'gsd-tools-absent' | 'invalid-request'
    }
  | { status: 'failed'; stage: 'gsd' | 'read'; detail: string }
