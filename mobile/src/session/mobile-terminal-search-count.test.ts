import { describe, expect, it } from 'vitest'
import { formatTerminalSearchCount } from './mobile-terminal-search-count'

describe('formatTerminalSearchCount', () => {
  it('says nothing before a query is typed or while the first answer is pending', () => {
    expect(formatTerminalSearchCount('', { resultIndex: 0, resultCount: 3 })).toBe('')
    expect(formatTerminalSearchCount('needle', null)).toBe('')
  })

  it('shows the active match as 1-based n/m', () => {
    expect(formatTerminalSearchCount('needle', { resultIndex: 0, resultCount: 3 })).toBe('1/3')
    expect(formatTerminalSearchCount('needle', { resultIndex: 2, resultCount: 3 })).toBe('3/3')
  })

  it('shows 0/0 when nothing matches', () => {
    expect(formatTerminalSearchCount('needle', { resultIndex: -1, resultCount: 0 })).toBe('0/0')
  })

  it('shows the count alone when matches exist but none is active', () => {
    expect(formatTerminalSearchCount('needle', { resultIndex: -1, resultCount: 1000 })).toBe('1000')
  })
})
