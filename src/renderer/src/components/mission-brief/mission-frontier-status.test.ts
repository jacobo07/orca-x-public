import { describe, expect, it } from 'vitest'
import { describeFrontierStatus } from './mission-frontier-status'

describe('describeFrontierStatus', () => {
  it("translates GSD's lifecycle labels instead of showing the raw token", () => {
    expect(describeFrontierStatus('planning')).toBe('Planning')
    expect(describeFrontierStatus('executing')).toBe('Executing')
    expect(describeFrontierStatus('Ready to execute')).toBe('Ready to execute')
    expect(describeFrontierStatus('Phase complete')).toBe('Phase complete')
  })

  it('reads the spellings real STATE.md files use for the same label', () => {
    expect(describeFrontierStatus('in-progress')).toBe('In progress')
    expect(describeFrontierStatus('in_progress')).toBe('In progress')
    expect(describeFrontierStatus('In progress')).toBe('In progress')
  })

  it('quotes a label it does not know rather than dropping or guessing it', () => {
    expect(describeFrontierStatus('owner_boundary')).toBe('Recorded as “owner_boundary”')
  })

  it('shows nothing when no status is recorded', () => {
    expect(describeFrontierStatus(null)).toBeNull()
    expect(describeFrontierStatus('  ')).toBeNull()
  })
})
