/*
 * Resource curve of the logical dimension (Resource Elasticity R3): what N remembered rows cost in
 * control-plane state, through the real capture, plan and apply functions.
 *
 * Load-independent by construction — every figure is a count or a serialized length, so it needs no
 * host and no median. It measures store-altitude state, never process bytes: see the Dormant Row
 * State Footprint definition in docs/reference/resource-density-lab.md.
 */
import type { AppState } from '@/store/types'
import { planWorkingSetRestore } from '../../../shared/project-working-set-restore-plan'
import type { WorkingSetRestoreEvidence } from '../../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import { decideTerminalTabMount } from '../components/terminal/background-terminal-worktree-mount'
import { applyWorkingSetRestorePlan, countWorkspaceOpenTabs } from './project-working-set-apply'
import { projectWorkingSetFromState } from './project-working-set-capture'

export const FOOTPRINT_OWNER = 'repo-1::C:/work/orca'
export const FOOTPRINT_PROFILES = [{ id: 'agent:claude' }, { id: 'shell:pwsh.exe' }]
/** Rows per rail group, so the group projection is exercised rather than a single flat list. */
const GROUP_SIZE = 8

export type DormantRowFootprintPoint = {
  rows: number
  manifestBytes: number
  /** Store entries the restored rail installs: rows, unified tabs, group members, layouts, records. */
  storeObjects: number
  sleepingRecords: number
  workspaceStateBytes: number
  /**
   * What the real mount authority answers for each restored row, with no render restriction in
   * force — so only dormancy can hold a row back. `wouldMount` must stay 0: a mount is a PTY spawn
   * and, with a sleeping record, a resume.
   *
   * Not `ptyId`: hydration normalizes that field to null whatever the payload carried, so reading
   * it can only ever report zero and a materialization mutation survives it.
   */
  wouldMount: number
  dormantRows: number
}

type StoreLike = { getState: () => AppState; setState: (partial: Partial<AppState>) => void }

/**
 * The shared fixture's `leafId` repeats a digit, so it only yields a valid UUID for n <= 9 and the
 * capture refuses `invalid-pane-identity` above it. A scale harness needs one that holds at 100.
 */
const leafId = (n: number): string =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const paneKey = (tabId: string, n: number): string => `${tabId}:${leafId(n)}`

/** Every second row carries a resumable agent, so both resume-evidence branches are in the curve. */
const isAgentRow = (index: number): boolean => index % 2 === 0

function railState(rows: number, groupSize: number): Record<string, unknown> {
  const tabs: unknown[] = []
  const unified: unknown[] = []
  const groups: { id: string; tabOrder: string[] }[] = []
  const layouts: Record<string, unknown> = {}
  const agentStatus: Record<string, unknown> = {}
  for (let index = 0; index < rows; index += 1) {
    const tabId = `t${index}`
    const leaf = index + 1
    tabs.push({
      id: tabId,
      ptyId: null,
      worktreeId: FOOTPRINT_OWNER,
      title: 'pwsh',
      customTitle: `Row ${index}`,
      color: null,
      sortOrder: index,
      createdAt: 0,
      launchAgent: isAgentRow(index) ? 'claude' : null
    })
    unified.push({ id: `u${index}`, entityId: tabId, contentType: 'terminal' })
    const groupIndex = Math.floor(index / groupSize)
    ;(groups[groupIndex] ??= { id: `g${groupIndex}`, tabOrder: [] }).tabOrder.push(`u${index}`)
    layouts[tabId] = {
      root: { type: 'leaf', leafId: leafId(leaf) },
      activeLeafId: leafId(leaf),
      expandedLeafId: null
    }
    if (isAgentRow(index)) {
      agentStatus[paneKey(tabId, leaf)] = {
        agentType: 'claude',
        providerSession: { key: 'session_id', id: `claude-session-${index}` }
      }
    }
  }
  return {
    settings: { tabAutoGenerateTitle: false },
    tabsByWorktree: { [FOOTPRINT_OWNER]: tabs },
    unifiedTabsByWorktree: { [FOOTPRINT_OWNER]: unified },
    groupsByWorktree: { [FOOTPRINT_OWNER]: groups },
    activeTabIdByWorktree: { [FOOTPRINT_OWNER]: 't0' },
    terminalLayoutsByTabId: layouts,
    agentStatusByPaneKey: agentStatus,
    sleepingAgentSessionsByPaneKey: {},
    retainedAgentsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    folderWorkspaces: []
  }
}

/**
 * Capture N rows through the real producer. Throws rather than returning a guessed manifest.
 *
 * `groupSize` exists because a source rail with ONE group cannot express a claim about group shape:
 * a mutation flattening the rail is indistinguishable from correct behaviour against it.
 */
export function captureRail(
  rows: number,
  workingSetId: string,
  groupSize: number = GROUP_SIZE
): ProjectWorkingSetManifest {
  const result = projectWorkingSetFromState(railState(rows, groupSize) as unknown as AppState, {
    ownerKey: FOOTPRINT_OWNER,
    label: null,
    workingSetId,
    createdAt: 1_789_000_000_000
  })
  if (result.status !== 'captured') {
    throw new Error(`capture refused at ${rows} rows: ${result.reason} — ${result.detail}`)
  }
  return result.manifest
}

/** Restore-time evidence that confirms every sealed fact, so capability is never the variable. */
export function evidenceFor(manifest: ProjectWorkingSetManifest): WorkingSetRestoreEvidence {
  return {
    location: 'present',
    startupCwdByTabId: {},
    panes: Object.fromEntries(
      manifest.entries.flatMap((entry) =>
        entry.panes.map((pane) => [
          `${entry.tabId}:${pane.leafId}`,
          {
            sealedScrollback: 'absent' as const,
            transcript: pane.resume.kind === 'provider-session' ? ('present' as const) : null
          }
        ])
      )
    )
  }
}

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length

function readFootprint(state: AppState, rows: number, manifest: ProjectWorkingSetManifest) {
  const railRows = state.tabsByWorktree[FOOTPRINT_OWNER] ?? []
  const unified = state.unifiedTabsByWorktree[FOOTPRINT_OWNER] ?? []
  const groups = state.groupsByWorktree[FOOTPRINT_OWNER] ?? []
  const tabIds = new Set(railRows.map((row) => row.id))
  const layouts = Object.entries(state.terminalLayoutsByTabId ?? {}).filter(([id]) =>
    tabIds.has(id)
  )
  const records = Object.entries(state.sleepingAgentSessionsByPaneKey ?? {}).filter(([key]) =>
    tabIds.has(key.slice(0, key.indexOf(':')))
  )
  const decisions = railRows.map((row) => decideTerminalTabMount(null, row))
  return {
    rows,
    manifestBytes: byteLength(manifest),
    storeObjects:
      railRows.length +
      unified.length +
      groups.reduce((total, group) => total + group.tabOrder.length, 0) +
      layouts.length +
      records.length,
    sleepingRecords: records.length,
    workspaceStateBytes: byteLength({
      rows: railRows,
      unified,
      groups,
      layouts,
      records
    }),
    wouldMount: decisions.filter((decision) => decision === 'mount').length,
    dormantRows: decisions.filter((decision) => decision === 'dormant').length
  } satisfies DormantRowFootprintPoint
}

/**
 * One point of the curve for an already-built manifest: plan the restore against an empty
 * workspace, apply it, and read what the restored rail holds. Used by the scale-clone seed, whose
 * manifest comes from the real producer rather than from `captureRail`.
 */
export function measureClonedFootprint(
  manifest: ProjectWorkingSetManifest,
  store: StoreLike,
  newId: () => string
): DormantRowFootprintPoint {
  const plan = planWorkingSetRestore(manifest, {
    evidence: evidenceFor(manifest),
    launchProfiles: FOOTPRINT_PROFILES,
    target: {
      executionHostId: manifest.scope.executionHostId,
      ownerKey: manifest.scope.ownerKey,
      openTabCount: countWorkspaceOpenTabs(store.getState(), FOOTPRINT_OWNER),
      hostAvailability: 'available'
    },
    presence: Object.fromEntries(
      manifest.entries.flatMap((entry) =>
        entry.panes.map((pane) => [`${entry.tabId}:${pane.leafId}`, 'no-live-owner' as const])
      )
    ),
    newTabId: newId
  })
  const result = applyWorkingSetRestorePlan(plan, { store, now: () => 1_000, newId })
  if (result.status !== 'applied') {
    throw new Error(`apply refused at ${manifest.entries.length} rows: ${JSON.stringify(result)}`)
  }
  return readFootprint(store.getState(), manifest.entries.length, manifest)
}

/**
 * One point of the curve: capture N rows, plan the restore against an empty workspace, apply it,
 * and read what the restored rail holds. The caller owns the (empty) target store.
 */
export function measureDormantRowFootprint(
  rows: number,
  store: StoreLike,
  newId: () => string
): DormantRowFootprintPoint {
  const manifest = captureRail(rows, `00000000-0000-4000-8000-${String(rows).padStart(12, '0')}`)
  return measureClonedFootprint(manifest, store, newId)
}
