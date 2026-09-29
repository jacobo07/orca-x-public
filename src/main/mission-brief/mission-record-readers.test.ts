import { describe, expect, it } from 'vitest'
import { parseRalphRecord, samePath } from './ralph-mission-records'
import { parseStateMdRecord } from './state-md-record'

// Shape of a real GSD STATE.md (headings, frontmatter, bullet style); the content is invented.
const STATE_MD = [
  '---',
  'gsd_state_version: "1.0"',
  'current_phase: 03',
  'state_head: 0123456789abcdef0123456789abcdef01234567',
  '---',
  '',
  '# Project State',
  '',
  '## Current Position',
  '',
  'Phase: 02 (Provisioning) — EXECUTING',
  'Plan: 3 of 3',
  '',
  '## Accumulated Context',
  '',
  '### Decisions',
  '',
  '- OWNER DECISION NEEDED: pick the supplier (A|B), picked A',
  '',
  '### Blockers/Concerns',
  '',
  '- No product exists yet.',
  '- Provisioning fixes live on another lineage.',
  '',
  '## Performance Metrics'
].join('\r\n')

describe('parseStateMdRecord', () => {
  it('quotes the recorded commit, the prose position, blockers and owner decisions', () => {
    expect(parseStateMdRecord(STATE_MD)).toEqual({
      recordedHead: '0123456789abcdef0123456789abcdef01234567',
      positionPhase: '02',
      blockers: ['No product exists yet.', 'Provisioning fixes live on another lineage.'],
      ownerDecisions: ['OWNER DECISION NEEDED: pick the supplier (A|B), picked A']
    })
  })

  it('keeps a missing blockers section apart from an empty one', () => {
    expect(parseStateMdRecord('# State\n').blockers).toBeNull()
    expect(parseStateMdRecord('## Blockers\n\nNone.\n').blockers).toEqual([])
  })
})

describe('Ralph mission records', () => {
  it('reads the fields a real record carries, heartbeat in seconds', () => {
    expect(
      parseRalphRecord({
        mission_id: 'm-bb79185652b1',
        state: 'BLOCKED',
        reason: 'host: waiting for permission prompt',
        workstream: 'ub',
        cwd: 'C:\\Users\\User\\Apps\\orca-backlog-wt',
        work_dir: 'C:\\Users\\User\\Apps\\orca-backlog-wt',
        updated_at: 1790703448.2369213,
        owner: { heartbeat_at: 1790703139.8189924 }
      })
    ).toEqual({
      cwd: 'C:\\Users\\User\\Apps\\orca-backlog-wt',
      missionId: 'm-bb79185652b1',
      state: 'BLOCKED',
      reason: 'host: waiting for permission prompt',
      workstream: 'ub',
      heartbeatAtMs: 1790703139819,
      updatedAtMs: 1790703448237
    })
  })

  it('refuses a record without identity or location', () => {
    expect(parseRalphRecord({ state: 'RUNNING', cwd: '/x' })).toBeNull()
    expect(parseRalphRecord('nope')).toBeNull()
  })

  it('matches a workspace path case-insensitively on Windows only', () => {
    expect(samePath('C:\\Apps\\Orca\\', 'c:\\apps\\orca', 'win32')).toBe(true)
    expect(samePath('/work/Orca', '/work/orca', 'linux')).toBe(false)
  })
})
