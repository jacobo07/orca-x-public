import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '@/store/types'
import { planWorkingSetRestore } from '../../../shared/project-working-set-restore-plan'
import type { WorkingSetRestoreEvidence } from '../../../shared/project-working-set-store-types'
import {
  leafId,
  representativeManifest,
  SHARED_LABEL
} from '../../../shared/project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { createTestStore, makeTab, makeWorktree } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'

const holder = vi.hoisted(() => ({ store: null as null | { getState: () => unknown } }))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
// The parking predicate reads the app store; point it at this suite's store.
vi.mock('@/store', () => ({
  useAppStore: { getState: () => holder.store!.getState() }
}))

const mockApi = createStoreSessionMockApi()
const spawn = vi.fn()
;(mockApi.pty as Record<string, unknown>).spawn = spawn

const { applyWorkingSetRestorePlan, countWorkspaceOpenTabs } =
  await import('./project-working-set-apply')
const { canWatcherCoverParkedTerminalTab } =
  await import('../components/terminal-pane/terminal-parked-tab-watchers')
const { planColdActivationTabDeferral, shouldMountBackgroundWorktreeTab } =
  await import('../components/terminal/background-terminal-worktree-mount')

const OWNER = 'repo-1::C:/work/orca'
const PROFILES = [{ id: 'agent:claude' }, { id: 'agent:codex' }, { id: 'shell:wsl.exe' }]

function evidenceFor(manifest: ProjectWorkingSetManifest): WorkingSetRestoreEvidence {
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

function setup() {
  const store = createTestStore()
  holder.store = store
  store.setState({
    repos: [
      { id: 'repo-1', path: 'C:/work/orca', displayName: 'Orca', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: OWNER, repoId: 'repo-1', path: 'C:/work/orca' })]
    },
    activeWorktreeId: 'repo-1::C:/work/other'
  } as Partial<AppState>)
  let next = 0
  const deps = {
    store,
    now: () => 1_000,
    newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
  }
  const plan = (manifest: ProjectWorkingSetManifest = representativeManifest()) =>
    planWorkingSetRestore(manifest, {
      evidence: evidenceFor(manifest),
      launchProfiles: PROFILES,
      target: {
        executionHostId: manifest.scope.executionHostId,
        ownerKey: manifest.scope.ownerKey,
        openTabCount: countWorkspaceOpenTabs(store.getState(), manifest.scope.ownerKey),
        hostAvailability: 'available'
      },
      presence: {
        [`tab-a:${leafId(1)}`]: 'no-live-owner',
        [`tab-b:${leafId(2)}`]: 'no-live-owner'
      },
      newTabId: deps.newId
    })
  return { store, deps, plan }
}

describe('applyWorkingSetRestorePlan', () => {
  beforeEach(() => {
    spawn.mockClear()
  })

  it('rebuilds the sealed rail in an empty workspace without starting anything', () => {
    const { store, deps, plan } = setup()
    const restore = plan()
    const result = applyWorkingSetRestorePlan(restore, deps)
    expect(result).toMatchObject({ status: 'applied', resumeOnOpen: 2 })
    const s = store.getState()
    const rows = s.tabsByWorktree[OWNER]
    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.ptyId === null)).toBe(true)
    expect(rows.filter((row) => row.title === SHARED_LABEL)).toHaveLength(2)
    expect(s.groupsByWorktree[OWNER].map((group) => group.tabOrder)).toEqual(restore.railGroups)
    expect(s.activeTabIdByWorktree[OWNER]).toBe(restore.activeTabId)
    expect(s.activeWorktreeId).toBe('repo-1::C:/work/other')
    expect(s.pendingReconnectWorktreeIds).not.toContain(OWNER)
    expect(Object.values(s.ptyIdsByTabId).flat()).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('leaves each sealed provider session as a lazy resume handle on its own pane', () => {
    const { store, deps, plan } = setup()
    const restore = plan()
    applyWorkingSetRestorePlan(restore, deps)
    const target = (source: string) =>
      restore.entries.find((entry) => entry.sourceTabId === source)!.targetTabId
    const records = Object.values(store.getState().sleepingAgentSessionsByPaneKey)
    expect(records.map((record) => record.paneKey).sort()).toEqual(
      [`${target('tab-a')}:${leafId(1)}`, `${target('tab-b')}:${leafId(2)}`].sort()
    )
    expect(records.map((record) => record.providerSession.id).sort()).toEqual([
      'claude-session-a',
      'claude-session-b'
    ])
    expect(records.every((r) => r.restoreOnTabOpenOnly && r.origin === 'worktree-sleep')).toBe(true)
    expect(records.every((r) => r.worktreeId === OWNER && r.state === 'done')).toBe(true)
  })

  it('leaves no resume handle for a session already live elsewhere', () => {
    const { store, deps } = setup()
    const manifest = representativeManifest()
    const restore = planWorkingSetRestore(manifest, {
      evidence: evidenceFor(manifest),
      launchProfiles: PROFILES,
      target: {
        executionHostId: 'local',
        ownerKey: OWNER,
        openTabCount: 0,
        hostAvailability: 'available'
      },
      presence: {
        [`tab-a:${leafId(1)}`]: 'live-elsewhere',
        [`tab-b:${leafId(2)}`]: 'no-live-owner'
      },
      newTabId: deps.newId
    })
    expect(applyWorkingSetRestorePlan(restore, deps)).toMatchObject({
      status: 'applied',
      resumeOnOpen: 1
    })
    const ids = Object.values(store.getState().sleepingAgentSessionsByPaneKey).map(
      (record) => record.providerSession.id
    )
    expect(ids).toEqual(['claude-session-b'])
    // The row itself is still restored: composition is not materialization.
    expect(store.getState().tabsByWorktree[OWNER]).toHaveLength(5)
  })

  it('treats a retry as the same restore, not a second copy', () => {
    const { store, deps, plan } = setup()
    const restore = plan()
    applyWorkingSetRestorePlan(restore, deps)
    const before = store.getState().tabsByWorktree[OWNER]
    expect(applyWorkingSetRestorePlan(restore, deps)).toEqual({
      status: 'already-applied',
      workingSetId: restore.workingSetId
    })
    // A fresh plan of the same working set mints new ids and still recognises it.
    const replanned = plan()
    expect(replanned.blockers).toEqual(['current-work-present'])
    expect(store.getState().tabsByWorktree[OWNER]).toBe(before)
  })

  it('changes nothing when tabs appeared after the plan was made', () => {
    const { store, deps, plan } = setup()
    const restore = plan()
    store.setState({
      tabsByWorktree: { [OWNER]: [makeTab({ id: 'late-tab', worktreeId: OWNER })] }
    })
    expect(applyWorkingSetRestorePlan(restore, deps)).toEqual({ status: 'target-changed' })
    expect(store.getState().tabsByWorktree[OWNER].map((tab) => tab.id)).toEqual(['late-tab'])
  })

  it('refuses a plan that carries a blocker', () => {
    const { deps, plan } = setup()
    const restore = { ...plan(), blockers: ['host-unavailable' as const] }
    expect(applyWorkingSetRestorePlan(restore, deps)).toEqual({
      status: 'refused',
      blockers: ['host-unavailable']
    })
  })

  it('rolls the workspace back when the second half of the replace fails', () => {
    const { store, deps, plan } = setup()
    const restore = plan()
    const original = store.getState().hydrateTabsSession
    let calls = 0
    store.setState({
      hydrateTabsSession: (...args: Parameters<typeof original>) => {
        calls++
        if (calls === 1) {
          throw new Error('injected')
        }
        original(...args)
      }
    })
    expect(applyWorkingSetRestorePlan(restore, deps)).toMatchObject({
      status: 'failed',
      stage: 'hydrate',
      rolledBack: true
    })
    const s = store.getState()
    expect(countWorkspaceOpenTabs(s, OWNER)).toBe(0)
    expect(Object.keys(s.sleepingAgentSessionsByPaneKey)).toEqual([])
  })

  it('reports and undoes a replace that silently dropped the rows', () => {
    const { store, deps } = setup()
    const manifest = representativeManifest()
    manifest.scope.ownerKey = 'repo-1::C:/work/unknown'
    const restore = planWorkingSetRestore(manifest, {
      evidence: evidenceFor(manifest),
      launchProfiles: PROFILES,
      target: {
        executionHostId: 'local',
        ownerKey: manifest.scope.ownerKey,
        openTabCount: 0,
        hostAvailability: 'available'
      },
      presence: {},
      newTabId: deps.newId
    })
    expect(applyWorkingSetRestorePlan(restore, deps)).toMatchObject({
      status: 'failed',
      stage: 'verify',
      rolledBack: true
    })
    expect(store.getState().tabsByWorktree[manifest.scope.ownerKey]).toBeUndefined()
  })

  it('restores a folder working set into its folder workspace', () => {
    const { store, deps } = setup()
    const owner = folderWorkspaceKey('fw-1')
    store.setState({
      folderWorkspaces: [
        { id: 'fw-1', projectGroupId: 'pg-1', folderPath: 'C:/notes', executionHostId: 'local' }
      ]
    } as unknown as Partial<AppState>)
    const manifest = representativeManifest()
    manifest.scope = {
      executionHostId: 'local',
      ownerKey: owner,
      location: { kind: 'folder-workspace', folderWorkspaceId: 'fw-1', folderPath: 'C:/notes' }
    }
    const restore = planWorkingSetRestore(manifest, {
      evidence: evidenceFor(manifest),
      launchProfiles: PROFILES,
      target: {
        executionHostId: 'local',
        ownerKey: owner,
        openTabCount: 0,
        hostAvailability: 'available'
      },
      presence: {},
      newTabId: deps.newId
    })
    expect(applyWorkingSetRestorePlan(restore, deps)).toMatchObject({ status: 'applied' })
    expect(store.getState().tabsByWorktree[owner]).toHaveLength(5)
  })
})

/**
 * Characterization, not a goal: opening the workspace would mount every restored row.
 *
 * A restored row has no PTY, so parked byte watchers cannot cover it, so cold activation does not
 * defer it, so it mounts — and a mount of a pane with a sleeping record cold-restores and resumes.
 * This is the W6 boundary: the rail comes back without processes, and activation brings them all.
 */
describe('restored rows at workspace activation (W6 boundary)', () => {
  function mountDecision(tabIds: string[], deferrable: (tabId: string) => boolean) {
    const restrictions = new Map<string, ReadonlySet<string>>()
    planColdActivationTabDeferral({
      restrictions,
      deferredMountTabIdsByWorktree: new Map(),
      worktreeId: OWNER,
      allTabIds: tabIds,
      isTabLive: () => false,
      isTabDeferrable: deferrable,
      immediateTabIds: new Set([tabIds[0]])
    })
    const restricted = restrictions.get(OWNER) ?? null
    return tabIds.filter((tabId) => shouldMountBackgroundWorktreeTab(restricted, tabId))
  }

  it('mounts every restored row, because none can be covered while parked', () => {
    const { store, deps, plan } = setup()
    applyWorkingSetRestorePlan(plan(), deps)
    const rows = store.getState().tabsByWorktree[OWNER]
    const covered = rows.filter((row) => canWatcherCoverParkedTerminalTab(OWNER, row))
    expect(covered).toEqual([])
    const ids = rows.map((row) => row.id)
    expect(mountDecision(ids, (id) => covered.some((row) => row.id === id))).toEqual(ids)
  })

  it('positive control: coverable rows would stay unmounted past the first', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `tab-${index}`)
    expect(mountDecision(ids, () => true)).toEqual(['tab-0'])
  })
})
