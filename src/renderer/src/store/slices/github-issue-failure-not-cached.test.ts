import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueCacheKey } from './github'
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

function cacheKeys(store: ReturnType<typeof createTestStore>): string[] {
  return Object.keys(store.getState().issueCache)
}

describe('createGitHubSlice.fetchIssue failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    // Why: clearAllMocks keeps queued once-values, so one failing case would leak into the next.
    mockApi.gh.issue.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  })

  it('leaves the cache untouched when the lookup rejects, and the next call fetches again', async () => {
    // Arrange
    const store = createTestStore()
    mockApi.gh.issue.mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValueOnce(issue)

    // Act
    const failed = await store.getState().fetchIssue(repoPath, 7, { repoId })
    const keysAfterFailure = cacheKeys(store)
    const retried = await store.getState().fetchIssue(repoPath, 7, { repoId })

    // Assert
    expect(failed).toBeNull()
    expect(keysAfterFailure).toEqual([])
    expect(mockApi.gh.issue).toHaveBeenCalledTimes(2)
    expect(retried).toMatchObject({ number: 7 })
  })

  it('keeps a previous success, with its old fetchedAt, when a later lookup rejects', async () => {
    // Arrange
    const store = createTestStore()
    mockApi.gh.issue.mockResolvedValueOnce(issue).mockRejectedValueOnce(new Error('timeout'))
    await store.getState().fetchIssue(repoPath, 7, { repoId })
    const [key] = cacheKeys(store)
    const before = store.getState().issueCache[key]

    // Act
    vi.advanceTimersByTime(10)
    const stale = await store.getState().fetchIssue(repoPath, 7, { repoId, maxAgeMs: 0 })

    // Assert
    expect(stale).toMatchObject({ number: 7 })
    expect(store.getState().issueCache[key]).toEqual(before)
    expect(mockApi.gh.issue).toHaveBeenCalledTimes(2)
  })

  it('still caches a successful not-found answer as null', async () => {
    // Arrange
    const store = createTestStore()
    mockApi.gh.issue.mockResolvedValueOnce(null)

    // Act
    const first = await store.getState().fetchIssue(repoPath, 8, { repoId })
    const second = await store.getState().fetchIssue(repoPath, 8, { repoId })

    // Assert
    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(mockApi.gh.issue).toHaveBeenCalledTimes(1)
    expect(cacheKeys(store)).toHaveLength(1)
    expect(issueCacheKey).toBeTypeOf('function')
  })
})
