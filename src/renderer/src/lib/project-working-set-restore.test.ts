import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '@/store/types'
import type { WorkingSetRestoreEvidence } from '../../../shared/project-working-set-store-types'
import { representativeManifest } from '../../../shared/project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
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
