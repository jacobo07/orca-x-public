import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { MemorySnapshot, SessionMemory } from '../../../shared/process-stats-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { getResourceMemoryMetricCopy } from '../components/status-bar/resource-memory-metric-copy'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'
import { buildSleepAuthorizationPlan } from './agent-sleep-authorization-plan'

const MB = 1024 * 1024
const NOW = 2_000_000
const OLD = NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
const LEAVES = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
]

const paneKeyOf = (index: number): string => `tab-${index + 1}:${LEAVES[index]}`

function tab(index: number): TerminalTab {
  return {
    id: `tab-${index + 1}`,
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 1
  }
}

function layout(index: number): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAVES[index] },
    activeLeafId: LEAVES[index],
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAVES[index]]: `pty-${index + 1}` }
  }
}

function entry(index: number): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'make it so',
    updatedAt: OLD,
    stateStartedAt: OLD,
    paneKey: paneKeyOf(index),
    tabId: `tab-${index + 1}`,
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: `session-${index + 1}` },
    stateHistory: []
  }
}

function plannerSnapshot(
  overrides: Partial<AgentHibernationPlannerSnapshot> = {}
): AgentHibernationPlannerSnapshot {
  const indexes = [0, 1, 2]
  return {
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    },
    activeWorktreeId: 'wt-active',
    foregroundTerminalTabIds: [],
    tabsByWorktree: { 'wt-bg': indexes.map(tab) },
    terminalLayoutsByTabId: Object.fromEntries(indexes.map((i) => [`tab-${i + 1}`, layout(i)])),
    ptyIdsByTabId: Object.fromEntries(indexes.map((i) => [`tab-${i + 1}`, [`pty-${i + 1}`]])),
    mobileLockedPtyIds: [],
    agentStatusByPaneKey: Object.fromEntries(indexes.map((i) => [paneKeyOf(i), entry(i)])),
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    now: NOW,
    ...overrides
  }
}

function session(paneKey: string, pid: number, memory: number): SessionMemory {
  return { sessionId: `s-${paneKey}`, paneKey, pid, cpu: 0, memory }
}

function memorySnapshot(sessions: SessionMemory[]): MemorySnapshot {
  return {
    app: {
      cpu: 1,
      memory: 300 * MB,
      main: { cpu: 1, memory: 300 * MB },
      renderer: { cpu: 0, memory: 0 },
      other: { cpu: 0, memory: 0 },
      history: []
    },
    worktrees: [
      {
        worktreeId: 'wt-bg',
        worktreeName: 'bg',
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
    totalMemory: 300 * MB,
    collectedAt: 1
  }
}

/** Pane 0 measured, pane 1 unmeasured (no pid), pane 2 measured but Mobile-locked. */
const MIXED_MEMORY = memorySnapshot([
  session(paneKeyOf(0), 11, 400 * MB),
  session(paneKeyOf(1), 0, 0),
  session(paneKeyOf(2), 13, 900 * MB)
])

describe('sleep authorization plan', () => {
  // The sharpest law: an excluded subject is not reclaimable, however large it measures.
  it('never counts an excluded subject toward the estimate', () => {
    const plan = buildSleepAuthorizationPlan(
      plannerSnapshot({ mobileLockedPtyIds: ['pty-3'] }),
      MIXED_MEMORY
    )

    expect(plan.reclaimable.map((s) => s.paneKey).sort()).toEqual([paneKeyOf(0), paneKeyOf(1)])
    expect(plan.excluded.map((s) => s.paneKey)).toEqual([paneKeyOf(2)])
    expect(plan.excluded[0].exclusionReason).toBe('mobile-locked')
    // 900MB is real and measured, and it is not ours to reclaim.
    expect(plan.estimate.knownBytes).toBe(400 * MB)
  })

  it('keeps an unmeasured reclaimable subject counted but unsummed', () => {
    const plan = buildSleepAuthorizationPlan(
      plannerSnapshot({ mobileLockedPtyIds: ['pty-3'] }),
      MIXED_MEMORY
    )

    expect(plan.estimate.knownCount).toBe(1)
    expect(plan.estimate.unknownCount).toBe(1)
    expect(plan.estimate.unknownReasons).toEqual(['no-pid'])
    const unknown = plan.reclaimable.find((s) => s.paneKey === paneKeyOf(1))
    expect(unknown?.footprint).toEqual({ known: false, reason: 'no-pid' })
  })

  // Why: the surface must not mint memory words; the status bar already owns them.
  it('reuses the canonical metric copy verbatim', () => {
    const plan = buildSleepAuthorizationPlan(plannerSnapshot(), MIXED_MEMORY)
    expect(plan.metric).toBe('working-set')
    expect(plan.metricCopy).toEqual(getResourceMemoryMetricCopy('working-set'))
  })

  // Why: with no snapshot the unit is unknowable, and the copy owner cannot say that.
  it('offers no metric copy when the unit is unknowable', () => {
    const plan = buildSleepAuthorizationPlan(plannerSnapshot(), null)
    expect(plan.metric).toBeNull()
    expect(plan.metricCopy).toBeNull()
    expect(plan.snapshotUsable).toBe(false)
    expect(plan.estimate.knownBytes).toBe(0)
    expect(plan.estimate.unknownCount).toBe(3)
  })

  // Negative control: when everything is measured the plan carries no unknown noise.
  it('produces a clean plan with no unknowns when everything is measured', () => {
    const allMeasured = memorySnapshot([
      session(paneKeyOf(0), 11, 400 * MB),
      session(paneKeyOf(1), 12, 100 * MB),
      session(paneKeyOf(2), 13, 250 * MB)
    ])
    const plan = buildSleepAuthorizationPlan(plannerSnapshot(), allMeasured)

    expect(plan.excluded).toEqual([])
    expect(plan.estimate.unknownCount).toBe(0)
    expect(plan.estimate.unknownReasons).toEqual([])
    expect(plan.estimate.knownCount).toBe(3)
    expect(plan.estimate.knownBytes).toBe(750 * MB)
  })

  it('reports an already-sleeping subject as excluded, not as reclaimable', () => {
    const snapshot = plannerSnapshot({
      sleepingAgentSessionsByPaneKey: {
        [paneKeyOf(1)]: {
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'session-2' },
          worktreeId: 'wt-bg',
          sleptAt: OLD
        } as never
      }
    })
    const plan = buildSleepAuthorizationPlan(snapshot, MIXED_MEMORY)

    expect(plan.reclaimable.map((s) => s.paneKey)).not.toContain(paneKeyOf(1))
    const sleeping = plan.excluded.find((s) => s.paneKey === paneKeyOf(1))
    expect(sleeping?.exclusionReason).toBe('already-sleeping')
  })

  // Why: §16 - dedup must stay load-bearing downstream, not only inside the helper.
  it('counts a pane once even though it is measured once per view', () => {
    const plan = buildSleepAuthorizationPlan(plannerSnapshot(), MIXED_MEMORY)
    const paneKeys = plan.reclaimable.map((s) => s.paneKey)
    expect(new Set(paneKeys).size).toBe(paneKeys.length)
    expect(plan.estimate.knownBytes).toBe(400 * MB + 900 * MB)
  })

  it('is observational: repeated calls agree and nothing is mutated', () => {
    const snapshot = plannerSnapshot({ mobileLockedPtyIds: ['pty-3'] })
    const frozen = JSON.stringify(snapshot)
    const first = buildSleepAuthorizationPlan(snapshot, MIXED_MEMORY)
    const second = buildSleepAuthorizationPlan(snapshot, MIXED_MEMORY)

    expect(second).toEqual(first)
    expect(JSON.stringify(snapshot)).toBe(frozen)
  })

  it('reports every pane when the feature is disabled, none reclaimable', () => {
    const off = plannerSnapshot({
      settings: {
        experimentalAgentHibernation: false,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
      }
    })
    const plan = buildSleepAuthorizationPlan(off, MIXED_MEMORY)

    expect(plan.reclaimable).toEqual([])
    expect(plan.excluded).toHaveLength(3)
    expect(plan.excluded.every((s) => s.exclusionReason === 'feature-disabled')).toBe(true)
    expect(plan.estimate.knownBytes).toBe(0)
  })
})
