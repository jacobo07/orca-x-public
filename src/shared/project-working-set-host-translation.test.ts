import { describe, expect, it } from 'vitest'
import {
  planContinueOnHost,
  translateWorkingSetToHost,
  type HostTranslationRequest
} from './project-working-set-host-translation'
import type { ProjectHostSetup } from './project-types'
import { leafId, representativeManifest } from './project-working-set-test-fixtures'
import type { WorkingSetRestoreEvidence } from './project-working-set-store-types'
import type { ProjectWorkingSetManifest } from './project-working-set-types'

function setup(over: Partial<ProjectHostSetup>): ProjectHostSetup {
  return {
    id: 's',
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

const SOURCE = setup({})
const TARGET = setup({ id: 't', hostId: 'ssh:gex44', repoId: 'repo-9', path: '/srv/orca' })

function request(over: Partial<HostTranslationRequest> = {}): HostTranslationRequest {
  return {
    projectId: 'proj-1',
    sourceSetup: SOURCE,
    targetSetup: TARGET,
    targetOwnerKey: 'repo-9::/srv/orca',
    ...over
  }
}

function evidence(
  manifest: ProjectWorkingSetManifest,
  transcript: 'present' | 'absent' | 'unknown'
): WorkingSetRestoreEvidence {
  return {
    location: 'present',
    startupCwdByTabId: {},
    panes: Object.fromEntries(
      manifest.entries.flatMap((e) =>
        e.panes.map((p) => [
          `${e.tabId}:${p.leafId}`,
          {
            sealedScrollback: 'absent' as const,
            transcript: p.resume.kind === 'provider-session' ? transcript : null
          }
        ])
      )
    )
  }
}

function planInputs(
  manifest: ProjectWorkingSetManifest,
  over: { transcript?: 'present' | 'absent' | 'unknown'; availability?: 'available' | 'unavailable' | 'unknown'; presence?: Record<string, never> | Record<string, 'live-here' | 'live-elsewhere' | 'no-live-owner'> } = {}
) {
  let n = 0
  return {
    evidence: evidence(manifest, over.transcript ?? 'present'),
    launchProfiles: [{ id: 'agent:claude' }, { id: 'agent:codex' }],
    presence: over.presence ?? {
      [`tab-a:${leafId(1)}`]: 'no-live-owner',
      [`tab-b:${leafId(2)}`]: 'no-live-owner'
    },
    target: { openTabCount: 0, hostAvailability: over.availability ?? ('available' as const) },
    newTabId: () => `t-${++n}`
  }
}

describe('translateWorkingSetToHost', () => {
  it('re-points scope and startup cwd through the project setups', () => {
    const manifest = representativeManifest()
    const out = translateWorkingSetToHost(manifest, request())
    if (out.kind !== 'translated') {
      throw new Error('expected translated')
    }
    expect(out.manifest.scope).toEqual({
      executionHostId: 'ssh:gex44',
      ownerKey: 'repo-9::/srv/orca',
      location: { kind: 'repo-worktree', repoId: 'repo-9', worktreePath: '/srv/orca' }
    })
    expect(out.manifest.entries.find((e) => e.tabId === 'tab-d')?.startupCwd).toBe(
      '/srv/orca/packages/app'
    )
    // The source manifest is not mutated.
    expect(manifest.scope.executionHostId).toBe('local')
  })

  it('translates back to a Windows path with its separators', () => {
    const manifest = representativeManifest()
    manifest.scope.executionHostId = 'ssh:gex44'
    manifest.scope.location = { kind: 'repo-worktree', repoId: 'repo-9', worktreePath: '/srv/orca/wt/a' }
    for (const e of manifest.entries) {
      e.startupCwd = null
    }
    const out = translateWorkingSetToHost(
      manifest,
      request({ sourceSetup: TARGET, targetSetup: setup({ path: 'C:\\work\\orca' }) })
    )
    expect(out.kind === 'translated' && out.manifest.scope.location).toEqual({
      kind: 'repo-worktree',
      repoId: 'repo-1',
      worktreePath: 'C:\\work\\orca\\wt\\a'
    })
  })

  it.each([
    ['target-setup-missing', { targetSetup: null }],
    ['target-setup-project-mismatch', { targetSetup: setup({ ...TARGET, projectId: 'other' }) }],
    ['source-setup-project-mismatch', { sourceSetup: setup({ projectId: 'other' }) }],
    ['same-host', { targetSetup: setup({ id: 'x' }) }],
    ['target-setup-not-ready', { targetSetup: setup({ ...TARGET, setupState: 'not-set-up' }) }],
    ['source-host-mismatch', { sourceSetup: setup({ hostId: 'ssh:other' }) }]
  ] as const)('refuses %s', (reason, over) => {
    expect(translateWorkingSetToHost(representativeManifest(), request(over))).toEqual({
      kind: 'refused',
      reason
    })
  })

  it('refuses a location or cwd outside the source setup instead of guessing', () => {
    const outside = representativeManifest()
    outside.scope.location = { kind: 'repo-worktree', repoId: 'repo-1', worktreePath: 'C:/other' }
    expect(translateWorkingSetToHost(outside, request())).toEqual({
      kind: 'refused',
      reason: 'location-outside-source-setup'
    })
    const cwd = representativeManifest()
    cwd.entries[3].startupCwd = 'D:/elsewhere'
    expect(translateWorkingSetToHost(cwd, request())).toEqual({
      kind: 'refused',
      reason: 'startup-cwd-outside-source-setup'
    })
    const folder = representativeManifest()
    folder.scope.location = { kind: 'folder-workspace', folderWorkspaceId: 'f', folderPath: 'C:/work/orca' }
    expect(translateWorkingSetToHost(folder, request())).toEqual({
      kind: 'refused',
      reason: 'location-kind-unsupported'
    })
  })
})

describe('planContinueOnHost', () => {
  const dispositions = (r: ReturnType<typeof planContinueOnHost>) =>
    r.kind === 'planned' ? r.panes.map((p) => `${p.sourceTabId}:${p.disposition}:${p.reason}`) : []

  it('plans without a scope-mismatch blocker and resumes confirmed provider sessions', () => {
    const m = representativeManifest()
    const r = planContinueOnHost(m, request(), planInputs(m))
    expect(r.kind === 'planned' && r.plan.blockers).toEqual([])
    expect(r.kind === 'planned' && r.plan.scope.executionHostId).toBe('ssh:gex44')
    const d = dispositions(r)
    expect(d).toContain('tab-a:resume:provider-session-present')
    expect(d).toContain('tab-b:resume:provider-session-present')
    expect(d).toContain('tab-c:restart:relaunchable')
  })

  it('restarts when the transcript is absent on the target host', () => {
    const m = representativeManifest()
    const d = dispositions(planContinueOnHost(m, request(), planInputs(m, { transcript: 'absent' })))
    expect(d).toContain('tab-a:restart:relaunchable')
  })

  it('does not promise an unconfirmed transcript', () => {
    const m = representativeManifest()
    const d = dispositions(planContinueOnHost(m, request(), planInputs(m, { transcript: 'unknown' })))
    expect(d).toContain('tab-a:unavailable:not-confirmed')
  })

  it('reattaches a pane already live on the target host', () => {
    const m = representativeManifest()
    const r = planContinueOnHost(
      m,
      request(),
      planInputs(m, { presence: { [`tab-a:${leafId(1)}`]: 'live-here' } })
    )
    expect(dispositions(r)).toContain('tab-a:reattach:live-on-target')
  })

  it('marks a pane live on another host unavailable', () => {
    const m = representativeManifest()
    const r = planContinueOnHost(
      m,
      request(),
      planInputs(m, { presence: { [`tab-a:${leafId(1)}`]: 'live-elsewhere' } })
    )
    expect(dispositions(r)).toContain('tab-a:unavailable:live-elsewhere')
  })

  it('makes every pane unavailable with host-unavailable when the target host is down', () => {
    const m = representativeManifest()
    const down = planContinueOnHost(m, request(), planInputs(m, { availability: 'unavailable' }))
    expect(down.kind === 'planned' && down.panes.every((p) => p.reason === 'host-unavailable')).toBe(true)
    expect(down.kind === 'planned' && down.plan.blockers).toContain('host-unavailable')
  })

  it('makes every pane unavailable with host-unverified when the target host is unmeasured', () => {
    const m = representativeManifest()
    const r = planContinueOnHost(m, request(), planInputs(m, { availability: 'unknown' }))
    expect(r.kind === 'planned' && r.panes.length).toBeGreaterThan(0)
    expect(
      r.kind === 'planned' &&
        r.panes.every((p) => p.disposition === 'unavailable' && p.reason === 'host-unverified')
    ).toBe(true)
  })

  it('computes all four dispositions when the host is available (control for the unknown case)', () => {
    const m = representativeManifest()
    const r = planContinueOnHost(
      m,
      request(),
      planInputs(m, {
        presence: { [`tab-a:${leafId(1)}`]: 'live-here', [`tab-b:${leafId(2)}`]: 'live-elsewhere' }
      })
    )
    const d = r.kind === 'planned' ? new Set(r.panes.map((p) => p.disposition)) : new Set()
    expect([...d].sort()).toEqual(['reattach', 'restart', 'unavailable'])
    const resumed = planContinueOnHost(m, request(), planInputs(m))
    expect(resumed.kind === 'planned' && resumed.panes.some((p) => p.disposition === 'resume')).toBe(true)
    expect(resumed.kind === 'planned' && resumed.panes.some((p) => p.reason === 'host-unverified')).toBe(false)
  })

  it('passes a refusal through untouched', () => {
    const m = representativeManifest()
    expect(planContinueOnHost(m, request({ targetSetup: null }), planInputs(m))).toEqual({
      kind: 'refused',
      reason: 'target-setup-missing'
    })
  })
})
