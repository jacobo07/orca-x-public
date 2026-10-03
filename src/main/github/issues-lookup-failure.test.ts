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
    getIssueGitHubApiRepository: async () => ({
      host: 'github.com' as const,
      ...(await getIssueOwnerRepoMock())
    })
  }
})

import { getIssue } from './issues'

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

  it('does not put raw gh stderr into the rejection the renderer sees', async () => {
    // Arrange
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('boom token=ghp_SECRET'))

    // Act
    const lookup = getIssue('/repo-root', 923)

    // Assert
    await expect(lookup).rejects.toThrow(/Failed to load issue/)
    await expect(lookup).rejects.not.toThrow(/ghp_SECRET/)
  })
})
