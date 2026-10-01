import { describe, expect, it } from 'vitest'
import type { MissionBrief } from '../../../../shared/mission-brief-types'
import type { WorkspaceRowModel } from '../resume-center/resume-center-model'
import { planContinue, planNeedsMe } from './mission-brief-actions'

type Tab = WorkspaceRowModel['tabs'][number]
type Orphan = WorkspaceRowModel['orphanSessions'][number]

function brief(overrides: Partial<MissionBrief> = {}): MissionBrief {
  return {
    workstream: null,
    stateFile: '.planning/STATE.md',
    objective: { kind: 'unknown' },
    stages: [],
    frontier: { kind: 'unknown' },
    lastVerified: { kind: 'none', nearest: null },
    nextAction: { kind: 'unknown' },
    unlocks: [],
    humanAttention: [],
    autonomous: [],
    blockers: { kind: 'not-recorded' },
    haltedRun: null,
    contradictions: [],
    freshness: { kind: 'unknown', reason: 'no-recorded-head' },
    signal: 'unknown',
    readAt: 0,
    ...overrides
  } as MissionBrief
}

function tab(tabId: string, overrides: Partial<Tab> = {}): Tab {
  return {
    tabId,
    title: tabId,
    agent: 'claude',
    residency: 'no-process',
    resume: 'none',
    panes: [],
    ...overrides
  } as Tab
}

function orphan(paneKey: string, resume: Orphan['resume']): Orphan {
  return { paneKey, agent: 'codex', capturedAt: 1, resume }
}

function row(
  tabs: Tab[],
  orphans: Orphan[] = [],
  overrides: Partial<WorkspaceRowModel> = {}
): WorkspaceRowModel {
  return {
    kind: 'projected',
    key: 'worktree:repo-1::/repo',
    hostId: 'local',
    identity: { kind: 'known', name: 'repo', path: '/repo' },
    window: { kind: 'unattributed', reason: 'no-window-binding' },
    lastVisitedAt: null,
    tabs,
    orphanSessions: orphans,
    openFileCount: 0,
    browserTabCount: 0,
    windowOrder: null,
    counts: { tabs: tabs.length, panes: 0, warm: 0, dormant: 0, unknown: 0 },
    ...overrides
  } as WorkspaceRowModel
}

const LIVE_RUN = { missionId: 'm-1', reason: 'running', heartbeatAgeMs: 1000, live: true }

describe('planContinue', () => {
  it('defers to a live autonomous run instead of starting a second agent', () => {
    const plan = planContinue(
      brief({ autonomous: [LIVE_RUN] }),
      row([tab('t1', { residency: 'warm' })])
    )
    expect(plan).toEqual({ kind: 'autonomous' })
  })

  it('ignores an autonomous run that is not live', () => {
    const plan = planContinue(
      brief({ autonomous: [{ ...LIVE_RUN, live: false }] }),
      row([tab('t1', { resume: 'exact' })])
    )
    expect(plan).toEqual({ kind: 'resume-tab', tabId: 't1' })
  })

  it('prefers a running agent tab over an exactly resumable one', () => {
    const plan = planContinue(
      brief(),
      row([tab('exact', { resume: 'exact' }), tab('warm', { residency: 'warm' })])
    )
    expect(plan).toEqual({ kind: 'resume-tab', tabId: 'warm' })
  })

  it('prefers an exact resume over an unconfirmed one', () => {
    const plan = planContinue(
      brief(),
      row([tab('maybe', { resume: 'unconfirmed' }), tab('exact', { resume: 'exact' })])
    )
    expect(plan).toEqual({ kind: 'resume-tab', tabId: 'exact' })
  })

  it('never picks a tab claimed by another window, or a tab with no agent', () => {
    const plan = planContinue(
      brief(),
      row(
        [
          tab('elsewhere', { residency: 'warm', resume: 'claimed-elsewhere' }),
          tab('shell', { agent: null, residency: 'warm' })
        ],
        [orphan('pane-1', 'unconfirmed')]
      )
    )
    expect(plan).toEqual({ kind: 'resume-orphan', paneKey: 'pane-1' })
  })

  it('reports no agent when nothing on the row can be resumed', () => {
    const plan = planContinue(brief(), row([tab('t1')], [orphan('pane-1', 'none')]))
    expect(plan).toEqual({ kind: 'no-agent' })
  })
})

describe('planNeedsMe', () => {
  it('does nothing when no record says a person is needed', () => {
    expect(planNeedsMe(brief(), row([]))).toEqual({ kind: 'nothing-recorded' })
  })

  it('opens the recorded state file in the worktree for a STATE.md decision', () => {
    const plan = planNeedsMe(
      brief({ humanAttention: [{ source: 'state-md', text: 'Choose a provider' }] }),
      row([])
    )
    expect(plan).toMatchObject({
      kind: 'open-state-file',
      worktreeId: 'repo-1::/repo',
      relativePath: '.planning/STATE.md'
    })
    expect(plan.kind === 'open-state-file' && plan.filePath.replace(/\\/g, '/')).toBe(
      '/repo/.planning/STATE.md'
    )
  })

  it('opens the workspace when the need is not a STATE.md decision', () => {
    const plan = planNeedsMe(
      brief({ humanAttention: [{ source: 'ralph-mission', missionId: 'm-1', reason: 'halted' }] }),
      row([])
    )
    expect(plan).toEqual({ kind: 'open-workspace' })
  })

  it('opens a folder workspace rather than a file the editor cannot address', () => {
    const plan = planNeedsMe(
      brief({ humanAttention: [{ source: 'state-md', text: 'Choose a provider' }] }),
      row([], [], { key: 'folder:f-1' })
    )
    expect(plan).toEqual({ kind: 'open-workspace' })
  })

  it('opens the workspace when its path is not known', () => {
    const plan = planNeedsMe(
      brief({ humanAttention: [{ source: 'state-md', text: 'Choose a provider' }] }),
      row([], [], { identity: { kind: 'missing' } as WorkspaceRowModel['identity'] })
    )
    expect(plan).toEqual({ kind: 'open-workspace' })
  })
})
