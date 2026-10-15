// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { ReplicaPairView } from '../../../../shared/replica-pair-view'
import { useAppStore } from '../../store'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'

const pairClient = vi.hoisted(() => ({
  compareReplicaPairs: vi.fn(),
  readReplicaRelations: vi.fn()
}))
vi.mock('@/runtime/runtime-replica-pair-client', () => pairClient)

let container: HTMLDivElement
let root: Root

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName' | 'path'>): Repo {
  return { badgeColor: '#737373', addedAt: 100, kind: 'git', ...overrides }
}

beforeEach(() => {
  pairClient.compareReplicaPairs.mockReset()
  pairClient.readReplicaRelations.mockReset()
  pairClient.readReplicaRelations.mockResolvedValue({ status: 'ok', pairs: [] })
  pairClient.compareReplicaPairs.mockResolvedValue({ status: 'ok', pairs: [] })
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

describe('Settings hosts section: replica relations and Compare (row 62)', () => {
  const ROOT = 'abcdef1'.padEnd(40, '0')
  const TIPS = ['c'.repeat(40), 'c'.repeat(40)] as const
  const gitRepo = (id: string, overrides: Partial<Repo> = {}): Repo =>
    makeRepo({
      id,
      displayName: 'Orca',
      path: `/srv/${id}`,
      gitRemoteIdentity: null,
      gitRootIdentity: { rootCommit: ROOT, commonDir: `/srv/${id}/.git`, shallow: false },
      ...overrides
    })
  const local = gitRepo('local-copy')
  const remote = gitRepo('gpu-copy', { connectionId: 'gpu-vm' })

  const seed = (repos: Repo[], extra: Record<string, unknown> = {}): string => {
    const projection = projectHostSetupProjectionFromRepos(repos)
    useAppStore.setState({
      repos,
      projects: [...projection.projects],
      projectHostSetups: [...projection.setups],
      ...extra
    })
    return projection.setups[0].projectId
  }
  const pairView = (healthy: boolean): ReplicaPairView => ({
    setupId: 'gpu-copy',
    anchorSetupId: 'local-copy',
    hostId: 'ssh:gpu-vm',
    relation: { kind: 'same', observedTips: TIPS },
    healthy
  })
  const section = (repo: Repo) =>
    React.createElement(RepositoryHostSetupsSection, {
      repo,
      forceVisible: true,
      searchQuery: '',
      searchEntries: []
    })
  const compareButton = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[data-replica-compare-action]')
  const noteOf = (): string | null =>
    container.querySelector('[data-replica-pair-note]')?.getAttribute('data-replica-pair-note') ??
    null
  const relationOf = (setupId: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-setup-id="${setupId}"] [data-replica-relation]`)
  const mountAndFlush = async (element: React.ReactElement): Promise<void> => {
    act(() => {
      root.render(element)
    })
    await act(async () => {})
  }

  it('reads once for two sections mounted in the same commit, and again for a later mount', async () => {
    seed([local, remote])

    await mountAndFlush(React.createElement(React.Fragment, null, section(local), section(local)))

    expect(pairClient.readReplicaRelations).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().replicaPair.status).toBe('ready')

    await mountAndFlush(React.createElement(React.Fragment))
    await mountAndFlush(section(local))

    expect(pairClient.readReplicaRelations).toHaveBeenCalledTimes(2)
  })

  it('offers Compare with two setups and not with one (the section is rendered either way)', async () => {
    seed([local, remote])
    await mountAndFlush(section(local))
    expect(container.querySelector('[data-replica-topology-section]')).not.toBeNull()
    expect(compareButton()).not.toBeNull()

    const copyX = gitRepo('copy-x', { connectionId: 'gpu-vm', path: '/srv/x' })
    const copyY = gitRepo('copy-y', { connectionId: 'gpu-vm', path: '/srv/y' })
    useAppStore.setState(useAppStore.getInitialState(), true)
    seed([local, copyX, copyY])
    await mountAndFlush(section(local))

    expect(container.querySelector('[data-replica-topology-section]')).not.toBeNull()
    expect(compareButton()).toBeNull()
  })

  it('runs Compare once, disables the button while it is pending, then shows the relation of the other setup', async () => {
    const projectId = seed([local, remote])
    let answer!: (value: unknown) => void
    pairClient.compareReplicaPairs.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    await mountAndFlush(section(local))
    expect(compareButton()?.disabled).toBe(false)

    await act(async () => {
      compareButton()?.click()
    })

    expect(pairClient.compareReplicaPairs).toHaveBeenCalledTimes(1)
    expect(pairClient.compareReplicaPairs.mock.calls[0][1]).toBe(projectId)
    expect(compareButton()?.disabled).toBe(true)
    expect(compareButton()?.hasAttribute('data-replica-comparing')).toBe(true)

    await act(async () => {
      answer({ status: 'ok', pairs: [pairView(true)] })
    })

    expect(compareButton()?.disabled).toBe(false)
    expect(relationOf('gpu-copy')?.getAttribute('data-replica-relation')).toBe('same')
    expect(relationOf('gpu-copy')?.getAttribute('data-replica-relation-tone')).toBe('healthy')
  })

  it('disables Compare while the slice is loading', async () => {
    seed([local, remote], { replicaPair: { status: 'loading' } })

    await mountAndFlush(section(local))

    expect(compareButton()?.disabled).toBe(true)
    expect(pairClient.readReplicaRelations).not.toHaveBeenCalled()
  })

  it('keeps an equal-but-dirty pair unverified after Compare (control: clean reads same)', async () => {
    seed([local, remote])
    pairClient.compareReplicaPairs.mockResolvedValue({ status: 'ok', pairs: [pairView(false)] })
    await mountAndFlush(section(local))

    await act(async () => {
      compareButton()?.click()
    })

    expect(relationOf('gpu-copy')?.getAttribute('data-replica-relation')).toBe('unverified')
    expect(relationOf('gpu-copy')?.getAttribute('data-replica-relation-tone')).toBe('unknown')
  })

  it('states a remote-caller refusal in words, hides Compare and keeps rows unverified', async () => {
    seed([local, remote])
    pairClient.readReplicaRelations.mockResolvedValue({
      status: 'refused',
      reason: 'remote-caller'
    })

    await mountAndFlush(section(local))

    expect(noteOf()).toBe('remote-caller')
    expect(container.textContent).toContain('not available from this client')
    expect(compareButton()).toBeNull()
    expect(relationOf('gpu-copy')?.getAttribute('data-replica-relation')).toBe('unverified')
  })

  it('states a missing replica service with different words, hides Compare and keeps rows unverified', async () => {
    seed([local, remote])
    pairClient.readReplicaRelations.mockResolvedValue({
      status: 'unavailable',
      reason: 'no-replica-service'
    })

    await mountAndFlush(section(local))

    expect(noteOf()).toBe('no-replica-service')
    expect(container.textContent).not.toContain('not available from this client')
    expect(compareButton()).toBeNull()
    expect(relationOf('gpu-copy')?.getAttribute('data-replica-relation')).toBe('unverified')
  })

  it('states a failure without its raw message, keeps rows unverified, and recovers through Compare', async () => {
    seed([local, remote])
    pairClient.readReplicaRelations.mockRejectedValue(new Error('ECONNRESET 10.0.0.7'))

    await mountAndFlush(section(local))

    expect(noteOf()).toBe('failed')
    expect(container.querySelector('[data-replica-pair-note]')?.textContent).toContain(
      'Could not compare replicas'
    )
    expect(container.textContent).not.toContain('ECONNRESET')
    expect(compareButton()).not.toBeNull()
    expect(relationOf('gpu-copy')?.getAttribute('data-replica-relation')).toBe('unverified')

    pairClient.compareReplicaPairs.mockResolvedValue({ status: 'ok', pairs: [pairView(true)] })
    await act(async () => {
      compareButton()?.click()
    })

    expect(noteOf()).toBeNull()
    expect(relationOf('gpu-copy')?.getAttribute('data-replica-relation')).toBe('same')
  })

  it('starts no timer', async () => {
    vi.useFakeTimers()
    try {
      seed([local, remote])
      await mountAndFlush(section(local))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
