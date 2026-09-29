import { describe, expect, it } from 'vitest'
import ubInspect from './__fixtures__/mission-brief/backlog-ub.planning.json'
import ubRoadmap from './__fixtures__/mission-brief/backlog-ub.roadmap.json'
import ubSmart from './__fixtures__/mission-brief/backlog-ub.smart-entry.json'
import { projectMissionBrief } from './mission-brief-projection'
import type { MissionReadings } from './mission-brief-types'

const NOW = 1_790_700_000_000
const MILESTONE = 'Orca X Universal Backlog / Intent Ledger'
const PROJECT = '.planning/workstreams/ub/PROJECT.md'
const STATE = '.planning/workstreams/ub/STATE.md'

function brief(overrides: Partial<MissionReadings>) {
  return projectMissionBrief(
    {
      workstream: 'ub',
      stateFile: STATE,
      inspect: ubInspect,
      roadmap: ubRoadmap,
      smartEntry: ubSmart,
      stateRecord: null,
      projectFile: null,
      projectRecord: null,
      recordFiles: { kind: 'listed', files: [], truncated: false },
      git: { kind: 'unreadable' },
      missions: [],
      readAt: NOW,
      ...overrides
    },
    NOW
  )
}

describe('objective — PROJECT.md before the milestone', () => {
  it('states the goal from What this is, and keeps the milestone beside it', () => {
    const result = brief({
      projectFile: PROJECT,
      projectRecord: { whatThisIs: 'Make every intent durable.', coreValue: 'Nothing is lost.' }
    })
    expect(result.objective).toEqual({
      kind: 'known',
      source: 'project-md',
      section: 'what-this-is',
      text: 'Make every intent durable.',
      file: PROJECT
    })
    expect(result.milestone).toEqual({ kind: 'known', text: MILESTONE, partial: false })
  })

  it('falls back to the core value when What this is is missing', () => {
    const result = brief({
      projectFile: PROJECT,
      projectRecord: { whatThisIs: null, coreValue: 'Nothing is lost.' }
    })
    expect(result.objective).toMatchObject({ source: 'project-md', section: 'core-value' })
  })

  it.each([
    ['absent', null, null],
    ['no-goal-section', PROJECT, { whatThisIs: null, coreValue: null }],
    ['unreadable', PROJECT, null]
  ] as const)('falls back to the milestone and says PROJECT.md was %s', (gap, file, record) => {
    expect(brief({ projectFile: file, projectRecord: record }).objective).toEqual({
      kind: 'known',
      source: 'milestone',
      text: MILESTONE,
      partial: false,
      projectGap: gap
    })
  })

  it('keeps the PROJECT.md gap when there is no milestone either', () => {
    const inspect = { ...ubInspect, milestone: null }
    const result = brief({ inspect, projectFile: PROJECT, projectRecord: null })
    expect(result.objective).toEqual({ kind: 'unknown', projectGap: 'unreadable' })
  })
})

describe('records — every planning file, with what Orca reads', () => {
  it('derives a role per file and marks only the files Orca parses', () => {
    const result = brief({
      projectFile: PROJECT,
      recordFiles: {
        kind: 'listed',
        files: [
          '.planning/config.json',
          '.planning/research/SUMMARY.md',
          '.planning/workstreams/ub/PROJECT.md',
          '.planning/workstreams/ub/REQUIREMENTS.md',
          '.planning/workstreams/ub/ROADMAP.md',
          '.planning/workstreams/ub/STATE.md',
          '.planning/workstreams/ub/phases/01/01-VERIFICATION.md',
          '.planning/notes.txt'
        ],
        truncated: true
      }
    })
    expect(result.records).toEqual({
      kind: 'listed',
      truncated: true,
      files: [
        { path: '.planning/config.json', role: 'config', readByOrca: false },
        { path: '.planning/research/SUMMARY.md', role: 'research', readByOrca: false },
        { path: PROJECT, role: 'project', readByOrca: true },
        {
          path: '.planning/workstreams/ub/REQUIREMENTS.md',
          role: 'requirements',
          readByOrca: false
        },
        { path: '.planning/workstreams/ub/ROADMAP.md', role: 'roadmap', readByOrca: false },
        { path: STATE, role: 'state', readByOrca: true },
        {
          path: '.planning/workstreams/ub/phases/01/01-VERIFICATION.md',
          role: 'phase',
          readByOrca: false
        },
        { path: '.planning/notes.txt', role: 'other', readByOrca: false }
      ]
    })
  })

  it('reports an unreadable listing rather than an empty one', () => {
    expect(brief({ recordFiles: { kind: 'unreadable' } }).records).toEqual({ kind: 'unreadable' })
  })
})
