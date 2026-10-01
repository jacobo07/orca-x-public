// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import type { ReplicaTopologyEntry } from '../../../../shared/replica-topology'
import { useAppStore } from '../../store'
import { getReplicaTopologyFromState } from '../../store/replica-topology-selector'
import { ReplicaRowTopology } from './ReplicaTopologyDetails'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'

const ROOT = 'abcdef1'.padEnd(40, '0')

let container: HTMLDivElement
let root: Root

function gitRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: 'Orca',
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    gitRemoteIdentity: null,
    gitRootIdentity: { rootCommit: ROOT, commonDir: `/srv/${id}/.git`, shallow: false },
    ...overrides
  }
}

function seedStore(repos: Repo[], extra: Record<string, unknown> = {}): void {
  // Why: only repos, projects and setups are seeded, so the selector path is what is exercised.
  const projection = projectHostSetupProjectionFromRepos(repos)
  useAppStore.setState({
    repos,
    projects: [...projection.projects],
    projectHostSetups: [...projection.setups],
    ...extra
  })
}

function renderSection(repo: Repo): void {
  act(() => {
    root.render(
      React.createElement(RepositoryHostSetupsSection, {
        repo,
        forceVisible: true,
        searchQuery: '',
        searchEntries: []
      })
    )
  })
}

function rowOf(setupId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-setup-id="${setupId}"]`)
  if (!row) {
    throw new Error(`no row for ${setupId}`)
  }
  return row
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('Settings hosts section: replica topology', () => {
  const local = gitRepo('local-copy')
  const remote = gitRepo('gpu-copy', { connectionId: 'gpu-vm' })

  it('shows provenance, membership, an unverified relation and the grouping evidence per replica', () => {
    seedStore([local, remote])

    renderSection(local)

    expect(container.querySelector('[data-replica-topology-section]')).not.toBeNull()
    const grouped = container.querySelectorAll('[data-replica-membership="grouped"]')
    expect(grouped).toHaveLength(2)
    for (const entry of Array.from(grouped)) {
      expect(entry.getAttribute('data-replica-provenance')).toBe('legacy')
      expect(entry.textContent).toContain('unverified')
    }
    expect(container.textContent).toContain(
      'Grouped by shared first commit abcdef1. Relation not verified yet'
    )
    expect(container.querySelectorAll('[data-replica-grouping-evidence]')).toHaveLength(1)
  })

  it('carries a host-health handle beside each replica and never colours inline', () => {
    seedStore([local, remote])

    renderSection(local)

    const health = Array.from(container.querySelectorAll('[data-replica-host-health]')).map(
      (element) => [
        element.closest('[data-setup-id]')?.getAttribute('data-setup-id'),
        element.getAttribute('data-replica-host-health')
      ]
    )
    expect(health).toEqual([
      ['local-copy', 'this-host'],
      ['gpu-copy', 'unknown']
    ])
    const inlineColour = Array.from(container.querySelectorAll('[style]')).filter((element) =>
      /color/i.test(element.getAttribute('style') ?? '')
    )
    expect(inlineColour).toHaveLength(0)
  })

  it('never reads Ready for a direct SSH replica whose connection state the renderer does not know', () => {
    seedStore([local, remote])

    renderSection(local)

    expect(rowOf('gpu-copy').textContent).not.toContain('Ready')
    expect(rowOf('gpu-copy').textContent).toContain('Unknown')
  })

  it('reads Ready and reachable once the SSH connection is connected (positive control)', () => {
    seedStore([local, remote], {
      sshConnectionStates: new Map([
        ['gpu-vm', { targetId: 'gpu-vm', status: 'connected', error: null, reconnectAttempt: 0 }]
      ])
    })

    renderSection(local)

    expect(
      rowOf('gpu-copy')
        .querySelector('[data-replica-host-health]')
        ?.getAttribute('data-replica-host-health')
    ).toBe('reachable')
    expect(rowOf('gpu-copy').textContent).toContain('Ready')
  })

  it('still renders, and lists the colliding copies, for a project with one setup', () => {
    const copyX = gitRepo('copy-x', { connectionId: 'gpu-vm', path: '/srv/x' })
    const copyY = gitRepo('copy-y', { connectionId: 'gpu-vm', path: '/srv/y' })
    seedStore([local, copyX, copyY])

    renderSection(local)

    expect(container.querySelector('[data-replica-topology-section]')).not.toBeNull()
    const collisions = container.querySelector('[data-replica-collisions]')
    expect(collisions).not.toBeNull()
    const items = Array.from(
      collisions?.querySelectorAll('li[data-replica-membership="colliding"]') ?? []
    )
    expect(items.map((item) => item.textContent)).toEqual([
      `${getExecutionHostLabel('ssh:gpu-vm')}/srv/x`,
      `${getExecutionHostLabel('ssh:gpu-vm')}/srv/y`
    ])
  })
})

describe('ReplicaRowTopology states', () => {
  const entry = (overrides: Partial<ReplicaTopologyEntry>): ReplicaTopologyEntry => ({
    setupId: 's',
    projectId: 'repo:s',
    hostId: 'local',
    path: '/srv/s',
    provenance: 'imported',
    membership: 'identity-pending',
    ...overrides
  })
  const html = (value: ReplicaTopologyEntry | undefined) =>
    renderToStaticMarkup(React.createElement(ReplicaRowTopology, { entry: value }))

  it('reads a pending identity as not checked yet', () => {
    expect(html(entry({}))).toContain('Identity not checked yet')
  })

  it('reads a host without the capability as not reported by its Orca version', () => {
    const markup = html(entry({ membershipReason: 'host-not-reporting' }))

    expect(markup).toContain('Not reported by this host&#x27;s Orca version')
    expect(markup).toContain('Identity not checked yet')
  })

  it.each([
    ['folder', 'Folder workspace: no cross-host identity'],
    ['unborn', 'No commits yet'],
    ['shallow', 'Shallow clone']
  ] as const)('gives a host-local replica its reason %s', (reason, text) => {
    expect(html(entry({ membership: 'host-local', membershipReason: reason }))).toContain(text)
  })

  it('says unknown, not blank, when no producer answered', () => {
    const markup = html(undefined)

    expect(markup).toContain('data-replica-membership="identity-pending"')
    expect(markup).toContain('Not reported by this host&#x27;s Orca version')
  })

  it('writes the relation as a word on a grouped replica only', () => {
    expect(html(entry({ membership: 'grouped', relation: 'unverified' }))).toContain('unverified')
    expect(html(entry({ membership: 'sole' }))).not.toContain('unverified')
  })
})

describe('getReplicaTopologyFromState', () => {
  it('is reference-stable and reads a runtime host without the capability as not reporting', () => {
    const runtimeRepo = gitRepo('rt', {
      executionHostId: 'runtime:old',
      gitRootIdentity: undefined
    })
    const statusWithout = new Map([
      ['old', { checkedAt: 1, status: { capabilities: [] } }]
    ]) as never
    const statusWith = new Map([
      [
        'old',
        { checkedAt: 1, status: { capabilities: [PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY] } }
      ]
    ]) as never

    const repos = [runtimeRepo]
    const first = getReplicaTopologyFromState({
      repos,
      runtimeStatusByEnvironmentId: statusWithout
    })

    expect(
      getReplicaTopologyFromState({
        repos,
        runtimeStatusByEnvironmentId: statusWithout
      })
    ).toBe(first)
    expect(first.get('rt')).toMatchObject({
      membership: 'identity-pending',
      membershipReason: 'host-not-reporting'
    })
    const capable = getReplicaTopologyFromState({
      repos,
      runtimeStatusByEnvironmentId: statusWith
    })
    expect(capable.get('rt')?.membershipReason).toBeUndefined()
  })
})
