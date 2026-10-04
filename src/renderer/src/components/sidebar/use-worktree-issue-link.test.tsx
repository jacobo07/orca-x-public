// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { useWorktreeIssueLink } from './use-worktree-issue-link'

const originalState = useAppStore.getState()
const REPO = { id: 'repo-1', path: '/repo/one', displayName: 'One' } as Repo

let root: Root | null = null
let container: HTMLDivElement | null = null
let latest: ReturnType<typeof useWorktreeIssueLink> | null = null

function Probe() {
  latest = useWorktreeIssueLink({
    worktreeId: 'repo-1::/repo/one/wt',
    ownerRepoId: 'repo-1',
    issueInput: '7',
    issueProvider: 'github'
  })
  return null
}

describe('useWorktreeIssueLink handleOpenIssue', () => {
  const openUrl = vi.fn()

  beforeEach(() => {
    openUrl.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { shell: { openUrl } }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    container?.remove()
    container = null
    latest = null
    useAppStore.setState(originalState, true)
  })

  it('looks the issue up as an explicit action, so the automatic failure backoff cannot refuse the click', async () => {
    // Arrange
    const fetchIssue = vi.fn(async () => ({ url: 'https://github.com/o/r/issues/7' }))
    useAppStore.setState({ repos: [REPO], issueCache: {}, fetchIssue } as never)
    act(() => root?.render(<Probe />))

    // Act
    await act(async () => {
      await latest?.handleOpenIssue()
    })

    // Assert
    expect(fetchIssue).toHaveBeenCalledWith(
      REPO.path,
      7,
      expect.objectContaining({ repoId: REPO.id, bypassFailureBackoff: true })
    )
    expect(openUrl).toHaveBeenCalledWith('https://github.com/o/r/issues/7')
  })
})
