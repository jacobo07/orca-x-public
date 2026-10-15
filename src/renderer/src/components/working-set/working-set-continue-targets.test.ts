import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup, ProjectHostSetupState } from '../../../../shared/project-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  continueOfferFor,
  listContinueTargets,
  type ContinueTargetsState
} from './working-set-continue-targets'

const PROJECT = 'github:acme/orca'

function setup(
  id: string,
  hostId: ExecutionHostId,
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup {
  return {
    id,
    projectId: PROJECT,
    hostId,
    repoId: `repo-${id}`,
    path: `/work/${id}`,
    displayName: id,
    setupState: 'ready',
    setupMethod: 'existing-folder',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as ProjectHostSetup
}

function worktree(repoId: string, path: string, overrides: Partial<Worktree> = {}): Worktree {
  return { id: `${repoId}::${path}`, repoId, path, ...overrides } as Worktree
}

function stateOf(setups: ProjectHostSetup[], worktrees: Worktree[] = []): ContinueTargetsState {
  return {
    repos: [],
    projects: [],
    projectHostSetups: setups,
    worktreesByRepo: { [worktrees[0]?.repoId ?? 'none']: worktrees }
  }
}

const LOCAL_SETUP = setup('local-1', 'local')
const SSH_SETUP = setup('ssh-1', 'ssh:box')
const SOURCE_WORKTREE = worktree('repo-local-1', '/work/local-1/feature')
const scopeOf = (ownerKey: string, executionHostId: ExecutionHostId = 'local') => ({
  executionHostId,
  ownerKey
})

describe('listContinueTargets', () => {
  it('lists the one ready setup of the same project on another host', () => {
    const state = stateOf([LOCAL_SETUP, SSH_SETUP], [SOURCE_WORKTREE])
    expect(listContinueTargets(state, scopeOf(SOURCE_WORKTREE.id)).map((s) => s.id)).toEqual([
      'ssh-1'
    ])
  })

  it('offers a local setup to a workspace that lives on an SSH host', () => {
    const sshWorktree = worktree('repo-ssh-1', '/work/ssh-1/feature')
    const state = stateOf([LOCAL_SETUP, SSH_SETUP], [sshWorktree])
    expect(listContinueTargets(state, scopeOf(sshWorktree.id, 'ssh:box')).map((s) => s.id)).toEqual(
      ['local-1']
    )
  })

  it('offers nothing when the workspace belongs to no project setup', () => {
    const stranger = worktree('repo-unknown', '/elsewhere/feature')
    const state = stateOf([LOCAL_SETUP, SSH_SETUP], [stranger])
    expect(listContinueTargets(state, scopeOf(stranger.id))).toEqual([])
  })

  it('offers nothing for a folder workspace', () => {
    const state = stateOf([LOCAL_SETUP, SSH_SETUP], [SOURCE_WORKTREE])
    expect(
      listContinueTargets(state, scopeOf('folder:11111111-2222-3333-4444-555555555555'))
    ).toEqual([])
  })

  it('offers nothing when the project has one setup', () => {
    const state = stateOf([LOCAL_SETUP], [SOURCE_WORKTREE])
    expect(listContinueTargets(state, scopeOf(SOURCE_WORKTREE.id))).toEqual([])
  })

  it.each<ProjectHostSetupState>(['not-set-up', 'setting-up', 'error', 'unsupported'])(
    'excludes another-host setup that is %s',
    (setupState) => {
      const state = stateOf([LOCAL_SETUP, { ...SSH_SETUP, setupState }], [SOURCE_WORKTREE])
      expect(listContinueTargets(state, scopeOf(SOURCE_WORKTREE.id))).toEqual([])
    }
  )

  it('excludes a ready setup on the same host as the workspace', () => {
    const sameHost = setup('local-2', 'local')
    const state = stateOf([LOCAL_SETUP, sameHost, SSH_SETUP], [SOURCE_WORKTREE])
    expect(listContinueTargets(state, scopeOf(SOURCE_WORKTREE.id)).map((s) => s.id)).toEqual([
      'ssh-1'
    ])
  })

  it('excludes a ready setup of another project', () => {
    const other = setup('ssh-other', 'ssh:box', { projectId: 'github:acme/other' })
    const state = stateOf([LOCAL_SETUP, other], [SOURCE_WORKTREE])
    expect(listContinueTargets(state, scopeOf(SOURCE_WORKTREE.id))).toEqual([])
  })

  it('takes the workspace setup from the worktree when two setups share a repo', () => {
    const twin = setup('local-twin', 'local', { repoId: LOCAL_SETUP.repoId })
    const chosen = { ...SOURCE_WORKTREE, projectHostSetupId: 'local-1' }
    const ambiguous = stateOf([LOCAL_SETUP, twin, SSH_SETUP], [SOURCE_WORKTREE])
    expect(listContinueTargets(ambiguous, scopeOf(SOURCE_WORKTREE.id))).toEqual([])
    const named = stateOf([LOCAL_SETUP, twin, SSH_SETUP], [chosen])
    expect(listContinueTargets(named, scopeOf(chosen.id)).map((s) => s.id)).toEqual(['ssh-1'])
  })

  it('reads a workspace key as its worktree', () => {
    const state = stateOf([LOCAL_SETUP, SSH_SETUP], [SOURCE_WORKTREE])
    expect(
      listContinueTargets(state, scopeOf(`worktree:${SOURCE_WORKTREE.id}`)).map((s) => s.id)
    ).toEqual(['ssh-1'])
  })
})

describe('continueOfferFor', () => {
  it('carries what the product call needs: project, source setup, source location and setups', () => {
    const state = stateOf([LOCAL_SETUP, SSH_SETUP], [SOURCE_WORKTREE])
    expect(continueOfferFor(state, scopeOf(SOURCE_WORKTREE.id))).toEqual({
      projectId: PROJECT,
      sourceSetupId: 'local-1',
      sourceLocation: {
        kind: 'repo-worktree',
        repoId: 'repo-local-1',
        worktreePath: '/work/local-1/feature'
      },
      setups: [LOCAL_SETUP, SSH_SETUP],
      targets: [SSH_SETUP]
    })
  })

  it('is null when there is no target, so the surface renders nothing', () => {
    const state = stateOf([LOCAL_SETUP], [SOURCE_WORKTREE])
    expect(continueOfferFor(state, scopeOf(SOURCE_WORKTREE.id))).toBeNull()
  })
})
