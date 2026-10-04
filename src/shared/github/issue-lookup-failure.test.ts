import { describe, expect, it } from 'vitest'
import {
  ISSUE_LOOKUP_FAILURE_MESSAGES,
  classifyIssueLookupFailure,
  issueLookupBackoffMs
} from './issue-lookup-failure'

describe('classifyIssueLookupFailure', () => {
  it.each([
    ['permission_denied', 'permanent'],
    ['issues_disabled', 'permanent'],
    ['validation_error', 'permanent'],
    ['unresolved_repository', 'permanent'],
    ['rate_limited', 'rate_limited'],
    ['network_error', 'transient'],
    ['unknown', 'transient']
  ] as const)('reads the %s message as %s', (type, kind) => {
    // Arrange
    const err = new Error(ISSUE_LOOKUP_FAILURE_MESSAGES[type])

    // Act
    const result = classifyIssueLookupFailure(err)

    // Assert
    expect(result).toBe(kind)
  })

  it('still recognises the message after Electron wraps an invoke rejection', () => {
    // Arrange
    const wrapped = new Error(
      `Error invoking remote method 'gh:issue': Error: ${ISSUE_LOOKUP_FAILURE_MESSAGES.permission_denied}`
    )

    // Act
    const result = classifyIssueLookupFailure(wrapped)

    // Assert
    expect(result).toBe('permanent')
  })

  it('treats a message from an older host as transient', () => {
    // Arrange
    const err = new Error('HTTP 502')

    // Act
    const result = classifyIssueLookupFailure(err)

    // Assert
    expect(result).toBe('transient')
  })
})

describe('issueLookupBackoffMs', () => {
  it('doubles a transient backoff per attempt up to a cap', () => {
    // Arrange
    const delays = [1, 2, 3, 10].map((attempts) => issueLookupBackoffMs('transient', attempts))

    // Assert
    expect(delays[0]).toBeGreaterThan(0)
    expect(delays[1]).toBe(delays[0] * 2)
    expect(delays[2]).toBe(delays[0] * 4)
    expect(delays[3]).toBeLessThanOrEqual(120_000)
  })

  it('waits longer for a permanent or rate-limited failure than for a first transient one', () => {
    // Arrange
    const first = issueLookupBackoffMs('transient', 1)

    // Assert
    expect(issueLookupBackoffMs('permanent', 1)).toBeGreaterThan(first)
    expect(issueLookupBackoffMs('rate_limited', 1)).toBeGreaterThan(first)
  })
})
