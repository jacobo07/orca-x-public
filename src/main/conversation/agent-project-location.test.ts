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
      ).toEqual({ outcome: 'not-ready', projectId: 'github:acme/ledger', setupState })
    }
  })

  it('refuses a project that only exists on a remote host rather than using its path locally', () => {
    // `/home/dev/ledger` is a real path on the ssh host and means nothing here. Handing it to a
    // local child process is how a provider ends up rooted at a directory that is something else.
    const remote = setup({ hostId: 'ssh:box', path: '/home/dev/ledger' })
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader([remote]))).toEqual({
      outcome: 'remote-host',
      projectId: 'github:acme/ledger',
      hostId: 'ssh:box'
    })
  })

  it('CHARACTERIZATION: with two remote setups, the first one listed decides the host', () => {
    // Today's behaviour, pinned so its inversion is visible: array order picks the host, and here it
    // picks the setup that is NOT ready over the one that is. Harmless only while remote refuses.
    const setups = [
      setup({ id: 's-pending', hostId: 'ssh:pending-box', setupState: 'setting-up' }),
      setup({ id: 's-ready', hostId: 'ssh:ready-box', path: '/home/dev/ledger' })
    ]
    expect(resolveAgentProjectLocation(agent('github:acme/ledger'), reader(setups))).toEqual({
      outcome: 'remote-host',
      projectId: 'github:acme/ledger',
      hostId: 'ssh:pending-box'
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
