import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '@/store/types'
import type { WorkingSetRestoreEvidence } from '../../../shared/project-working-set-store-types'
import { leafId, representativeManifest } from '../../../shared/project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import type { HostTranslationRequest } from '../../../shared/project-working-set-host-translation'
import type { ProjectHostSetup } from '../../../shared/project-types'
import { createTestStore, makeTab, makeWorktree } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import type { WorkingSetStoreBridge } from './project-working-set-client'
import type { WorkingSetRestoreDeps } from './project-working-set-restore'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

createStoreSessionMockApi()
const { previewWorkingSetRestore, restoreWorkingSet } =
  await import('./project-working-set-restore')

const OWNER = 'repo-1::C:/work/orca'
const scope = { executionHostId: 'local' as const, ownerKey: OWNER }
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

function setup(
  overrides: Partial<WorkingSetRestoreDeps> & { bridge?: WorkingSetStoreBridge } = {}
) {
  const store = createTestStore()
  store.setState({
    repos: [
      { id: 'repo-1', path: 'C:/work/orca', displayName: 'Orca', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: OWNER, repoId: 'repo-1', path: 'C:/work/orca' })]
    }
  } as Partial<AppState>)
  const manifest = representativeManifest()
  const bridge: WorkingSetStoreBridge = {
    save: vi.fn(),
    list: vi.fn(),
    read: vi.fn(async () => ({ status: 'valid', manifest })),
    probeRestoreEvidence: vi.fn(async () => ({
      status: 'probed',
      workingSetId: manifest.workingSetId,
      evidence: evidenceFor(manifest)
    }))
  }
  let next = 0
  const readPresence = vi.fn(async () => ({
    kind: 'no-live-owner' as const,
    liveElsewhere: [],
    ownersRevision: 'r1',
    unknownCount: 0,
    staleCount: 0
  }))
  const deps: WorkingSetRestoreDeps = {
    store,
    bridge,
    readPresence,
    now: () => 1,
    newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    ...overrides
  }
  const request = { scope, workingSetId: manifest.workingSetId, launchProfiles: PROFILES }
  return { store, deps, request, bridge, readPresence }
}

describe('restoreWorkingSet', () => {
  it('reads, probes, asks presence for provider panes only, plans and applies', async () => {
    const { store, deps, request, readPresence } = setup()
    const outcome = await restoreWorkingSet(request, deps)
    expect(outcome).toMatchObject({ status: 'planned', applied: { status: 'applied' } })
    expect(readPresence).toHaveBeenCalledTimes(2)
    expect(store.getState().tabsByWorktree[OWNER]).toHaveLength(5)
  })

  it('changes nothing when the working set cannot be read', async () => {
    const { store, deps, request } = setup()
    deps.bridge = { ...deps.bridge, read: vi.fn(async () => ({ status: 'missing' })) }
    expect(await restoreWorkingSet(request, deps)).toEqual({
      status: 'unreadable',
      read: { status: 'missing' }
    })
    expect(store.getState().tabsByWorktree[OWNER]).toBeUndefined()
  })

  it('plans against the workspace as it is after the last await', async () => {
    const { store, deps, request } = setup()
    deps.readPresence = vi.fn(async () => {
      store.setState({
        tabsByWorktree: { [OWNER]: [makeTab({ id: 'opened-meanwhile', worktreeId: OWNER })] }
      })
      return {
        kind: 'no-live-owner' as const,
        liveElsewhere: [],
        ownersRevision: 'r1',
        unknownCount: 0,
        staleCount: 0
      }
    })
    const outcome = await restoreWorkingSet(request, deps)
    expect(outcome).toMatchObject({
      applied: { status: 'refused', blockers: ['current-work-present'] }
    })
    expect(store.getState().tabsByWorktree[OWNER].map((tab) => tab.id)).toEqual([
      'opened-meanwhile'
    ])
  })

  it('keeps unanswered questions unknown instead of guessing them clear', async () => {
    const { deps, request } = setup()
    deps.readPresence = vi.fn(async () => {
      throw new Error('no handler')
    })
    deps.bridge = {
      ...deps.bridge,
      probeRestoreEvidence: vi.fn(async () => undefined)
    }
    const preview = await previewWorkingSetRestore(request, deps)
    if (preview.status !== 'planned') {
      throw new Error(preview.status)
    }
    expect(preview.plan.summary).toMatchObject({
      autoWake: 0,
      byCapability: { 'exact-resume': 0, unknown: 5 }
    })
    const paneA = preview.plan.entries.find((entry) => entry.sourceTabId === 'tab-a')!.panes[0]
    expect(paneA).toMatchObject({ resumeOnOpen: true, blockers: ['presence-unknown'] })
  })

  it('previews without changing anything', async () => {
    const { store, deps, request } = setup()
    const preview = await previewWorkingSetRestore(request, deps)
    expect(preview).toMatchObject({ status: 'planned', plan: { blockers: [] } })
    expect(store.getState().tabsByWorktree[OWNER]).toBeUndefined()
  })
})

const TARGET_OWNER = 'repo-9::/srv/orca'

function hostSetup(over: Partial<ProjectHostSetup>): ProjectHostSetup {
  return {
    id: 'setup-local',
    projectId: 'proj-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: 'C:/work/orca',
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function continueOn(over: Partial<HostTranslationRequest> = {}): HostTranslationRequest {
  return {
    projectId: 'proj-1',
    sourceSetup: hostSetup({}),
    targetSetup: hostSetup({
      id: 'setup-gex',
      hostId: 'ssh:gex44',
      repoId: 'repo-9',
      path: '/srv/orca'
    }),
    targetOwnerKey: TARGET_OWNER,
    ...over
  }
}

function setupContinue(overrides: Partial<WorkingSetRestoreDeps> = {}) {
  const made = setup(overrides)
  const state = made.store.getState()
  made.store.setState({
    repos: [
      ...state.repos,
      { id: 'repo-9', path: '/srv/orca', displayName: 'Orca', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      ...state.worktreesByRepo,
      'repo-9': [makeWorktree({ id: TARGET_OWNER, repoId: 'repo-9', path: '/srv/orca' })]
    }
  } as Partial<AppState>)
  return made
}

describe('restoreWorkingSet with continueOn', () => {
  it('reads and probes by the source scope, asks presence and plans by the translated one', async () => {
    const { store, deps, request, bridge, readPresence } = setupContinue({
      hostAvailability: () => 'available'
    })
    const outcome = await restoreWorkingSet({ ...request, continueOn: continueOn() }, deps)

    expect(bridge.read).toHaveBeenCalledExactlyOnceWith({
      scope: scope,
      workingSetId: request.workingSetId
    })
    expect(bridge.probeRestoreEvidence).toHaveBeenCalledExactlyOnceWith({
      scope: scope,
      workingSetId: request.workingSetId
    })
    expect(readPresence).toHaveBeenCalledTimes(2)
    for (const [asked] of readPresence.mock.calls as unknown as [{ worktreeId: string }][]) {
      expect(asked.worktreeId).toBe(TARGET_OWNER)
    }
    expect(outcome).toMatchObject({
      status: 'planned',
      plan: {
        blockers: [],
        scope: { executionHostId: 'ssh:gex44', ownerKey: TARGET_OWNER }
      },
      applied: { status: 'applied', ownerKey: TARGET_OWNER }
    })
    // Rows land sleeping in the TARGET workspace; the source workspace is untouched.
    expect(store.getState().tabsByWorktree[TARGET_OWNER]).toHaveLength(5)
    expect(store.getState().tabsByWorktree[OWNER]).toBeUndefined()
    if (outcome.status !== 'planned' || !('panes' in outcome)) {
      throw new Error('expected a continue outcome with a pane table')
    }
    // Why not resume: the transcript was only seen on the source; nothing copied it to the target.
    expect(
      outcome.panes.map((pane) => `${pane.sourceTabId}:${pane.disposition}:${pane.reason}`)
    ).toContain('tab-a:unavailable:not-confirmed')
  })

  it('copies each provider pane to the SSH target and resumes only what was read back there', async () => {
    const { deps, request, bridge } = setupContinue({ hostAvailability: () => 'available' })
    const transfer = vi.fn(async () => ({
      status: 'transferred',
      panes: {
        [`tab-a:${leafId(1)}`]: { transcript: 'present', reason: 'copied' },
        [`tab-b:${leafId(2)}`]: { transcript: 'unknown', reason: 'target-conflict' }
      }
    }))
    bridge.transferContinueSessions = transfer
    const outcome = await restoreWorkingSet({ ...request, continueOn: continueOn() }, deps)
    expect(transfer).toHaveBeenCalledExactlyOnceWith({
      scope,
      workingSetId: request.workingSetId,
      connectionId: 'gex44',
      cwdByPaneKey: { [`tab-a:${leafId(1)}`]: '/srv/orca', [`tab-b:${leafId(2)}`]: '/srv/orca' }
    })
    if (outcome.status !== 'planned' || !('panes' in outcome)) {
      throw new Error('expected a continue outcome with a pane table')
    }
    const table = outcome.panes.map((p) => `${p.sourceTabId}:${p.disposition}:${p.reason}`)
    expect(table).toContain('tab-a:resume:provider-session-present')
    expect(table).toContain('tab-b:unavailable:not-confirmed')
  })

  it('copies nothing when the continue would be refused', async () => {
    const { store, deps, request, bridge } = setupContinue({ hostAvailability: () => 'available' })
    store.setState({
      tabsByWorktree: { [TARGET_OWNER]: [makeTab({ id: 'busy', worktreeId: TARGET_OWNER })] }
    })
    const transfer = vi.fn()
    bridge.transferContinueSessions = transfer
    const outcome = await restoreWorkingSet({ ...request, continueOn: continueOn() }, deps)
    expect(outcome).toMatchObject({
      applied: { status: 'refused', blockers: ['current-work-present'] }
    })
    expect(transfer).not.toHaveBeenCalled()
  })

  it('copies nothing onto a host that is not known available', async () => {
    const { deps, request, bridge } = setupContinue({ hostAvailability: () => 'unknown' })
    const transfer = vi.fn()
    bridge.transferContinueSessions = transfer
    await restoreWorkingSet({ ...request, continueOn: continueOn() }, deps)
    expect(transfer).not.toHaveBeenCalled()
  })

  it('leaves every dependency call exactly as before when continueOn is absent', async () => {
    const { deps, request, bridge, readPresence } = setup()
    await restoreWorkingSet(request, deps)

    expect((bridge.read as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [{ scope, workingSetId: request.workingSetId }]
    ])
    expect((bridge.probeRestoreEvidence as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [{ scope, workingSetId: request.workingSetId }]
    ])
    const askedKeys = (readPresence.mock.calls as unknown as [{ worktreeId: string }][]).map(
      ([asked]) => asked.worktreeId
    )
    expect(askedKeys).toEqual([OWNER, OWNER])
  })

  it('returns the translation refusal and calls neither probe, presence, plan nor apply', async () => {
    const { store, deps, request, bridge, readPresence } = setup({
      hostAvailability: () => 'available'
    })
    const outcome = await restoreWorkingSet(
      {
        ...request,
        continueOn: continueOn({
          targetSetup: hostSetup({ id: 'same', hostId: 'local', repoId: 'repo-1' })
        })
      },
      deps
    )
    expect(outcome).toEqual({ status: 'continue-refused', reason: 'same-host' })
    expect(bridge.probeRestoreEvidence).not.toHaveBeenCalled()
    expect(readPresence).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree[TARGET_OWNER]).toBeUndefined()
    expect(store.getState().tabsByWorktree[OWNER]).toBeUndefined()
  })

  it('refuses a folder workspace source with location-kind-unsupported', async () => {
    const { deps, request, bridge } = setup({ hostAvailability: () => 'available' })
    const manifest = representativeManifest()
    manifest.scope.location = {
      kind: 'folder-workspace',
      folderWorkspaceId: 'f1',
      folderPath: 'C:/work/orca'
    }
    bridge.read = vi.fn(async () => ({ status: 'valid', manifest }))
    expect(await restoreWorkingSet({ ...request, continueOn: continueOn() }, deps)).toEqual({
      status: 'continue-refused',
      reason: 'location-kind-unsupported'
    })
  })

  it('still reports an unreadable set as unreadable, not as a refusal', async () => {
    const { deps, request, bridge } = setup()
    bridge.read = vi.fn(async () => ({ status: 'missing' }))
    expect(await restoreWorkingSet({ ...request, continueOn: continueOn() }, deps)).toEqual({
      status: 'unreadable',
      read: { status: 'missing' }
    })
  })

  it('plans an unverified host as a blocked restore with the table and applies nothing', async () => {
    for (const hostAvailability of [undefined, () => 'unknown' as const]) {
      const { store, deps, request } = setupContinue({ hostAvailability })
      const outcome = await restoreWorkingSet({ ...request, continueOn: continueOn() }, deps)
      expect(outcome).toMatchObject({
        status: 'planned',
        applied: { status: 'refused', blockers: ['host-unavailable'] }
      })
      if (outcome.status !== 'planned' || !('panes' in outcome)) {
        throw new Error('expected a continue outcome with a pane table')
      }
      expect(outcome.panes.length).toBeGreaterThan(0)
      expect(outcome.panes.every((pane) => pane.reason === 'host-unverified')).toBe(true)
      expect(store.getState().tabsByWorktree[TARGET_OWNER]).toBeUndefined()
    }
  })

  it('keeps a host that is known down blocked, and applies once it is known available', async () => {
    const down = setupContinue({ hostAvailability: () => 'unavailable' })
    const refused = await restoreWorkingSet(
      { ...down.request, continueOn: continueOn() },
      down.deps
    )
    expect(refused).toMatchObject({
      applied: { status: 'refused', blockers: ['host-unavailable'] }
    })
    expect(down.store.getState().tabsByWorktree[TARGET_OWNER]).toBeUndefined()

    const up = setupContinue({ hostAvailability: () => 'available' })
    const applied = await restoreWorkingSet({ ...up.request, continueOn: continueOn() }, up.deps)
    expect(applied).toMatchObject({ applied: { status: 'applied' } })
    expect(up.store.getState().tabsByWorktree[TARGET_OWNER]).toHaveLength(5)
  })

  it('asks the availability reader about the target setup, not the source', async () => {
    const asked: string[] = []
    const { deps, request } = setupContinue({
      hostAvailability: (target) => {
        asked.push(target.id)
        return 'available'
      }
    })
    await restoreWorkingSet({ ...request, continueOn: continueOn() }, deps)
    // Why twice: availability is read again after the session copy, the await it may drop during.
    expect(asked).toEqual(['setup-gex', 'setup-gex'])
  })
})
