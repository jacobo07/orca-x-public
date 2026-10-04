import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ISSUE_LOOKUP_FAILURE_MESSAGES } from '../../../../shared/github/issue-lookup-failure'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'

const repoPath = '/repo/one'
const repoId = 'repo-1'
const issue = {
  number: 7,
  title: 'Seven',
  state: 'open',
  url: 'https://example.com/issues/7',
  labels: []
}

function failureEntries(store: ReturnType<typeof createTestStore>) {
  return Object.values(store.getState().issueLookupFailureCache)
}

describe('createGitHubSlice.fetchIssue lookup failure state and backoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.issue.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  })

  it('records a permanent failure in its own state, not in the answer cache', async () => {
    // Arrange
    const store = createTestStore()
    mockApi.gh.issue.mockRejectedValueOnce(
      new Error(ISSUE_LOOKUP_FAILURE_MESSAGES.permission_denied)
    )

    // Act
    await store.getState().fetchIssue(repoPath, 7, { repoId })

    // Assert
    expect(Object.keys(store.getState().issueCache)).toEqual([])
    expect(failureEntries(store)).toMatchObject([{ kind: 'permanent', attempts: 1 }])
  })

  it('does not ask again while a permanent failure is inside its backoff, then asks once it has passed', async () => {
    // Arrange
    const store = createTestStore()
    mockApi.gh.issue
      .mockRejectedValueOnce(new Error(ISSUE_LOOKUP_FAILURE_MESSAGES.issues_disabled))
      .mockResolvedValueOnce(issue)
    await store.getState().fetchIssue(repoPath, 7, { repoId })

    // Act
    vi.advanceTimersByTime(30_000)
    const duringBackoff = await store.getState().fetchIssue(repoPath, 7, { repoId, maxAgeMs: 0 })
    const callsDuringBackoff = mockApi.gh.issue.mock.calls.length
    vi.advanceTimersByTime(300_000)
    const afterBackoff = await store.getState().fetchIssue(repoPath, 7, { repoId })

    // Assert
    expect(duringBackoff).toBeNull()
    expect(callsDuringBackoff).toBe(1)
    expect(afterBackoff).toMatchObject({ number: 7 })
    expect(mockApi.gh.issue).toHaveBeenCalledTimes(2)
  })

  it('lets a transient failure retry sooner and backs off longer on each repeat', async () => {
    // Arrange
    const store = createTestStore()
    mockApi.gh.issue.mockRejectedValue(new Error('HTTP 502'))
    await store.getState().fetchIssue(repoPath, 7, { repoId })
    const firstDelay = (() => {
      const [entry] = failureEntries(store)
      return entry.fetchedAt
    })()

    // Act
    vi.advanceTimersByTime(6_000)
    await store.getState().fetchIssue(repoPath, 7, { repoId })
    const secondFailure = failureEntries(store)[0]
    vi.advanceTimersByTime(6_000)
    await store.getState().fetchIssue(repoPath, 7, { repoId })

    // Assert
    expect(firstDelay).toBeGreaterThan(0)
    expect(secondFailure.attempts).toBe(2)
    expect(mockApi.gh.issue).toHaveBeenCalledTimes(2)
  })

  it('clears the failure state once a lookup succeeds', async () => {
    // Arrange
    const store = createTestStore()
    mockApi.gh.issue.mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValueOnce(issue)
    await store.getState().fetchIssue(repoPath, 7, { repoId })

    // Act
    vi.advanceTimersByTime(10_000)
    await store.getState().fetchIssue(repoPath, 7, { repoId })

    // Assert
    expect(failureEntries(store)).toEqual([])
  })

  it('drops the failure state when the repo caches are evicted', async () => {
    // Arrange
    const store = createTestStore()
    mockApi.gh.issue.mockRejectedValueOnce(new Error('HTTP 502'))
    await store.getState().fetchIssue(repoPath, 7, { repoId })

    // Act
    store.getState().evictGitHubRepoCaches(repoId, repoPath)

    // Assert
    expect(failureEntries(store)).toEqual([])
  })
})
