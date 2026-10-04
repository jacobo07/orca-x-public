// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { issueCacheKey } from '@/store/slices/github'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'
import { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'

const originalState = useAppStore.getState()
const settings = {} as GlobalSettings
const repo = {
  id: 'repo-1',
  path: '/repo/one',
  displayName: 'One',
  badgeColor: '#000000',
  addedAt: 1
} as Repo
const worktree = {
  id: 'repo-1::/repo/one/wt',
  repoId: 'repo-1',
  path: '/repo/one/wt',
  displayName: 'Card',
  branch: 'refs/heads/feature/card',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: 42,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
} as Worktree

let root: Root | null = null
let container: HTMLDivElement | null = null
let issueTitle: string | undefined

// Why: the same selector-to-display chain the card controller wires, minus the unrelated foundation hooks.
function Probe() {
  const review = useWorktreeCardReviewDetails({
    worktree,
    repo,
    settings,
    projectGroups: [],
    cardProps: [],
    newCardStyle: false
  } as never)
  const linked = useWorktreeCardLinkedDetails({
    worktree,
    newCardStyle: false,
    deleteState: undefined,
    branch: review.branch,
    issueEntry: review.issueEntry,
    issueFailure: review.issueFailure,
    linearIssueEntry: review.linearIssueEntry,
    linearIssueFallbackEntry: review.linearIssueFallbackEntry,
    prDisplay: review.prDisplay
  } as never)
  issueTitle = linked.issueDisplay?.title
  return null
}

describe('the linked-issue card state', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    issueTitle = undefined
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    container?.remove()
    container = null
    useAppStore.setState(originalState, true)
  })

  const key = (): string =>
    issueCacheKey(repo.path, repo.id, 42, settings, repo.connectionId, repo.executionHostId, true)

  it('reads a recorded lookup failure as "Issue details unavailable", not an endless "Loading issue..."', () => {
    // Arrange
    useAppStore.setState({
      issueCache: {},
      issueLookupFailureCache: { [key()]: { fetchedAt: 1, kind: 'transient', attempts: 1 } }
    } as never)

    // Act
    act(() => root?.render(<Probe />))

    // Assert
    expect(issueTitle).toBe('Issue details unavailable')
  })

  it('control: with no recorded failure and no answer yet, the card is still loading', () => {
    // Arrange
    useAppStore.setState({ issueCache: {}, issueLookupFailureCache: {} } as never)

    // Act
    act(() => root?.render(<Probe />))

    // Assert
    expect(issueTitle).toBe('Loading issue...')
  })
})
