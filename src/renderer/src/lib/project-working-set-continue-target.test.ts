import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { WorkingSetLocation } from '../../../shared/project-working-set-types'
import type { Worktree } from '../../../shared/worktree/types'
import { makeWorktree } from '../store/slices/store-test-helpers'
import { resolveContinueTarget, type ContinueTargetInput } from './project-working-set-continue-target'

function setup(over: Partial<ProjectHostSetup>): ProjectHostSetup {
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

const SOURCE = setup({})
const TARGET = setup({
  id: 'setup-gex',
  hostId: 'ssh:gex44',
  repoId: 'repo-9',
  path: '/srv/orca'
})
const SOURCE_LOCATION: WorkingSetLocation = {
  kind: 'repo-worktree',
  repoId: 'repo-1',
  worktreePath: 'C:/work/orca'
}

function targetWorktree(over: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id: 'repo-9::/srv/orca',
    repoId: 'repo-9',
    path: '/srv/orca',
    projectHostSetupId: 'setup-gex',
    ...over
  })
}

function input(over: Partial<ContinueTargetInput> = {}): ContinueTargetInput {
  return {
    projectId: 'proj-1',
    sourceScope: { executionHostId: 'local', ownerKey: 'repo-1::C:/work/orca' },
    sourceLocation: SOURCE_LOCATION,
    sourceSetupId: 'setup-local',
    targetSetupId: 'setup-gex',
    setups: [SOURCE, TARGET],
    worktrees: [targetWorktree()],
    ...over
  }
}

describe('resolveContinueTarget', () => {
  it('resolves to the id of the store worktree that is the translation location', () => {
    expect(resolveContinueTarget(input())).toEqual({
      status: 'resolved',
      request: {
        projectId: 'proj-1',
        sourceSetup: SOURCE,
        targetSetup: TARGET,
        targetOwnerKey: 'repo-9::/srv/orca'
      }
    })
  })

  it('is unresolved when the target workspace is not in the store (control: present resolves)', () => {
    expect(resolveContinueTarget(input({ worktrees: [] }))).toEqual({
      status: 'unresolved',
      reason: 'target-workspace-missing'
    })
    expect(resolveContinueTarget(input()).status).toBe('resolved')
  })

  it('never returns a key for a near-miss path or another setup repo', () => {
    const nearMiss = targetWorktree({ id: 'repo-9::/srv/orca2', path: '/srv/orca2' })
    const otherRepo = targetWorktree({ id: 'repo-8::/srv/orca', repoId: 'repo-8' })
    expect(resolveContinueTarget(input({ worktrees: [nearMiss, otherRepo] }))).toEqual({
      status: 'unresolved',
      reason: 'target-workspace-missing'
    })
  })

  it('maps a linked worktree of the source through the relative path', () => {
    const linked = targetWorktree({ id: 'repo-9::/srv/orca/wt/a', path: '/srv/orca/wt/a' })
    const out = resolveContinueTarget(
      input({
        sourceLocation: { ...SOURCE_LOCATION, worktreePath: 'C:/work/orca/wt/a' },
        worktrees: [targetWorktree(), linked]
      })
    )
    expect(out.status === 'resolved' && out.request.targetOwnerKey).toBe('repo-9::/srv/orca/wt/a')
  })

  it('treats a worktree owned by another setup as absent', () => {
    expect(
      resolveContinueTarget(
        input({ worktrees: [targetWorktree({ projectHostSetupId: 'setup-elsewhere' })] })
      )
    ).toEqual({ status: 'unresolved', reason: 'target-workspace-missing' })
  })

  it('is unresolved when the source setup is not in the projection', () => {
    expect(resolveContinueTarget(input({ setups: [TARGET] }))).toEqual({
      status: 'unresolved',
      reason: 'source-setup-missing'
    })
  })

  it('carries translation refusals as refusals, before looking for a workspace', () => {
    expect(resolveContinueTarget(input({ setups: [SOURCE], worktrees: [] }))).toEqual({
      status: 'refused',
      reason: 'target-setup-missing'
    })
    const notReady = { ...TARGET, setupState: 'not-set-up' as const }
    expect(resolveContinueTarget(input({ setups: [SOURCE, notReady], worktrees: [] }))).toEqual({
      status: 'refused',
      reason: 'target-setup-not-ready'
    })
    expect(
      resolveContinueTarget(
        input({
          setups: [SOURCE, { ...TARGET, hostId: 'local' }],
          worktrees: [targetWorktree()]
        })
      )
    ).toEqual({ status: 'refused', reason: 'same-host' })
  })

  it('refuses a folder workspace source instead of guessing a target', () => {
    expect(
      resolveContinueTarget(
        input({
          sourceLocation: {
            kind: 'folder-workspace',
            folderWorkspaceId: 'f1',
            folderPath: 'C:/work/orca'
          }
        })
      )
    ).toEqual({ status: 'refused', reason: 'location-kind-unsupported' })
  })

  it('refuses a source location outside the source setup', () => {
    expect(
      resolveContinueTarget(
        input({ sourceLocation: { ...SOURCE_LOCATION, worktreePath: 'D:/elsewhere' } })
      )
    ).toEqual({ status: 'refused', reason: 'location-outside-source-setup' })
  })
})
