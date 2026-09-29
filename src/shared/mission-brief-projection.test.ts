import { describe, expect, it } from 'vitest'
import ubInspect from './__fixtures__/mission-brief/backlog-ub.planning.json'
import ubRoadmap from './__fixtures__/mission-brief/backlog-ub.roadmap.json'
import ubSmart from './__fixtures__/mission-brief/backlog-ub.smart-entry.json'
import smokeInspect from './__fixtures__/mission-brief/gsd-long-smoke.planning.json'
import smokeRoadmap from './__fixtures__/mission-brief/gsd-long-smoke.roadmap.json'
import smokeSmart from './__fixtures__/mission-brief/gsd-long-smoke.smart-entry.json'
import { LIVE_HEARTBEAT_MS, projectMissionBrief } from './mission-brief-projection'
import type { MissionReadings, RalphMissionRecord } from './mission-brief-types'

const NOW = 1_790_700_000_000
const HEAD = 'd7fe79299aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function readings(overrides: Partial<MissionReadings> = {}): MissionReadings {
  return {
    workstream: 'ub',
    stateFile: '.planning/workstreams/ub/STATE.md',
    inspect: ubInspect,
    roadmap: ubRoadmap,
    smartEntry: ubSmart,
    stateRecord: { recordedHead: HEAD, positionPhase: null, blockers: null, ownerDecisions: [] },
    git: { kind: 'read', head: HEAD, commitsSinceRecorded: 0 },
    missions: [],
    readAt: NOW,
    ...overrides
  }
}

function mission(overrides: Partial<RalphMissionRecord>): RalphMissionRecord {
  return {
    missionId: 'm-1',
    state: 'RUNNING',
    reason: '',
    workstream: 'ub',
    heartbeatAtMs: NOW - 1000,
    updatedAtMs: NOW - 1000,
    ...overrides
  }
}

/** The real `ub` roadmap with one phase edited, so a case stays rooted in real GSD output. */
function ubRoadmapWith(number: string, patch: Record<string, unknown>): unknown {
  return {
    ...ubRoadmap,
    phases: ubRoadmap.phases.map((phase) =>
      phase.number === number ? { ...phase, ...patch } : phase
    )
  }
}

function ubInspectWithVerification(phaseId: string, status: string, nextAction: string): unknown {
  return {
    ...ubInspect,
    phases: ubInspect.phases.map((phase) =>
      phase.phase_id === phaseId
        ? { ...phase, verification: { status, next_action: nextAction } }
        : phase
    )
  }
}

describe('projectMissionBrief — real GSD output', () => {
  it('reads the objective, frontier and next step a real workstream records', () => {
    const brief = projectMissionBrief(readings(), NOW)
    expect(brief.objective).toEqual({
      kind: 'known',
      text: 'Orca X Universal Backlog / Intent Ledger',
      partial: false
    })
    expect(brief.frontier).toMatchObject({ kind: 'known', stageId: '1' })
    expect(brief.stages.map((stage) => stage.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    expect(brief.stages[0].state).toBe('current')
    expect(brief.nextAction).toEqual({
      kind: 'known',
      label: 'Advance to the next step',
      command: '/gsd:progress --next',
      situation: 'executing'
    })
    expect(brief.signal).toBe('next')
  })

  it('never renders a GSD percentage', () => {
    // smart-entry's summary for this fixture is "Phase 1 of 8 · 50% · executing".
    expect(JSON.stringify(projectMissionBrief(readings(), NOW))).not.toContain('%')
  })

  it('does not call a phase verified when GSD found no verification report', () => {
    const brief = projectMissionBrief(readings(), NOW)
    expect(brief.stages.some((stage) => stage.state === 'proven')).toBe(false)
    expect(brief.lastVerified).toEqual({ kind: 'none', nearest: null })
  })

  it('unlocks only phases the frontier makes reachable', () => {
    // Real deps: 2 ← 1; 3 ← 1, 2; 7 ← 1–6. Finishing 1 reaches 2 only.
    const unlocks = projectMissionBrief(readings(), NOW).unlocks
    expect(unlocks).toEqual([{ stageId: '2', name: expect.any(String) }])
  })

  it('counts a proven sibling dependency as met', () => {
    const inspect = {
      ...ubInspect,
      phases: [
        ...ubInspect.phases,
        {
          ...ubInspect.phases[0],
          phase_id: '02',
          verification: { status: 'passed', next_action: '' }
        }
      ]
    }
    const unlocks = projectMissionBrief(readings({ inspect }), NOW).unlocks
    expect(unlocks.map((unlock) => unlock.stageId)).toEqual(['3'])
  })

  it('keeps an external condition in depends_on instead of dropping it', () => {
    const stage6 = projectMissionBrief(readings(), NOW).stages.find((stage) => stage.id === '6')
    expect(stage6?.dependsOn).toEqual(['5'])
    expect(stage6?.externalDependency).toBe('the provider pane shipping the contract')
  })

  it('marks a truncated milestone read as partial and expands a phase range', () => {
    const brief = projectMissionBrief(
      readings({
        inspect: smokeInspect,
        roadmap: smokeRoadmap,
        smartEntry: smokeSmart,
        workstream: null
      }),
      NOW
    )
    expect(brief.objective).toEqual({
      kind: 'known',
      text: 'v1 GSD Smoke compaction canary',
      partial: true
    })
    expect(brief.stages.find((stage) => stage.id === '8')?.dependsOn).toEqual([
      '2',
      '3',
      '4',
      '5',
      '6',
      '7'
    ])
  })
})

describe('projectMissionBrief — claims need evidence', () => {
  it('reports a ticked phase without a passed verification as claimed, not complete', () => {
    const brief = projectMissionBrief(
      readings({ roadmap: ubRoadmapWith('2', { roadmap_complete: true }) }),
      NOW
    )
    expect(brief.stages.find((stage) => stage.id === '2')?.state).toBe('claimed')
    expect(brief.contradictions).toContainEqual({
      kind: 'claimed-without-verification',
      stageId: '2',
      verification: null
    })
    // Phase 2 depends on phase 1, which is still the frontier.
    expect(brief.contradictions).toContainEqual({
      kind: 'claimed-with-open-dependency',
      stageId: '2',
      dependencyId: '1'
    })
  })

  it('reports a passed verification as the last verified result', () => {
    const brief = projectMissionBrief(
      readings({
        inspect: ubInspectWithVerification('01', 'passed', 'Verification passed — continue.')
      }),
      NOW
    )
    expect(brief.stages[0].state).toBe('proven')
    expect(brief.lastVerified).toMatchObject({ kind: 'verified', stageId: '1' })
  })

  it('surfaces a frontier the STATE.md prose disagrees with', () => {
    const brief = projectMissionBrief(
      readings({
        stateRecord: { recordedHead: HEAD, positionPhase: '02', blockers: null, ownerDecisions: [] }
      }),
      NOW
    )
    expect(brief.contradictions[0]).toEqual({
      kind: 'frontier-disagrees',
      recorded: '2',
      active: '1'
    })
  })
})

describe('projectMissionBrief — who is needed', () => {
  it('raises a blocked mission as needing the human, with its reason verbatim', () => {
    const brief = projectMissionBrief(
      readings({
        missions: [mission({ state: 'BLOCKED', reason: 'host: waiting for permission prompt' })]
      }),
      NOW
    )
    expect(brief.humanAttention).toEqual([
      { source: 'ralph-mission', missionId: 'm-1', reason: 'host: waiting for permission prompt' }
    ])
    expect(brief.signal).toBe('needs-you')
  })

  it('reads only the latest mission record for the workspace', () => {
    const brief = projectMissionBrief(
      readings({
        missions: [
          mission({ missionId: 'm-new', state: 'HALTED', reason: 'budget: iterations 8 >= max 8' }),
          mission({ missionId: 'm-old', state: 'BLOCKED', reason: 'old prompt' })
        ]
      }),
      NOW
    )
    expect(brief.humanAttention).toEqual([])
    expect(brief.haltedRun).toEqual({ missionId: 'm-new', reason: 'budget: iterations 8 >= max 8' })
  })

  it('raises a human verification GSD asked for', () => {
    const brief = projectMissionBrief(
      readings({
        inspect: ubInspectWithVerification('01', 'human_needed', 'Complete the manual tests.')
      }),
      NOW
    )
    expect(brief.humanAttention).toContainEqual({
      source: 'gsd-verification',
      stageId: '1',
      nextAction: 'Complete the manual tests.'
    })
  })

  it('does not call work autonomous when its heartbeat has gone quiet', () => {
    const quiet = projectMissionBrief(
      readings({ missions: [mission({ heartbeatAtMs: NOW - LIVE_HEARTBEAT_MS - 1 })] }),
      NOW
    )
    expect(quiet.autonomous[0].live).toBe(false)
    expect(quiet.signal).toBe('next')
    const live = projectMissionBrief(readings({ missions: [mission({})] }), NOW)
    expect(live.signal).toBe('autonomous')
  })
})

describe('projectMissionBrief — absence stays absence', () => {
  it('invents nothing when every producer failed', () => {
    const brief = projectMissionBrief(
      readings({
        inspect: null,
        roadmap: { error: 'x' },
        smartEntry: 'garbage',
        stateRecord: null
      }),
      NOW
    )
    expect(brief.objective).toEqual({ kind: 'unknown' })
    expect(brief.frontier).toEqual({ kind: 'unknown' })
    expect(brief.stages).toEqual([])
    expect(brief.nextAction).toEqual({ kind: 'unknown' })
    expect(brief.blockers).toEqual({ kind: 'not-recorded' })
    expect(brief.freshness).toEqual({ kind: 'unknown', reason: 'no-recorded-head' })
    expect(brief.signal).toBe('unknown')
  })

  it('treats a milestone GSD could not scope as an unknown objective, whatever it carries', () => {
    const inspect = { ...ubInspect, milestone: { version: 'v1', name: 'Guess', scope: 'unscoped' } }
    expect(projectMissionBrief(readings({ inspect }), NOW).objective).toEqual({ kind: 'unknown' })
  })

  it('distinguishes an empty blockers section from a missing one', () => {
    const empty = projectMissionBrief(
      readings({
        stateRecord: { recordedHead: HEAD, positionPhase: null, blockers: [], ownerDecisions: [] }
      }),
      NOW
    )
    expect(empty.blockers).toEqual({ kind: 'recorded', lines: [] })
  })

  it('reports the brief stale when HEAD moved past the recorded commit', () => {
    const stale = projectMissionBrief(
      readings({ git: { kind: 'read', head: 'b'.repeat(40), commitsSinceRecorded: 3 } }),
      NOW
    )
    expect(stale.freshness).toEqual({
      kind: 'stale',
      recordedHead: HEAD,
      head: 'b'.repeat(40),
      commitsSince: 3
    })
    const unreadable = projectMissionBrief(readings({ git: { kind: 'unreadable' } }), NOW)
    expect(unreadable.freshness).toEqual({ kind: 'unknown', reason: 'git-unreadable' })
  })
})
