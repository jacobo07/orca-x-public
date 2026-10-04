import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GhUtils from './gh-utils'

const { ghExecFileAsyncMock, getIssueOwnerRepoMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock,
    getIssueOwnerRepo: getIssueOwnerRepoMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  return {
    ...actual,
    getIssueGitHubApiRepository: async () => {
      const ownerRepo = await getIssueOwnerRepoMock()
      return ownerRepo ? { host: 'github.com' as const, ...ownerRepo } : null
    }
  }
})

import { getIssue } from './issues'
import { ISSUE_LOOKUP_FAILURE_MESSAGES } from '../../shared/github/issue-lookup-failure'

describe('getIssue lookup failure', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
  })

  it('resolves null when gh positively reports the issue is not found', async () => {
    // Arrange
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('gh: Not Found (HTTP 404)'))

    // Act
    const result = await getIssue('/repo-root', 923)

    // Assert
    expect(result).toBeNull()
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a timeout', 'context deadline exceeded: timeout'],
    ['a bad gateway', 'gh: Bad Gateway (HTTP 502)'],
    ['a network failure', 'dial tcp: lookup api.github.com: no such host'],
    ['a rate limit', 'gh: API rate limit exceeded (HTTP 403)'],
    ['an unclassified failure', 'boom']
  ])('rejects instead of resolving null on %s', async (_label, message) => {
    // Arrange
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error(message))

    // Act
    const lookup = getIssue('/repo-root', 923)

    // Assert
    await expect(lookup).rejects.toBeInstanceOf(Error)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('rejects when gh answers with a body that is not an issue', async () => {
    // Arrange
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '<html>captive portal</html>' })

    // Act
    const lookup = getIssue('/repo-root', 923)

    // Assert
    await expect(lookup).rejects.toBeInstanceOf(Error)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('rejects instead of resolving null when a connection-backed request has no resolvable owner/repo', async () => {
    // Arrange
    getIssueOwnerRepoMock.mockResolvedValue(null)

    // Act
    const lookup = getIssue('/remote/repo', 923, 'ssh-conn-1')

    // Assert
    await expect(lookup).rejects.toThrow('Could not resolve GitHub owner/repo for this repository')
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('still reads a local non-GitHub remote through gh issue view when owner/repo is unresolved', async () => {
    // Arrange
    getIssueOwnerRepoMock.mockResolvedValue(null)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 923, title: 'T', state: 'OPEN', url: 'u', labels: [] })
    })

    // Act
    const result = await getIssue('/repo-root', 923)

    // Assert
    expect(result).toMatchObject({ number: 923, title: 'T' })
    expect(ghExecFileAsyncMock.mock.calls[0][0].slice(0, 2)).toEqual(['issue', 'view'])
  })

  it('does not put raw gh stderr into the rejection the renderer sees', async () => {
    // Arrange
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('boom token=ghp_SECRET'))

    // Act
    const lookup = getIssue('/repo-root', 923)

    // Assert
    await expect(lookup).rejects.toThrow(/Failed to load issue/)
    await expect(lookup).rejects.not.toThrow(/ghp_SECRET/)
  })

  it.each([
    ['permission_denied', 'gh: Forbidden (HTTP 403) token=ghp_SECRET'],
    ['issues_disabled', 'gh: the repository has disabled issues token=ghp_SECRET'],
    ['validation_error', 'gh: Validation Failed (HTTP 422) token=ghp_SECRET'],
    ['rate_limited', 'gh: API rate limit exceeded (HTTP 403) token=ghp_SECRET'],
    ['network_error', 'dial tcp: lookup api.github.com: no such host token=ghp_SECRET'],
    ['unknown', 'boom token=ghp_SECRET']
  ] as const)(
    'rejects a %s failure with its fixed message and no raw stderr',
    async (type, stderr) => {
      // Arrange
      ghExecFileAsyncMock.mockRejectedValueOnce(new Error(stderr))

      // Act
      const lookup = getIssue('/repo-root', 923)

      // Assert
      await expect(lookup).rejects.toThrow(new RegExp(`^${ISSUE_LOOKUP_FAILURE_MESSAGES[type]}$`))
      await expect(lookup).rejects.not.toThrow(/ghp_SECRET/)
    }
  )

  it('rejects an unresolved connection-backed repository with the shared fixed message', async () => {
    // Arrange
    getIssueOwnerRepoMock.mockResolvedValue(null)

    // Act
    const lookup = getIssue('/remote/repo', 923, 'ssh-conn-1')

    // Assert
    await expect(lookup).rejects.toThrow(ISSUE_LOOKUP_FAILURE_MESSAGES.unresolved_repository)
  })
})
