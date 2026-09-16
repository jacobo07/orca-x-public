import { describe, expect, it } from 'vitest'
import type { LiveAgentSessionPresenceWireKind } from './live-agent-session-presence-types'
import { planWorkingSetRestore, type RestorePlanInputs } from './project-working-set-restore-plan'
import type {
  WorkingSetFactPresence,
  WorkingSetRestoreEvidence
} from './project-working-set-store-types'
import { leafId, representativeManifest, SHARED_LABEL } from './project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from './project-working-set-types'

const PROFILES = [{ id: 'agent:claude' }, { id: 'agent:codex' }, { id: 'shell:wsl.exe' }]
const PANE_A = `tab-a:${leafId(1)}`
const PANE_B = `tab-b:${leafId(2)}`

function evidenceFor(
  manifest: ProjectWorkingSetManifest,
  transcript: WorkingSetFactPresence = 'present'
): WorkingSetRestoreEvidence {
  return {
    location: 'present',
    startupCwdByTabId: {},
    panes: Object.fromEntries(
      manifest.entries.flatMap((entry) =>
        entry.panes.map((pane) => [
          `${entry.tabId}:${pane.leafId}`,
          {
            sealedScrollback: 'absent' as const,
            transcript: pane.resume.kind === 'provider-session' ? transcript : null
          }
        ])
      )
    )
  }
}

function inputs(
  manifest: ProjectWorkingSetManifest,
  overrides: Partial<RestorePlanInputs> = {}
): RestorePlanInputs {
  let next = 0
  return {
    evidence: evidenceFor(manifest),
    launchProfiles: PROFILES,
    target: {
      executionHostId: manifest.scope.executionHostId,
      ownerKey: manifest.scope.ownerKey,
      terminalTabCount: 0,
      hostAvailability: 'available'
    },
    presence: { [PANE_A]: 'no-live-owner', [PANE_B]: 'no-live-owner' },
    newTabId: () => `target-${++next}`,
    ...overrides
  }
}

/** What capture writes by default: every row restore-on-open, nothing in the revival order. */
function capturedDefault(): ProjectWorkingSetManifest {
  const manifest = representativeManifest()
  manifest.entries = manifest.entries.filter((entry) => entry.restorePolicy !== 'do-not-restore')
  for (const entry of manifest.entries) {
    entry.restorePolicy = 'restore-on-open'
  }
  manifest.revivalOrder = []
  return manifest
}

const sourceOf = (plan: ReturnType<typeof planWorkingSetRestore>) => (targetTabId: string) =>
  plan.entries.find((entry) => entry.targetTabId === targetTabId)!.sourceTabId

describe('planWorkingSetRestore', () => {
  it('restores the sealed rail order, not the entry order', () => {
    const manifest = representativeManifest()
    const plan = planWorkingSetRestore(manifest, inputs(manifest))
    const source = sourceOf(plan)
    expect(plan.railGroups.map((group) => group.map(source))).toEqual([
      ['tab-b', 'tab-e', 'tab-a'],
      ['tab-d', 'tab-c']
    ])
    expect(plan.entries.map((entry) => entry.sourceTabId)).toEqual([
      'tab-b',
      'tab-e',
      'tab-a',
      'tab-d',
      'tab-c'
    ])
  })

  it('keeps the revival order its own, even where it disagrees with the rail', () => {
    const manifest = representativeManifest()
    const plan = planWorkingSetRestore(manifest, inputs(manifest))
    expect(plan.revivalOrder.map(sourceOf(plan))).toEqual(['tab-a', 'tab-b'])
  })

  it('keeps two rows that share a label as two rows with their own identities', () => {
    const manifest = representativeManifest()
    const plan = planWorkingSetRestore(manifest, inputs(manifest))
    const shared = plan.entries.filter((entry) => entry.label === SHARED_LABEL)
    expect(shared.map((entry) => entry.sourceTabId).sort()).toEqual(['tab-a', 'tab-b'])
    expect(new Set(plan.entries.map((entry) => entry.targetTabId)).size).toBe(plan.entries.length)
    const sessions = shared.map((entry) => {
      const { resume } = entry.panes[0]
      return resume.kind === 'provider-session' ? resume.providerSession.id : null
    })
    expect(sessions.sort()).toEqual(['claude-session-a', 'claude-session-b'])
  })

  it('keeps a dormant active row active and leaves do-not-restore rows out of the rail', () => {
    const manifest = representativeManifest()
    const plan = planWorkingSetRestore(manifest, inputs(manifest))
    expect(sourceOf(plan)(plan.activeTabId!)).toBe('tab-e')
    expect(plan.entries.find((e) => e.sourceTabId === 'tab-e')?.wake).toBe('explicit-only')
    expect(plan.excludedSourceTabIds).toEqual(['tab-f'])
    expect(plan.railGroups.flat()).toHaveLength(5)
  })

  it('wakes nothing for a working set saved with the capture defaults', () => {
    const manifest = capturedDefault()
    const plan = planWorkingSetRestore(manifest, inputs(manifest))
    expect(plan.summary.autoWake).toBe(0)
    expect(plan.revivalOrder).toEqual([])
    expect(new Set(plan.entries.map((entry) => entry.wake))).toEqual(new Set(['on-open']))
  })

  it('counts only confirmed, unblocked auto-restore panes as waking', () => {
    const manifest = representativeManifest()
    expect(planWorkingSetRestore(manifest, inputs(manifest)).summary.autoWake).toBe(2)
    const presence: Record<string, LiveAgentSessionPresenceWireKind> = {
      [PANE_A]: 'live-elsewhere'
    }
    const blocked = planWorkingSetRestore(manifest, inputs(manifest, { presence }))
    expect(blocked.summary).toMatchObject({ autoWake: 0, liveElsewhere: 1 })
    const paneA = blocked.entries.find((e) => e.sourceTabId === 'tab-a')!.panes[0]
    expect(paneA.blockers).toEqual(['live-elsewhere'])
    // tab-b was never asked about, which is not the same as nobody holding it.
    expect(blocked.entries.find((e) => e.sourceTabId === 'tab-b')!.panes[0].blockers).toEqual([
      'presence-unknown'
    ])
  })

  it('offers an unconfirmed resume on open, and never a proven-deleted one', () => {
    const manifest = representativeManifest()
    const unconfirmed = planWorkingSetRestore(
      manifest,
      inputs(manifest, { evidence: evidenceFor(manifest, 'unknown') })
    )
    const paneA = unconfirmed.entries.find((e) => e.sourceTabId === 'tab-a')!.panes[0]
    expect(paneA).toMatchObject({ resumeOnOpen: true, restoreTime: { capability: 'unknown' } })
    expect(unconfirmed.summary.autoWake).toBe(0)
    const gone = planWorkingSetRestore(
      manifest,
      inputs(manifest, { evidence: evidenceFor(manifest, 'absent') })
    )
    expect(gone.entries.find((e) => e.sourceTabId === 'tab-a')!.panes[0]).toMatchObject({
      resumeOnOpen: false,
      blockers: [],
      restoreTime: { capability: 'restartable', captured: 'exact-resume' }
    })
  })

  it('refuses to plan over current work, into another scope, or onto an unreachable host', () => {
    const manifest = representativeManifest()
    const target = inputs(manifest).target
    const blockersFor = (patch: Partial<RestorePlanInputs['target']>) =>
      planWorkingSetRestore(manifest, inputs(manifest, { target: { ...target, ...patch } }))
        .blockers
    expect(blockersFor({})).toEqual([])
    expect(blockersFor({ terminalTabCount: 1 })).toEqual(['current-work-present'])
    expect(blockersFor({ ownerKey: 'repo-1::C:/elsewhere' })).toEqual(['scope-mismatch'])
    expect(blockersFor({ hostAvailability: 'unavailable' })).toEqual(['host-unavailable'])
    expect(blockersFor({ hostAvailability: 'unknown' })).toEqual([])
  })

  it('summarizes mixed restorability without judging the working set by it', () => {
    const manifest = representativeManifest()
    const plan = planWorkingSetRestore(manifest, inputs(manifest))
    expect(plan.summary).toEqual({
      entries: 5,
      panes: 5,
      byCapability: {
        'exact-resume': 2,
        restartable: 1,
        'recreate-context': 1,
        'history-only': 0,
        'not-restorable': 0,
        unknown: 1
      },
      autoWake: 2,
      liveElsewhere: 0,
      excluded: 1
    })
  })

  it('is a projection: it changes nothing it was given', () => {
    const manifest = representativeManifest()
    const before = structuredClone(manifest)
    let minted = 0
    planWorkingSetRestore(manifest, inputs(manifest, { newTabId: () => `t${++minted}` }))
    expect(manifest).toEqual(before)
    expect(minted).toBe(5)
  })

  it('keeps a folder working set a folder working set', () => {
    const manifest = representativeManifest()
    manifest.scope = {
      executionHostId: 'local',
      ownerKey: 'folder:fw-1',
      location: { kind: 'folder-workspace', folderWorkspaceId: 'fw-1', folderPath: 'C:/notes' }
    }
    expect(planWorkingSetRestore(manifest, inputs(manifest)).scope.location).toEqual({
      kind: 'folder-workspace',
      folderWorkspaceId: 'fw-1',
      folderPath: 'C:/notes'
    })
  })
})
