import { describe, expect, it } from 'vitest'
import { getLinkedIssuePlaceholderTitle } from './worktree-card-linked-issue-placeholder'

describe('getLinkedIssuePlaceholderTitle', () => {
  it('says the details are loading while nothing has been answered or failed', () => {
    // Arrange / Act
    const title = getLinkedIssuePlaceholderTitle(undefined, undefined)

    // Assert
    expect(title).toBe('Loading issue...')
  })

  it('says the details are unavailable after a lookup failed, instead of loading forever', () => {
    // Arrange
    const failure = { fetchedAt: 1, kind: 'permanent', attempts: 1 } as const

    // Act
    const title = getLinkedIssuePlaceholderTitle(undefined, failure)

    // Assert
    expect(title).toBe('Issue details unavailable')
  })

  it('says the details are unavailable when the lookup answered that there is no issue', () => {
    // Arrange / Act
    const title = getLinkedIssuePlaceholderTitle(null, undefined)

    // Assert
    expect(title).toBe('Issue details unavailable')
  })
})
