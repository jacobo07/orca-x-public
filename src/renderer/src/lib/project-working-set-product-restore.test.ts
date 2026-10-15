import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '@/store/types'
import type { WorkingSetRestoreEvidence } from '../../../shared/project-working-set-store-types'
import { representativeManifest } from '../../../shared/project-working-set-test-fixtures'
import type { HostTranslationRefusal } from '../../../shared/project-working-set-host-translation'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import { createTestStore, makeTab, makeWorktree } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import type {
  ContinueRestoreOutcome,
  WorkingSetContinueRequest,
  WorkingSetRestoreOutcome,
  WorkingSetRestoreRequest
} from './project-working-set-restore'
import type {
  ProductContinueDeps,
  ProductContinueRequest,
  ProductContinueResult,
  ProductRestoreResult
} from './project-working-set-product-restore'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

createStoreSessionMockApi()
const { restoreWorkingSet } = await import('./project-working-set-restore')
const { continueWorkingSetFromProduct, restoreWorkingSetFromProduct } =
  await import('./project-working-set-product-restore')

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

const TARGET_OWNER = 'repo-9::/srv/orca'
const OTHER_TARGET_OWNER = 'repo-10::/srv/orca'

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

const SOURCE_SETUP = hostSetup({})
const TARGET_SETUP = hostSetup({
  id: 'setup-gex',
  hostId: 'ssh:gex44',
  repoId: 'repo-9',
  path: '/srv/orca'
})
const OTHER_TARGET_SETUP = hostSetup({
  id: 'setup-gex2',
  hostId: 'ssh:gex45',
  repoId: 'repo-10',
  path: '/srv/orca'
})

function continueRequest(
  over: { targetSetupId?: string; setups?: ProjectHostSetup[] } = {}
): ProductContinueRequest {
  return {
    scope,
    workingSetId: representativeManifest().workingSetId,
    launchProfiles: PROFILES,
    target: {
      projectId: 'proj-1',
      sourceLocation: { kind: 'repo-worktree', repoId: 'repo-1', worktreePath: 'C:/work/orca' },
      sourceSetupId: 'setup-local',
      targetSetupId: over.targetSetupId ?? 'setup-gex',
      setups: over.setups ?? [SOURCE_SETUP, TARGET_SETUP, OTHER_TARGET_SETUP]
    }
  }
}

function targetWorktrees() {
  return [
    makeWorktree({ id: TARGET_OWNER, repoId: 'repo-9', path: '/srv/orca' }),
    makeWorktree({ id: OTHER_TARGET_OWNER, repoId: 'repo-10', path: '/srv/orca' })
  ]
}

// Real planner and apply, with a bridge that answers and a target host known reachable.
function setupContinue() {
  const store = createTestStore()
  store.setState({
    repos: [
      { id: 'repo-1', path: 'C:/work/orca', displayName: 'Orca', badgeColor: '#000', addedAt: 0 },
      { id: 'repo-9', path: '/srv/orca', displayName: 'Orca', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: OWNER, repoId: 'repo-1', path: 'C:/work/orca' })],
      'repo-9': [targetWorktrees()[0]]
    }
  } as Partial<AppState>)
  const manifest = representativeManifest()
  let next = 0
  const bridge = {
    save: vi.fn(),
    list: vi.fn(),
    read: vi.fn(async (): Promise<unknown> => ({ status: 'valid', manifest })),
    probeRestoreEvidence: vi.fn(async () => ({
      status: 'probed',
      workingSetId: manifest.workingSetId,
      evidence: evidenceFor(manifest)
    }))
  }
  const restore = (request: WorkingSetContinueRequest) =>
    restoreWorkingSet(request, {
      store,
      bridge,
      readPresence: async () => ({
        kind: 'no-live-owner' as const,
        liveElsewhere: [],
        ownersRevision: 'r1',
        unknownCount: 0,
        staleCount: 0
      }),
      now: () => 1,
      newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
      hostAvailability: () => 'available'
    })
  const deps: ProductContinueDeps = { restore, worktrees: () => targetWorktrees().slice(0, 1) }
  return { store, deps, bridge }
}

function fake(outcome: ContinueRestoreOutcome): ProductContinueDeps {
  return { restore: async () => outcome, worktrees: () => targetWorktrees() }
}

const PLANNED_BASE = { plan: { entries: [] } as never, panes: [] }

describe('continueWorkingSetFromProduct', () => {
  it('continues onto the target workspace, returns the pane table and opens nothing', async () => {
    const { store, deps } = setupContinue()
    const result = await continueWorkingSetFromProduct(continueRequest(), deps)
    expect(result).toMatchObject({ status: 'restored', rows: 5 })
    expect(result.status === 'restored' && result.panes?.map((p) => p.disposition)).toContain(
      'resume'
    )
    const rows = store.getState().tabsByWorktree[TARGET_OWNER]
    expect(rows).toHaveLength(5)
    // Rows land sleeping; the source workspace is untouched.
    expect(rows.filter((tab) => tab.dormantOpenRequested)).toEqual([])
    expect(store.getState().tabsByWorktree[OWNER]).toBeUndefined()
  })

  // One condition at a time, each with the status it must produce and a control that does not.
  const ARMS: [string, () => Promise<ProductContinueResult>, string][] = [
    [
      'unreadable',
      async () => {
        const { deps, bridge } = setupContinue()
        bridge.read = vi.fn(async () => ({ status: 'missing' }))
        return continueWorkingSetFromProduct(continueRequest(), deps)
      },
      'unreadable'
    ],
    [
      'refused (blockers)',
      async () => {
        const { store, deps } = setupContinue()
        store.setState({
          tabsByWorktree: { [TARGET_OWNER]: [makeTab({ id: 'u', worktreeId: TARGET_OWNER })] }
        })
        return continueWorkingSetFromProduct(continueRequest(), deps)
      },
      'refused'
    ],
    [
      'target-changed',
      async () =>
        continueWorkingSetFromProduct(
          continueRequest(),
          fake({ ...PLANNED_BASE, status: 'planned', applied: { status: 'target-changed' } })
        ),
      'target-changed'
    ],
    [
      'failed',
      async () =>
        continueWorkingSetFromProduct(
          continueRequest(),
          fake({
            ...PLANNED_BASE,
            status: 'planned',
            applied: { status: 'failed', stage: 'hydrate', detail: 'x', rolledBack: true }
          })
        ),
      'failed'
    ],
    [
      'continue-refused from the restore',
      async () =>
        continueWorkingSetFromProduct(
          continueRequest(),
          fake({ status: 'continue-refused', reason: 'startup-cwd-outside-source-setup' })
        ),
      'continue-refused'
    ],
    [
      'continue-refused: target setup missing',
      async () =>
        continueWorkingSetFromProduct(
          continueRequest({ targetSetupId: 'nope' }),
          setupContinue().deps
        ),
      'continue-refused'
    ],
    [
      'continue-refused: target setup not ready',
      async () =>
        continueWorkingSetFromProduct(
          continueRequest({
            setups: [SOURCE_SETUP, { ...TARGET_SETUP, setupState: 'not-set-up' }]
          }),
          setupContinue().deps
        ),
      'continue-refused'
    ],
    [
      'continue-target-unavailable',
      async () => {
        const { deps } = setupContinue()
        return continueWorkingSetFromProduct(continueRequest(), { ...deps, worktrees: () => [] })
      },
      'continue-target-unavailable'
    ]
  ]

  it.each(ARMS)('%s ends in exactly its own status', async (_name, run, status) => {
    expect((await run()).status).toBe(status)
  })

  it('the control for every arm above is the restored status', async () => {
    const { deps } = setupContinue()
    expect((await continueWorkingSetFromProduct(continueRequest(), deps)).status).toBe('restored')
  })

  it('keeps "not set up there" apart from errors', async () => {
    const missing = await continueWorkingSetFromProduct(
      continueRequest({ targetSetupId: 'nope' }),
      setupContinue().deps
    )
    const notReady = await continueWorkingSetFromProduct(
      continueRequest({ setups: [SOURCE_SETUP, { ...TARGET_SETUP, setupState: 'not-set-up' }] }),
      setupContinue().deps
    )
    expect(missing).toEqual({ status: 'continue-refused', reason: 'target-setup-missing' })
    expect(notReady).toEqual({ status: 'continue-refused', reason: 'target-setup-not-ready' })
  })

  it('reports an absent source setup and an absent target workspace by their own reasons', async () => {
    const { deps } = setupContinue()
    expect(
      await continueWorkingSetFromProduct(continueRequest({ setups: [TARGET_SETUP] }), deps)
    ).toEqual({ status: 'continue-target-unavailable', reason: 'source-setup-missing' })
    expect(
      await continueWorkingSetFromProduct(continueRequest(), { ...deps, worktrees: () => [] })
    ).toEqual({
      status: 'continue-target-unavailable',
      reason: 'target-workspace-missing'
    })
  })

  it.each([
    'source-setup-project-mismatch',
    'target-setup-project-mismatch',
    'target-setup-missing',
    'target-setup-not-ready',
    'same-host',
    'source-host-mismatch',
    'location-outside-source-setup',
    'location-kind-unsupported',
    'startup-cwd-outside-source-setup'
  ] satisfies HostTranslationRefusal[])(
    'maps the refusal %s to continue-refused',
    async (reason) => {
      expect(
        await continueWorkingSetFromProduct(
          continueRequest(),
          fake({ status: 'continue-refused', reason })
        )
      ).toEqual({ status: 'continue-refused', reason })
    }
  )

  it('threads the pane table through a blocked restore and never into other arms', async () => {
    const { store, deps } = setupContinue()
    store.setState({
      tabsByWorktree: { [TARGET_OWNER]: [makeTab({ id: 'u', worktreeId: TARGET_OWNER })] }
    })
    const blocked = await continueWorkingSetFromProduct(continueRequest(), deps)
    expect(blocked).toMatchObject({ status: 'refused', blockers: ['current-work-present'] })
    expect(blocked.status === 'refused' && Array.isArray(blocked.panes)).toBe(true)
    const changed = await continueWorkingSetFromProduct(
      continueRequest(),
      fake({ ...PLANNED_BASE, status: 'planned', applied: { status: 'target-changed' } })
    )
    expect(changed).toEqual({ status: 'target-changed' })
  })

  it('keeps the two new statuses out of the plain restore result', () => {
    expectTypeOf<ProductRestoreResult>().toMatchTypeOf<ProductContinueResult>()
    expectTypeOf<
      Extract<ProductRestoreResult, { status: 'continue-refused' | 'continue-target-unavailable' }>
    >().toEqualTypeOf<never>()
  })

  describe('in-flight guard keyed by the target workspace', () => {
    function gated() {
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const calls: string[] = []
      const deps: ProductContinueDeps = {
        worktrees: () => targetWorktrees(),
        restore: async (request) => {
          calls.push(request.continueOn.targetOwnerKey)
          await gate
          return {
            ...PLANNED_BASE,
            status: 'planned',
            applied: {
              status: 'applied',
              workingSetId: 'w',
              ownerKey: request.continueOn.targetOwnerKey,
              targetTabIds: [],
              resumeOnOpen: 0
            }
          }
        }
      }
      return { deps, calls, release }
    }

    it('reports in-flight for a second continue to the same target', async () => {
      const { deps, calls, release } = gated()
      const first = continueWorkingSetFromProduct(continueRequest(), deps)
      expect(await continueWorkingSetFromProduct(continueRequest(), deps)).toEqual({
        status: 'in-flight'
      })
      release()
      expect(await first).toMatchObject({ status: 'restored' })
      expect(calls).toEqual([TARGET_OWNER])
    })

    it('runs two continues of one source to different targets', async () => {
      const { deps, calls, release } = gated()
      const first = continueWorkingSetFromProduct(continueRequest(), deps)
      const second = continueWorkingSetFromProduct(
        continueRequest({ targetSetupId: 'setup-gex2' }),
        deps
      )
      release()
      expect(await first).toMatchObject({ status: 'restored' })
      expect(await second).toMatchObject({ status: 'restored' })
      expect(calls.sort()).toEqual([OTHER_TARGET_OWNER, TARGET_OWNER].sort())
    })

    it('runs sequential continues to the same target (control)', async () => {
      const { deps, calls, release } = gated()
      release()
      expect(await continueWorkingSetFromProduct(continueRequest(), deps)).toMatchObject({
        status: 'restored'
      })
      expect(await continueWorkingSetFromProduct(continueRequest(), deps)).toMatchObject({
        status: 'restored'
      })
      expect(calls).toEqual([TARGET_OWNER, TARGET_OWNER])
    })

    it('keeps a plain restore guarded by its own source workspace', async () => {
      const { deps, release } = gated()
      const first = continueWorkingSetFromProduct(continueRequest(), deps)
      const plain = setup()
      expect(await restoreWorkingSetFromProduct(plain.request, plain.deps)).toMatchObject({
        status: 'restored'
      })
      release()
      await first
    })

    it('releases the flight when a dependency throws', async () => {
      const throwing: ProductContinueDeps = {
        worktrees: () => targetWorktrees(),
        restore: async () => {
          throw new Error('boom')
        }
      }
      await expect(continueWorkingSetFromProduct(continueRequest(), throwing)).rejects.toThrow(
        'boom'
      )
      const { deps } = setupContinue()
      expect((await continueWorkingSetFromProduct(continueRequest(), deps)).status).toBe('restored')
    })

    it('releases the flight after a refusal arm too', async () => {
      const refusing = fake({ status: 'continue-refused', reason: 'same-host' })
      await continueWorkingSetFromProduct(continueRequest(), refusing)
      expect(
        (await continueWorkingSetFromProduct(continueRequest(), setupContinue().deps)).status
      ).toBe('restored')
    })
  })
})
