import { describe, expect, it } from 'vitest'
import type { MissionBriefResult } from '../../../../shared/mission-brief-types'
import { describeFailure } from './mission-failure-presentation'

type Failed = Extract<MissionBriefResult, { status: 'failed' }>

const failed = (overrides: Partial<Failed>): Failed => ({
  status: 'failed',
  stage: 'gsd',
  reason: 'failed',
  detail: 'planning-inspect: Error: boom',
  ...overrides
})

describe('describeFailure', () => {
  it('tells a partial GSD install apart and says what fixes it', () => {
    const view = describeFailure(failed({ reason: 'install-incomplete' }))
    expect(view.sentence).toBe("GSD's installation on this machine is incomplete.")
    expect(view.action).toBe('Reinstall or update GSD, then re-read.')
  })

  it('never renders the technical cause as the sentence, but keeps it for the disclosure', () => {
    for (const reason of ['install-incomplete', 'timed-out', 'bad-output', 'failed'] as const) {
      const view = describeFailure(failed({ reason, detail: 'planning-inspect: Error: xyz' }))
      expect(view.sentence).not.toContain('xyz')
      expect(view.action).not.toContain('xyz')
      expect(view.detail).toBe('planning-inspect: Error: xyz')
    }
  })

  it("separates GSD's failure from Orca's own", () => {
    expect(describeFailure(failed({ stage: 'gsd' })).sentence).toBe(
      "GSD could not read this workspace's mission records."
    )
    expect(describeFailure(failed({ stage: 'read' })).sentence).toBe(
      'Orca could not read the mission records.'
    )
  })
})
