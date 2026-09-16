import { describe, expect, it } from 'vitest'
import type { MemorySnapshot, SessionMemory } from '../../../shared/process-stats-types'
import {
  isSnapshotUsable,
  measureObservedReclaim,
  projectCandidateFootprint,
  summarizeReclaimEstimate
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
    const estimate = summarizeReclaimEstimate([{ known: false, reason: 'snapshot-unusable' }], 'rss')
    expect(estimate.knownBytes).toBe(0)
    expect(estimate.knownCount).toBe(0)
    expect(estimate.unknownCount).toBe(1)
    expect(estimate.metric).toBe('rss')
  })
})

describe('observed reclaim', () => {
  it('reports three separate figures and never one merged number', () => {
    const before = makeSnapshot([measured])
    const after = makeSnapshot([], {
      app: {
        cpu: 1,
        memory: 250 * MB,
        main: { cpu: 1, memory: 100 * MB },
        renderer: { cpu: 0, memory: 150 * MB },
        other: { cpu: 0, memory: 0 },
        history: []
      },
      host: { ...before.host, availableMemory: 3400 * MB, availableMemorySource: 'memory-pressure' }
    })

    const observed = measureObservedReclaim(before, after)
    expect(observed.ownedProcessBytes).toBe(500 * MB)
    expect(observed.appProcessBytes).toBe(50 * MB)
    expect(observed.hostAvailableBytes).toBe(400 * MB)
    expect(observed.hostAvailableSource).toBe('memory-pressure')
    expect(observed.metric).toBe('working-set')
  })

  // Why: host availability moves for reasons unrelated to us; it is evidence, not our total.
  it('does not fold host availability into the owned-process figure', () => {
    const before = makeSnapshot([measured])
    const after = makeSnapshot([], {
      host: { ...before.host, availableMemory: 9999 * MB }
    })
    expect(measureObservedReclaim(before, after).ownedProcessBytes).toBe(500 * MB)
  })
})
