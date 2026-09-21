import { describe, expect, it } from 'vitest'
import type { MemorySnapshot, SessionMemory } from '../../../shared/process-stats-types'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import { projectSleepReclaimPlan } from './agent-sleep-reclaim-plan'

const MB = 1024 * 1024

function makeSnapshot(sessions: SessionMemory[], appMemory = 300 * MB): MemorySnapshot {
  return {
    app: {
      cpu: 1,
      memory: appMemory,
      main: { cpu: 1, memory: appMemory },
      renderer: { cpu: 0, memory: 0 },
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
        memory: sessions.reduce((sum, s) => sum + s.memory, 0),
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
    totalMemory: appMemory,
    collectedAt: 1
  }
}

function session(paneKey: string, pid: number, memory: number): SessionMemory {
  return { sessionId: `s-${paneKey}`, paneKey, pid, cpu: 0, memory }
}

function makeCandidate(
  id: string,
  paneKeys: string[],
  worktreeId = 'repo::/w'
): AgentHibernationCandidate {
  return {
    id,
    worktreeId,
    paneKey: paneKeys[0],
    tabId: 'tab',
    leafId: 'leaf',
    paneKeys,
    targetPtyIds: [],
    expectedRuntimePtyIds: [],
    signature: id
  }
}

describe('sleep reclaim plan', () => {
  it('sums a group candidate while keeping its unmeasured pane visible', () => {
    const snapshot = makeSnapshot([session('a', 11, 400 * MB), session('b', 0, 0)])
    const plan = projectSleepReclaimPlan([makeCandidate('c1', ['a', 'b'])], snapshot)

    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0].estimate.knownBytes).toBe(400 * MB)
    expect(plan.candidates[0].estimate.knownCount).toBe(1)
    expect(plan.candidates[0].estimate.unknownCount).toBe(1)
    expect(plan.candidates[0].estimate.unknownReasons).toEqual(['no-pid'])
    expect(plan.metric).toBe('working-set')
  })

  // The load-bearing correctness claim: a pane two candidates both claim is not counted twice.
  it('counts a shared pane once in the total', () => {
    const snapshot = makeSnapshot([session('a', 11, 400 * MB), session('b', 12, 100 * MB)])
    const plan = projectSleepReclaimPlan(
      [makeCandidate('c1', ['a', 'b']), makeCandidate('c2', ['b'])],
      snapshot
    )

    expect(plan.candidates[0].estimate.knownBytes).toBe(500 * MB)
    expect(plan.candidates[1].estimate.knownBytes).toBe(100 * MB)
    // Naive summation would report 600MB; the deduped union is 500MB.
    expect(plan.total.knownBytes).toBe(500 * MB)
    expect(plan.total.knownCount).toBe(2)
  })

  it('falls back to the anchor pane when the group list is empty', () => {
    const snapshot = makeSnapshot([session('a', 11, 400 * MB)])
    const candidate = { ...makeCandidate('c1', ['a']), paneKeys: [] as string[] }
    const plan = projectSleepReclaimPlan([candidate], snapshot)

    expect(plan.total.knownBytes).toBe(400 * MB)
  })

  // Why: no snapshot at all means the unit is unknowable; defaulting it would invent one.
  it('reports a null metric when no snapshot exists yet', () => {
    const plan = projectSleepReclaimPlan([makeCandidate('c1', ['a'])], null)

    expect(plan.snapshotUsable).toBe(false)
    expect(plan.metric).toBeNull()
    expect(plan.total.knownBytes).toBe(0)
    expect(plan.total.unknownCount).toBe(1)
    expect(plan.total.unknownReasons).toEqual(['snapshot-unusable'])
  })

  // Why: the collapsed fallback snapshot is unusable but still states its real unit.
  it('separates an unusable snapshot from an unknowable unit', () => {
    const plan = projectSleepReclaimPlan([makeCandidate('c1', ['a'])], makeSnapshot([], 0))

    expect(plan.snapshotUsable).toBe(false)
    expect(plan.metric).toBe('working-set')
    expect(plan.total.unknownReasons).toEqual(['snapshot-unusable'])
  })

  it('returns an empty plan for no candidates', () => {
    const plan = projectSleepReclaimPlan([], makeSnapshot([session('a', 11, 400 * MB)]))

    expect(plan.candidates).toEqual([])
    expect(plan.total.knownBytes).toBe(0)
    expect(plan.total.unknownCount).toBe(0)
    expect(plan.snapshotUsable).toBe(true)
  })
})
