import { describe, expect, it } from 'vitest'

import type { Agent } from '../../shared/agent-types'
import type { ProjectHostSetup, ProjectHostSetupState } from '../../shared/project-types'

import { resolveAgentProjectLocation, type ProjectLocationReader } from './agent-project-location'

function agent(projectId: string | null): Pick<Agent, 'projectId'> {
  return { projectId }
}

function setup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-1',
    projectId: 'github:acme/ledger',
    hostId: 'local',
    repoId: 'repo-1',
    path: 'C:/work/ledger',
    displayName: 'ledger',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function reader(setups: ProjectHostSetup[]): ProjectLocationReader {
  return { readProjectHostSetups: () => setups }
}

describe('resolveAgentProjectLocation', () => {
  it('gives an agent the directory of its own project', () => {
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader([setup()]))).toEqual({
      outcome: 'resolved',
      projectId: 'github:acme/ledger',
      path: 'C:/work/ledger',
      displayName: 'ledger'
    })
  })

  it('picks the agent project, not the only project, when several are set up', () => {
    // The wrong-project case in its smallest form: a reader holding two setups must not hand back
    // whichever one it saw first.
    const setups = [
      setup({ id: 's-b', projectId: 'github:acme/billing', path: 'C:/work/billing' }),
      setup({ id: 's-l', projectId: 'github:acme/ledger', path: 'C:/work/ledger' })
    ]
    const resolved = resolveAgentProjectLocation(agent('github:acme/ledger'), reader(setups))
    expect(resolved).toMatchObject({ outcome: 'resolved', path: 'C:/work/ledger' })
  })

  it('reports no-project for an agent that owns none, which is a choice and not a refusal', () => {
    expect(resolveAgentProjectLocation(agent(null), reader([setup()]))).toEqual({
      outcome: 'no-project'
    })
  })

  it('separates a project that is gone from one that is merely not ready', () => {
    expect(resolveAgentProjectLocation(agent('github:acme/gone'), reader([setup()]))).toEqual({
      outcome: 'unresolved',
      projectId: 'github:acme/gone'
    })

    const states: ProjectHostSetupState[] = ['not-set-up', 'setting-up', 'error', 'unsupported']
    for (const setupState of states) {
      expect(
        resolveAgentProjectLocation(agent('github:acme/ledger'), reader([setup({ setupState })]))
      ).toEqual({
        outcome: 'not-ready',
        projectId: 'github:acme/ledger',
        hostId: 'local',
        setupState
      })
    }
  })

  it('locates a project that only exists on an ssh host as a REMOTE subject, never a local path', () => {
    // `/home/dev/ledger` is a real path on the ssh host and means nothing here. It is carried as a
    // remote subject with its host and setup, so nothing can hand it to a local child process.
    const remote = setup({ id: 's-box', hostId: 'ssh:box', path: '/home/dev/ledger' })
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader([remote]))).toEqual({
      outcome: 'resolved-remote',
      projectId: 'github:acme/ledger',
      hostId: 'ssh:box',
      setupId: 's-box',
      path: '/home/dev/ledger',
      displayName: 'ledger'
    })
  })

  it('chooses the READY remote setup by rule, even when a pending one is listed first', () => {
    // Inverted from the characterization in b63595026, where array order picked the pending host.
    const setups = [
      setup({ id: 's-pending', hostId: 'ssh:pending-box', setupState: 'setting-up' }),
      setup({ id: 's-ready', hostId: 'ssh:ready-box', path: '/home/dev/ledger' })
    ]
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader(setups))).toMatchObject({
      outcome: 'resolved-remote',
      hostId: 'ssh:ready-box',
      setupId: 's-ready'
    })
  })

  it('refuses to choose between two ready remote hosts, naming both', () => {
    const setups = [
      setup({ id: 's-a', hostId: 'ssh:box-a' }),
      setup({ id: 's-b', hostId: 'ssh:box-b' })
    ]
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader(setups))).toEqual({
      outcome: 'ambiguous-host',
      projectId: 'github:acme/ledger',
      hostIds: ['ssh:box-a', 'ssh:box-b']
    })
  })

  it('keeps a runtime-only project as remote-host, a host kind a turn cannot run on yet', () => {
    const runtime = setup({ hostId: 'runtime:cloud', path: '/srv/ledger' })
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader([runtime]))).toEqual({
      outcome: 'remote-host',
      projectId: 'github:acme/ledger',
      hostId: 'runtime:cloud'
    })
  })

  it('reports which host a not-ready setup is on, so its sentence can say where', () => {
    const pending = setup({ hostId: 'ssh:box', setupState: 'setting-up' })
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader([pending]))).toEqual({
      outcome: 'not-ready',
      projectId: 'github:acme/ledger',
      hostId: 'ssh:box',
      setupState: 'setting-up'
    })
  })

  it('prefers the ready local setup over a remote one for the same project', () => {
    const setups = [
      setup({ id: 's-r', hostId: 'runtime:cloud', path: '/srv/ledger' }),
      setup({ id: 's-l', hostId: 'local', path: 'C:/work/ledger' })
    ]
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader(setups))).toMatchObject({
      outcome: 'resolved',
      path: 'C:/work/ledger'
    })
  })

  it('follows a project id promotion, because the roster rewrites the agent to match', () => {
    // repo: -> github: succession. The agent record is remapped by rebuildRepoBackedProjectState,
    // so a resolver that read a stale id would strand it; this one reads what the roster now says.
    const promoted = setup({ projectId: 'github:acme/ledger' })
    expect(resolveAgentProjectLocation(agent('repo:repo-1'), reader([promoted]))).toEqual({
      outcome: 'unresolved',
      projectId: 'repo:repo-1'
    })
    expect(
      resolveAgentProjectLocation(agent('github:acme/ledger'), reader([promoted]))
    ).toMatchObject({ outcome: 'resolved' })
  })
})
