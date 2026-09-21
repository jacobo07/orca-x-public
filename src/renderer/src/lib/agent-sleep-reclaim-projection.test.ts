import { describe, expect, it } from 'vitest'
import type {
  MemorySnapshot,
  ProcessPresenceProbe,
  SessionMemory
} from '../../../shared/process-stats-types'
import {
  isSnapshotUsable,
  listBaselinePids,
  measureObservedReclaim,
  projectCandidateFootprint,
  summarizeReclaimEstimate,
  type SleepReclaimFootprint
} from './agent-sleep-reclaim-projection'

const MB = 1024 * 1024

function makeSnapshot(
  sessions: SessionMemory[],
  overrides?: Partial<MemorySnapshot>
): MemorySnapshot {
  const worktreeMemory = sessions.reduce((sum, session) => sum + session.memory, 0)
  return {
    app: {
      cpu: 1,
      memory: 300 * MB,
      main: { cpu: 1, memory: 100 * MB },
      renderer: { cpu: 0, memory: 200 * MB },
      other: { cpu: 0, memory: 0 },
      history: []
    },
    worktrees: [
      {
        worktreeId: 'repo::/w',
        worktreeName: 'w',
        repoId: 'repo',
        repoName: 'Repo',
        cpu: 0,
        memory: worktreeMemory,
        sessions,
        history: []
      }
    ],
    host: {
      totalMemory: 32000 * MB,
      freeMemory: 2000 * MB,
      availableMemory: 3000 * MB,
      availableMemorySource: 'free-memory',
      usedMemory: 29000 * MB,
      memoryUsagePercent: 90,
      cpuCoreCount: 8,
      loadAverage1m: 0
    },
    processMemoryMetric: 'working-set',
    totalCpu: 1,
    totalMemory: 300 * MB + worktreeMemory,
    collectedAt: 1,
    ...overrides
  }
}

const measured: SessionMemory = {
  sessionId: 's1',
  paneKey: 'tab:leaf',
  pid: 4242,
  cpu: 0,
  memory: 500 * MB
}

describe('sleep reclaim projection', () => {
  it('reports a measured candidate with the collector metric', () => {
    expect(projectCandidateFootprint('tab:leaf', makeSnapshot([measured]))).toEqual({
      known: true,
      bytes: 500 * MB,
      metric: 'working-set'
    })
  })

  it('calls a pid-less row unknown rather than free', () => {
    const noPid: SessionMemory = { ...measured, pid: 0, memory: 0 }
    expect(projectCandidateFootprint('tab:leaf', makeSnapshot([noPid]))).toEqual({
      known: false,
      reason: 'no-pid'
    })
  })

  it('calls a swept-but-missing process unknown rather than free', () => {
    const missing: SessionMemory = { ...measured, memory: 0 }
    expect(projectCandidateFootprint('tab:leaf', makeSnapshot([missing]))).toEqual({
      known: false,
      reason: 'process-not-found'
    })
  })

  // Why: the pty registry is local-only by design, so an SSH-backed pane has no row at all.
  it('calls a pane with no local row not-locally-measured', () => {
    expect(projectCandidateFootprint('other:leaf', makeSnapshot([measured]))).toEqual({
      known: false,
      reason: 'not-locally-measured'
    })
  })

  // Why: a failed host sweep returns the empty snapshot; it must not read as "nothing is resident".
  it('treats a collapsed snapshot as unusable, not as zero', () => {
    const collapsed = makeSnapshot([], {
      app: {
        cpu: 0,
        memory: 0,
        main: { cpu: 0, memory: 0 },
        renderer: { cpu: 0, memory: 0 },
        other: { cpu: 0, memory: 0 },
        history: []
      }
    })
    expect(isSnapshotUsable(collapsed)).toBe(false)
    expect(projectCandidateFootprint('tab:leaf', collapsed)).toEqual({
      known: false,
      reason: 'snapshot-unusable'
    })
  })

  // Why: app memory comes from Electron's own metrics, so a failed host sweep
  // still reports it; only the collector's sweep outcome says the panes went unmeasured.
  it('treats a failed sweep as unusable even while app memory is reported', () => {
    const failed = makeSnapshot([{ ...measured, memory: 0 }], { processSweep: 'failed' })
    expect(isSnapshotUsable(failed)).toBe(false)
    expect(projectCandidateFootprint('tab:leaf', failed)).toEqual({
      known: false,
      reason: 'snapshot-unusable'
    })
  })

  it('keeps a measured sweep and an older snapshot without the outcome usable', () => {
    expect(isSnapshotUsable(makeSnapshot([measured], { processSweep: 'measured' }))).toBe(true)
    expect(isSnapshotUsable(makeSnapshot([measured]))).toBe(true)
  })

  it('treats an absent snapshot as unusable', () => {
    expect(isSnapshotUsable(null)).toBe(false)
    expect(projectCandidateFootprint('tab:leaf', null)).toEqual({
      known: false,
      reason: 'snapshot-unusable'
    })
  })

  it('accepts a live snapshot as usable', () => {
    expect(isSnapshotUsable(makeSnapshot([measured]))).toBe(true)
  })
})

describe('reclaim estimate', () => {
  // The load-bearing law: an unmeasured candidate is never summed as zero.
  it('keeps unknowns out of the byte total and visible in the count', () => {
    const estimate = summarizeReclaimEstimate(
      [
        { known: true, bytes: 500 * MB, metric: 'working-set' },
        { known: false, reason: 'no-pid' },
        { known: false, reason: 'not-locally-measured' },
        { known: false, reason: 'no-pid' }
      ],
      'working-set'
    )
    expect(estimate.knownBytes).toBe(500 * MB)
    expect(estimate.knownCount).toBe(1)
    expect(estimate.unknownCount).toBe(3)
    expect(estimate.unknownReasons).toEqual(['no-pid', 'not-locally-measured'])
  })

  it('reports an all-unknown set as zero known and nothing claimed', () => {
    const estimate = summarizeReclaimEstimate(
      [{ known: false, reason: 'snapshot-unusable' }],
      'rss'
    )
    expect(estimate.knownBytes).toBe(0)
    expect(estimate.knownCount).toBe(0)
    expect(estimate.unknownCount).toBe(1)
    expect(estimate.metric).toBe('rss')
  })
})

describe('observed reclaim', () => {
  const REQUESTED_AT = 10_000
  const shell = { pid: 4242, memory: 300 * MB }
  const agent = { pid: 4243, memory: 200 * MB }
  const sleptPane: SleepReclaimFootprint = {
    known: true,
    bytes: 500 * MB,
    metric: 'working-set',
    processes: [shell, agent]
  }
  const probe = (presentPids: number[], overrides?: object): ProcessPresenceProbe => ({
    sweep: 'measured',
    requestedAt: REQUESTED_AT,
    sweepStartedAt: REQUESTED_AT,
    metric: 'working-set',
    presentPids,
    ...overrides
  })

  it('counts the pre-effect bytes of processes a later usable sweep no longer lists', () => {
    expect(
      measureObservedReclaim({
        slept: [sleptPane],
        probe: probe([])
      })
    ).toEqual({
      status: 'measured',
      metric: 'working-set',
      bytes: 500 * MB,
      measuredPaneCount: 1,
      unmeasuredPaneCount: 0,
      stillRunningProcessCount: 0
    })
  })

  it('does not count a process the sweep still lists, lingering or reused', () => {
    const observed = measureObservedReclaim({
      slept: [sleptPane],
      probe: probe([agent.pid])
    })
    expect(observed).toMatchObject({
      status: 'measured',
      bytes: 300 * MB,
      stillRunningProcessCount: 1
    })
  })

  it('reports a measured zero when every baseline process is still listed', () => {
    const observed = measureObservedReclaim({
      slept: [sleptPane],
      probe: probe([shell.pid, agent.pid])
    })
    expect(observed).toMatchObject({ status: 'measured', bytes: 0, stillRunningProcessCount: 2 })
  })

  // Was the defect: an empty failed sweep read as every process gone.
  it('refuses a failed follow-up sweep instead of reading it as everything gone', () => {
    expect(
      measureObservedReclaim({
        slept: [sleptPane],
        probe: { sweep: 'failed', requestedAt: REQUESTED_AT, sweepStartedAt: REQUESTED_AT }
      })
    ).toEqual({ status: 'unmeasured', reason: 'sweep-failed', sleptPaneCount: 1 })
  })

  it('refuses when the follow-up sweep could not be asked for', () => {
    expect(measureObservedReclaim({ slept: [sleptPane], probe: null })).toEqual({
      status: 'unmeasured',
      reason: 'sweep-unavailable',
      sleptPaneCount: 1
    })
  })

  it('refuses a sweep that began before it was requested, as a reused one would', () => {
    expect(
      measureObservedReclaim({
        slept: [sleptPane],
        probe: probe([], { sweepStartedAt: REQUESTED_AT - 1 })
      })
    ).toMatchObject({ status: 'unmeasured', reason: 'sweep-predates-request' })
  })

  it('refuses to compare across per-process metrics', () => {
    expect(
      measureObservedReclaim({
        slept: [sleptPane],
        probe: probe([], { metric: 'rss' })
      })
    ).toMatchObject({ status: 'unmeasured', reason: 'metric-changed' })
  })

  it('has no baseline when no slept pane was measured before', () => {
    expect(
      measureObservedReclaim({
        slept: [
          { known: false, reason: 'snapshot-unusable' },
          { known: true, bytes: 1 * MB, metric: 'working-set' }
        ],
        probe: probe([])
      })
    ).toEqual({ status: 'unmeasured', reason: 'no-baseline', sleptPaneCount: 2 })
  })

  it('says nothing, and needs no sweep, when nothing slept', () => {
    expect(measureObservedReclaim({ slept: [], probe: null })).toEqual({
      status: 'unmeasured',
      reason: 'nothing-slept',
      sleptPaneCount: 0
    })
  })

  it('counts unmeasured slept panes separately and adds no bytes for them', () => {
    const observed = measureObservedReclaim({
      slept: [sleptPane, { known: false, reason: 'no-pid' }],
      probe: probe([])
    })
    expect(observed).toMatchObject({
      status: 'measured',
      bytes: 500 * MB,
      measuredPaneCount: 1,
      unmeasuredPaneCount: 1
    })
  })

  // Only the slept cohort is passed in; anything else leaving the host is not ours.
  it('ignores processes outside the slept cohort, whatever they do', () => {
    const observed = measureObservedReclaim({
      slept: [sleptPane],
      probe: probe([shell.pid, agent.pid])
    })
    expect(observed).toMatchObject({ bytes: 0 })
  })

  it('asks the sweep about each baseline pid once', () => {
    expect(listBaselinePids([sleptPane, sleptPane, { known: false, reason: 'no-pid' }])).toEqual([
      shell.pid,
      agent.pid
    ])
  })

  it('carries the collector process list onto the footprint', () => {
    const withProcesses: SessionMemory = { ...measured, processes: [shell, agent] }
    expect(projectCandidateFootprint('tab:leaf', makeSnapshot([withProcesses]))).toEqual(sleptPane)
  })
})
