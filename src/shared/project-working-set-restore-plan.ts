import type { LiveAgentSessionPresenceWireKind } from './live-agent-session-presence-types'
import {
  classifyRestoreTimeCapability,
  type RestoreTimeClassification,
  type RestoreTimeInputs
} from './project-working-set-restore-time'
import type {
  ProjectWorkingSetManifest,
  WorkingSetRestoreCapability,
  WorkingSetRestorePolicy,
  WorkingSetResumeEvidence
} from './project-working-set-types'

/**
 * What restoring one sealed working set would do, decided before anything changes.
 *
 * Pure: no store, no IPC, no PTY. The caller gathers today's facts; this only projects them onto
 * the manifest. Rows are keyed by the sealed terminal id and each gets a fresh target id, so two
 * rows sharing a label stay two rows and a restored row can never alias a live one.
 */

export type RestorePlanWake =
  /** Listed in the revival order and runnable today. */
  | 'automatic'
  | 'on-open'
  /** Stays dormant until the user explicitly asks for it. */
  | 'explicit-only'

export type RestorePlanPaneBlocker = 'live-elsewhere' | 'presence-unknown'

export type RestorePlanPane = {
  leafId: string
  title: string | null
  restoreTime: RestoreTimeClassification
  /** The sealed provider evidence, handed to the canonical resume path when the pane is opened. */
  resume: WorkingSetResumeEvidence
  /** Whether opening the pane should try the sealed provider session at all. */
  resumeOnOpen: boolean
  presence: LiveAgentSessionPresenceWireKind | 'not-asked'
  blockers: RestorePlanPaneBlocker[]
}

export type RestorePlanEntry = {
  sourceTabId: string
  targetTabId: string
  label: string
  color: string | null
  isPinned: boolean
  launch: ProjectWorkingSetManifest['entries'][number]['launch']
  startupCwd: string | null
  policy: WorkingSetRestorePolicy
  wake: RestorePlanWake
  activeLeafId: string | null
  panes: RestorePlanPane[]
}

export type RestorePlanBlocker =
  /** The target workspace already has tabs of any kind; W4 restores only into an empty one. */
  'current-work-present' | 'scope-mismatch' | 'host-unavailable'

export type RestorePlanSummary = {
  entries: number
  panes: number
  byCapability: Record<WorkingSetRestoreCapability, number>
  /** Panes that would start without the user opening them. */
  autoWake: number
  liveElsewhere: number
  excluded: number
}

export type WorkingSetRestorePlan = {
  workingSetId: string
  label: string | null
  scope: ProjectWorkingSetManifest['scope']
  /** Rail order in target ids; excluded entries never appear. */
  railGroups: string[][]
  /** Revival order in target ids, independent of rail order. */
  revivalOrder: string[]
  activeTabId: string | null
  entries: RestorePlanEntry[]
  /** Sealed but not restored: do-not-restore rows. */
  excludedSourceTabIds: string[]
  blockers: RestorePlanBlocker[]
  summary: RestorePlanSummary
}

export type RestorePlanTarget = {
  executionHostId: string
  ownerKey: string
  /** Terminal and unified tabs (editors, browsers) the workspace holds now. */
  openTabCount: number
  hostAvailability: 'available' | 'unavailable' | 'unknown'
}

export type RestorePlanInputs = RestoreTimeInputs & {
  target: RestorePlanTarget
  /** Keyed `${sourceTabId}:${leafId}`; missing means not asked. */
  presence: Readonly<Record<string, LiveAgentSessionPresenceWireKind>>
  newTabId: () => string
}

const RUNNABLE: ReadonlySet<WorkingSetRestoreCapability> = new Set([
  'exact-resume',
  'restartable',
  'recreate-context'
])

function wakeFor(policy: WorkingSetRestorePolicy): RestorePlanWake {
  if (policy === 'auto-restore') {
    return 'automatic'
  }
  return policy === 'restore-on-open' ? 'on-open' : 'explicit-only'
}

function presenceBlockers(
  presence: LiveAgentSessionPresenceWireKind | 'not-asked',
  resumeOnOpen: boolean
): RestorePlanPaneBlocker[] {
  if (!resumeOnOpen) {
    return []
  }
  if (presence === 'live-elsewhere' || presence === 'multiple-live-owners') {
    return ['live-elsewhere']
  }
  // Why live-here is not clear: a restored pane is new, so "here" can only mean an owner the
  // presence reader matched by a key this plan did not give it.
  return presence === 'no-live-owner' ? [] : ['presence-unknown']
}

export function planWorkingSetRestore(
  manifest: ProjectWorkingSetManifest,
  inputs: RestorePlanInputs
): WorkingSetRestorePlan {
  const { target } = inputs
  const blockers: RestorePlanBlocker[] = []
  if (
    target.executionHostId !== manifest.scope.executionHostId ||
    target.ownerKey !== manifest.scope.ownerKey
  ) {
    blockers.push('scope-mismatch')
  }
  if (target.openTabCount > 0) {
    blockers.push('current-work-present')
  }
  if (target.hostAvailability === 'unavailable') {
    blockers.push('host-unavailable')
  }

  const byCapability: RestorePlanSummary['byCapability'] = {
    'exact-resume': 0,
    restartable: 0,
    'recreate-context': 0,
    'history-only': 0,
    'not-restorable': 0,
    unknown: 0
  }
  const targetIdBySource = new Map<string, string>()
  const entries: RestorePlanEntry[] = []
  const excludedSourceTabIds: string[] = []
  let autoWake = 0
  let liveElsewhere = 0
  let paneCount = 0

  for (const entry of manifest.entries) {
    if (entry.restorePolicy === 'do-not-restore') {
      excludedSourceTabIds.push(entry.tabId)
      continue
    }
    const targetTabId = inputs.newTabId()
    targetIdBySource.set(entry.tabId, targetTabId)
    const wake = wakeFor(entry.restorePolicy)
    const panes = entry.panes.map((pane): RestorePlanPane => {
      const restoreTime = classifyRestoreTimeCapability(entry, pane, inputs)
      // Why unknown too: an unconfirmed resume is still worth attempting when the user opens it;
      // only a proven-deleted conversation is never retried.
      const resumeOnOpen =
        pane.resume.kind === 'provider-session' &&
        (restoreTime.capability === 'exact-resume' ||
          (restoreTime.capability === 'unknown' && restoreTime.captured === 'exact-resume'))
      const presence = inputs.presence[`${entry.tabId}:${pane.leafId}`] ?? 'not-asked'
      const paneBlockers = presenceBlockers(presence, resumeOnOpen)
      byCapability[restoreTime.capability]++
      paneCount++
      if (paneBlockers.includes('live-elsewhere')) {
        liveElsewhere++
      }
      if (
        wake === 'automatic' &&
        RUNNABLE.has(restoreTime.capability) &&
        paneBlockers.length === 0
      ) {
        autoWake++
      }
      return {
        leafId: pane.leafId,
        title: pane.title,
        restoreTime,
        resume: pane.resume,
        resumeOnOpen,
        presence,
        blockers: paneBlockers
      }
    })
    entries.push({
      sourceTabId: entry.tabId,
      targetTabId,
      label: entry.label,
      color: entry.color,
      isPinned: entry.isPinned,
      launch: entry.launch,
      startupCwd: entry.startupCwd,
      policy: entry.restorePolicy,
      wake,
      activeLeafId: entry.activeLeafId,
      panes
    })
  }

  const toTarget = (sourceTabId: string): string => {
    const targetTabId = targetIdBySource.get(sourceTabId)
    if (!targetTabId) {
      // The schema guarantees every rail, revival and active id names a restorable entry.
      throw new Error(`working set ${manifest.workingSetId} names unplanned tab ${sourceTabId}`)
    }
    return targetTabId
  }
  // Why the manifest's own entry order is not used: rail order is its own field and the only source.
  const byTarget = new Map(entries.map((entry) => [entry.targetTabId, entry]))
  const railGroups = manifest.railGroups.map((group) => group.map(toTarget))
  return {
    workingSetId: manifest.workingSetId,
    label: manifest.label,
    scope: manifest.scope,
    railGroups,
    revivalOrder: manifest.revivalOrder.map(toTarget),
    activeTabId: manifest.activeTabId === null ? null : toTarget(manifest.activeTabId),
    entries: railGroups.flat().map((targetTabId) => byTarget.get(targetTabId)!),
    excludedSourceTabIds,
    blockers,
    summary: {
      entries: entries.length,
      panes: paneCount,
      byCapability,
      autoWake,
      liveElsewhere,
      excluded: excludedSourceTabIds.length
    }
  }
}
