import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '@/store/types'
import type { WorkingSetRestoreEvidence } from '../../../shared/project-working-set-store-types'
import { representativeManifest } from '../../../shared/project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import { createTestStore, makeTab, makeWorktree } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import type {
  WorkingSetRestoreOutcome,
  WorkingSetRestoreRequest
} from './project-working-set-restore'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

createStoreSessionMockApi()
const { restoreWorkingSet } = await import('./project-working-set-restore')
const { restoreWorkingSetFromProduct } = await import('./project-working-set-product-restore')

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

function setup() {
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
  let next = 0
  const seen: WorkingSetRestoreRequest[] = []
  const outcomes: WorkingSetRestoreOutcome[] = []
  const restore = async (request: WorkingSetRestoreRequest) => {
    seen.push(request)
    const outcome = await restoreWorkingSet(request, {
      store,
      bridge: {
        save: vi.fn(),
        list: vi.fn(),
        read: vi.fn(async () => ({ status: 'valid', manifest })),
        probeRestoreEvidence: vi.fn(async () => ({
          status: 'probed',
          workingSetId: manifest.workingSetId,
          evidence: evidenceFor(manifest)
        }))
      },
      readPresence: async () => ({
        kind: 'no-live-owner' as const,
        liveElsewhere: [],
        ownersRevision: 'r1',
        unknownCount: 0,
        staleCount: 0
      }),
      now: () => 1,
      newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
    })
    outcomes.push(outcome)
    return outcome
  }
  const activate = vi.fn()
  const request = { scope, workingSetId: manifest.workingSetId, launchProfiles: PROFILES }
  return { store, deps: { restore, activate }, request, seen, outcomes }
}

function relaunchReasons(outcome: WorkingSetRestoreOutcome | undefined): string[] {
  if (outcome?.status !== 'planned') {
    throw new Error('expected a plan')
  }
  return outcome.plan.entries.flatMap((entry) =>
    entry.panes.flatMap((pane) => pane.restoreTime.reasons)
  )
}

describe('restoreWorkingSetFromProduct', () => {
  it('restores through the canonical path with the caller profiles, then navigates', async () => {
    const { store, deps, request, seen, outcomes } = setup()
    expect(await restoreWorkingSetFromProduct(request, deps)).toEqual({
      status: 'restored',
      rows: 5
    })
    expect(seen[0].launchProfiles).toBe(PROFILES)
    expect(relaunchReasons(outcomes[0])).not.toContain('launch-profile-unconfirmed')
    expect(deps.activate).toHaveBeenCalledExactlyOnceWith(OWNER)
    const rows = store.getState().tabsByWorktree[OWNER]
    expect(rows).toHaveLength(5)
    // Restore composes; it never asks a row to open.
    expect(rows.filter((tab) => tab.dormantOpenRequested)).toEqual([])
  })

  it('classifies against the profiles it was given, not a default set', async () => {
    const withNone = setup()
    await restoreWorkingSetFromProduct({ ...withNone.request, launchProfiles: null }, withNone.deps)
    expect(relaunchReasons(withNone.outcomes[0])).toContain('launch-profile-unconfirmed')

    const withOther = setup()
    await restoreWorkingSetFromProduct(
      { ...withOther.request, launchProfiles: [{ id: 'shell:default' }] },
      withOther.deps
    )
    expect(relaunchReasons(withOther.outcomes[0])).toContain('launch-profile-missing')
  })

  it('ignores a second click while the first restore is running', async () => {
    const { store, deps, request } = setup()
    const first = restoreWorkingSetFromProduct(request, deps)
    expect(await restoreWorkingSetFromProduct(request, deps)).toEqual({ status: 'in-flight' })
    expect(await first).toMatchObject({ status: 'restored' })
    expect(store.getState().tabsByWorktree[OWNER]).toHaveLength(5)
    expect(deps.activate).toHaveBeenCalledTimes(1)
  })

  it('refuses a later restore into the rows it created, without duplicating them', async () => {
    const { store, deps, request } = setup()
    await restoreWorkingSetFromProduct(request, deps)
    expect(await restoreWorkingSetFromProduct(request, deps)).toEqual({
      status: 'refused',
      blockers: ['current-work-present']
    })
    expect(store.getState().tabsByWorktree[OWNER]).toHaveLength(5)
    expect(deps.activate).toHaveBeenCalledTimes(1)
  })

  it('keeps existing work and does not navigate when the workspace is not empty', async () => {
    const { store, deps, request } = setup()
    store.setState({
      tabsByWorktree: { [OWNER]: [makeTab({ id: 'user-tab', worktreeId: OWNER })] }
    })
    expect(await restoreWorkingSetFromProduct(request, deps)).toEqual({
      status: 'refused',
      blockers: ['current-work-present']
    })
    expect(store.getState().tabsByWorktree[OWNER].map((tab) => tab.id)).toEqual(['user-tab'])
    expect(deps.activate).not.toHaveBeenCalled()
  })

  it('reports a rolled-back apply as a failure, never as restored', async () => {
    const { deps, request } = setup()
    const failing = {
      ...deps,
      restore: async (): Promise<WorkingSetRestoreOutcome> => ({
        status: 'planned',
        plan: {} as never,
        applied: { status: 'failed', stage: 'verify', detail: 'rail order', rolledBack: true }
      })
    }
    expect(await restoreWorkingSetFromProduct(request, failing)).toEqual({
      status: 'failed',
      stage: 'verify',
      rolledBack: true
    })
    expect(deps.activate).not.toHaveBeenCalled()
  })

  it('passes an unreadable snapshot through by its own status', async () => {
    const { deps, request } = setup()
    const missing = {
      ...deps,
      restore: async (): Promise<WorkingSetRestoreOutcome> => ({
        status: 'unreadable',
        read: { status: 'missing' }
      })
    }
    expect(await restoreWorkingSetFromProduct(request, missing)).toEqual({
      status: 'unreadable',
      read: { status: 'missing' }
    })
    // The flight is released after a non-restore answer too.
    expect(await restoreWorkingSetFromProduct(request, missing)).toMatchObject({
      status: 'unreadable'
    })
  })
})
