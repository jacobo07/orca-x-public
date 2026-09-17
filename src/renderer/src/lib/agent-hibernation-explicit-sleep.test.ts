import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from './agent-hibernation-planner'
import type { MemorySnapshot } from '../../../shared/process-stats-types'
import {
  resetAgentHibernationCoordinatorForTests,
  runAgentHibernationTick,
  sleepAuthorizedAgentPanes,
  type AgentSleepAuthorization
} from './agent-hibernation-coordinator'
import { createReclaimObserver } from './agent-sleep-observed-reclaim'
import { observeSleepAuthorizationPlan } from './observe-sleep-authorization-plan'
import { buildSleepAuthorizationPlan } from './agent-sleep-authorization-plan'
import {
  buildAgentHibernationPlannerSnapshot,
  unsampledRuntimePtyLiveness
} from './agent-hibernation-planner-snapshot'
import { hydrateDrivers, setDriverForPty } from './pane-manager/mobile-driver-state'
import { resetForegroundTerminalTabIdsForTests } from './foreground-terminal-tabs'
import {
  recordAgentHibernationPaneOutput,
  resetAgentHibernationOutputActivityForTests
} from './agent-hibernation-output-activity'

vi.stubGlobal('window', { api: { runtimeEnvironments: { call: vi.fn() } } })

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const PANE_A = `tab-a:${LEAF_A}`
const PANE_B = `tab-b:${LEAF_B}`

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function entry(paneKey: string, tabId: string, sessionId: string): AgentStatusEntry {
  const doneAt = Date.now() - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 60_000
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: doneAt,
    stateStartedAt: doneAt,
    paneKey,
    tabId,
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: sessionId },
    stateHistory: []
  }
}

/** Two completed agents, each alone in a tab of a background worktree. */
function installTwoEligiblePanes(shutdown = vi.fn().mockResolvedValue(undefined)) {
  useAppStore.setState({
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    } as never,
    activeWorktreeId: 'wt-active',
    repos: [],
    worktreesByRepo: {
      'fixture-repo': [{ id: 'wt-bg', repoId: 'fixture-repo', hostId: 'local' }]
    } as never,
    detectedWorktreesByRepo: {},
    tabsByWorktree: { 'wt-bg': [tab('tab-a'), tab('tab-b')] },
    terminalLayoutsByTabId: {
      'tab-a': {
        root: { type: 'leaf', leafId: LEAF_A },
        activeLeafId: LEAF_A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_A]: 'pty-a' }
      },
      'tab-b': {
        root: { type: 'leaf', leafId: LEAF_B },
        activeLeafId: LEAF_B,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_B]: 'pty-b' }
      }
    },
    ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] },
    agentStatusByPaneKey: {
      [PANE_A]: entry(PANE_A, 'tab-a', 'session-a'),
      [PANE_B]: entry(PANE_B, 'tab-b', 'session-b')
    },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    shutdownCompletedAgentPaneForHibernation: shutdown as never,
    shutdownWorktreeTerminals: vi.fn() as never
  })
  return shutdown
}

/** What the popover section holds when the user clicks: the displayed plan's authorizations. */
function authorizationsOnScreen(): AgentSleepAuthorization[] {
  const state = useAppStore.getState()
  const plan = buildSleepAuthorizationPlan(
    buildAgentHibernationPlannerSnapshot(state, Date.now(), unsampledRuntimePtyLiveness(state)),
    null
  )
  return plan.reclaimable.map((subject) => {
    if (!subject.authorization) {
      throw new Error(`reclaimable subject ${subject.paneKey} carries no authorization`)
    }
    return subject.authorization
  })
}

function sleptPaneKeys(shutdown: ReturnType<typeof vi.fn>): string[] {
  return shutdown.mock.calls.map(([, opts]) => (opts as { paneKey: string }).paneKey)
}

beforeEach(() => {
  resetAgentHibernationCoordinatorForTests()
})

afterEach(() => {
  resetAgentHibernationCoordinatorForTests()
  resetForegroundTerminalTabIdsForTests()
  resetAgentHibernationOutputActivityForTests()
  hydrateDrivers([])
})

describe('explicit agent sleep', () => {
  it('sleeps each pane the user saw at once, without waiting for confirmation ticks', async () => {
    const shutdown = installTwoEligiblePanes()
    const shown = authorizationsOnScreen()
    expect(shown).toHaveLength(2)

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['slept', 'slept'])
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: PANE_A,
      tabId: 'tab-a',
      leafId: LEAF_A,
      ptyId: 'pty-a'
    })
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_A, PANE_B])
  })

  it('keeps a pane Mobile took after it was shown', async () => {
    const shutdown = installTwoEligiblePanes()
    const shown = authorizationsOnScreen()
    setDriverForPty('pty-a', { kind: 'mobile', clientId: 'phone-1' })

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['not-eligible', 'slept'])
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_B])
  })

  it('keeps a pane typed into after it was shown', async () => {
    const shutdown = installTwoEligiblePanes()
    const shown = authorizationsOnScreen()
    useAppStore.setState({ lastTerminalInputAtByPaneKey: { [PANE_A]: Date.now() } })

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results[0]?.outcome).not.toBe('slept')
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_B])
  })

  it('keeps a pane whose terminal was replaced after it was shown', async () => {
    const shutdown = installTwoEligiblePanes()
    const shown = authorizationsOnScreen()
    const state = useAppStore.getState()
    useAppStore.setState({
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        'tab-a': {
          ...state.terminalLayoutsByTabId['tab-a']!,
          ptyIdsByLeafId: { [LEAF_A]: 'pty-a-replacement' }
        }
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, 'tab-a': ['pty-a-replacement'] }
    })

    const results = await sleepAuthorizedAgentPanes(shown)

    // Still eligible as a pane, but not the incarnation the user saw.
    expect(results.map((r) => r.outcome)).toEqual(['changed', 'slept'])
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_B])
  })

  it('keeps a pane that printed output after it was shown', async () => {
    const shutdown = installTwoEligiblePanes()
    const shown = authorizationsOnScreen()
    recordAgentHibernationPaneOutput(PANE_A)

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['changed', 'slept'])
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_B])
  })

  it('still requires agent sleep to be on at the moment of the effect', async () => {
    const shutdown = installTwoEligiblePanes()
    const shown = authorizationsOnScreen()
    useAppStore.setState({
      settings: { experimentalAgentHibernation: false } as never
    })

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['not-eligible', 'not-eligible'])
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('re-plans immediately before each pane, not once for the batch', async () => {
    const shutdown = installTwoEligiblePanes(
      vi.fn().mockImplementation(async (_worktreeId: string, opts: { paneKey: string }) => {
        if (opts.paneKey === PANE_A) {
          // Mobile takes the second pane while the first is being put to sleep.
          setDriverForPty('pty-b', { kind: 'mobile', clientId: 'phone-1' })
        }
      })
    )
    const shown = authorizationsOnScreen()

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['slept', 'not-eligible'])
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_A])
  })

  it('reports a failed shutdown as failed, and still attempts the rest', async () => {
    const shutdown = installTwoEligiblePanes(
      vi.fn().mockImplementation(async (_worktreeId: string, opts: { paneKey: string }) => {
        if (opts.paneKey === PANE_A) {
          throw new Error('agent_hibernation_pane_binding_mismatch')
        }
      })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shown = authorizationsOnScreen()

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['failed', 'slept'])
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_A, PANE_B])
    warn.mockRestore()
  })

  it('names each result by the pane the user authorized', async () => {
    installTwoEligiblePanes()
    const shown = authorizationsOnScreen()

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.candidateId)).toEqual(shown.map((a) => a.candidateId))
  })
})

/** The tab strip's unified tabs, so the real pin actions have something to pin. */
function withUnifiedTerminalTabs(): void {
  const unified = (id: string) => ({
    id,
    entityId: id,
    groupId: 'group-bg',
    worktreeId: 'wt-bg',
    contentType: 'terminal',
    label: 'Agent',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  useAppStore.setState({
    unifiedTabsByWorktree: { 'wt-bg': [unified('tab-a'), unified('tab-b')] } as never,
    groupsByWorktree: {}
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('a pinned tab keeps its agent awake', () => {
  it('keeps a pane pinned after it was shown, and sleeps the rest', async () => {
    const shutdown = installTwoEligiblePanes()
    withUnifiedTerminalTabs()
    const shown = authorizationsOnScreen()
    expect(shown).toHaveLength(2)
    useAppStore.getState().pinTab('tab-a')

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['not-eligible', 'slept'])
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_B])
  })

  it('keeps a later pane pinned while an earlier one is being put to sleep', async () => {
    const shutdown = installTwoEligiblePanes(
      vi.fn().mockImplementation(async (_worktreeId: string, opts: { paneKey: string }) => {
        if (opts.paneKey === PANE_A) {
          useAppStore.getState().pinTab('tab-b')
        }
      })
    )
    withUnifiedTerminalTabs()
    const shown = authorizationsOnScreen()

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['slept', 'not-eligible'])
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_A])
  })

  // Why: re-planning may narrow what the user approved, never widen it.
  it('does not add a pane unpinned during the batch the user approved without it', async () => {
    const shutdown = installTwoEligiblePanes(
      vi.fn().mockImplementation(async (_worktreeId: string, opts: { paneKey: string }) => {
        if (opts.paneKey === PANE_A) {
          useAppStore.getState().unpinTab('tab-b')
        }
      })
    )
    withUnifiedTerminalTabs()
    useAppStore.getState().pinTab('tab-b')
    const shown = authorizationsOnScreen()
    expect(shown.map((a) => a.candidateId)).toEqual([`wt-bg|${PANE_A}`])

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['slept'])
    expect(sleptPaneKeys(shutdown)).toEqual([PANE_A])
    // Control: the unpin really made it eligible, so only the approved set kept it out.
    expect(authorizationsOnScreen().map((a) => a.candidateId)).toContain(`wt-bg|${PANE_B}`)
  })

  it('does not wake or disturb a slept pane when its tab is pinned', async () => {
    installTwoEligiblePanes()
    withUnifiedTerminalTabs()
    const record = { agentType: 'claude', worktreeId: 'wt-bg', sleptAt: 1 } as never
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [PANE_A]: record },
      ptyIdsByTabId: { 'tab-a': [], 'tab-b': ['pty-b'] }
    })
    const before = useAppStore.getState()

    useAppStore.getState().pinTab('tab-a')

    const after = useAppStore.getState()
    expect(after.sleepingAgentSessionsByPaneKey).toBe(before.sleepingAgentSessionsByPaneKey)
    expect(after.ptyIdsByTabId).toBe(before.ptyIdsByTabId)
    expect(after.terminalLayoutsByTabId).toBe(before.terminalLayoutsByTabId)
  })

  it('measures after the effect only the processes of the pane that actually slept', async () => {
    installTwoEligiblePanes()
    withUnifiedTerminalTabs()
    useAppStore.getState().pinTab('tab-a')
    const state = useAppStore.getState()
    const plan = buildSleepAuthorizationPlan(
      buildAgentHibernationPlannerSnapshot(state, Date.now(), unsampledRuntimePtyLiveness(state)),
      measuredSnapshot()
    )
    expect(plan.reclaimable.map((s) => s.paneKey)).toEqual([PANE_B])
    // The pinned pane's pid is still running; it must not read as a slept pane lingering.
    const probe = vi.fn().mockResolvedValue({
      sweep: 'measured',
      requestedAt: 10,
      sweepStartedAt: 11,
      metric: 'working-set',
      presentPids: [101]
    })

    const results = await sleepAuthorizedAgentPanes(
      plan.reclaimable.map((subject) => subject.authorization!)
    )
    const observed = await createReclaimObserver(probe)({ subjects: plan.reclaimable, results })

    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith([202])
    expect(observed).toMatchObject({ status: 'measured', bytes: 700, stillRunningProcessCount: 0 })
  })

  it('keeps a pane pinned after display out of the post-effect measurement', async () => {
    installTwoEligiblePanes()
    withUnifiedTerminalTabs()
    useAppStore.setState({ memorySnapshot: measuredSnapshot() })
    const plan = observeSleepAuthorizationPlan()
    expect(plan.reclaimable.map((s) => s.paneKey)).toEqual([PANE_A, PANE_B])
    useAppStore.getState().pinTab('tab-a')
    const probe = vi.fn().mockResolvedValue({
      sweep: 'measured',
      requestedAt: 10,
      sweepStartedAt: 11,
      metric: 'working-set',
      presentPids: []
    })

    const results = await sleepAuthorizedAgentPanes(
      plan.reclaimable.map((subject) => subject.authorization!)
    )
    const observed = await createReclaimObserver(probe)({ subjects: plan.reclaimable, results })

    expect(results.map((r) => r.outcome)).toEqual(['not-eligible', 'slept'])
    expect(probe).toHaveBeenCalledWith([202])
    expect(observed).toMatchObject({ status: 'measured', bytes: 700, measuredPaneCount: 1 })
  })

  it('shows the pinned pane as kept awake in the displayed plan', () => {
    installTwoEligiblePanes()
    withUnifiedTerminalTabs()
    useAppStore.setState({ memorySnapshot: measuredSnapshot() })
    useAppStore.getState().pinTab('tab-a')

    const plan = observeSleepAuthorizationPlan()

    expect(plan.reclaimable.map((s) => s.paneKey)).toEqual([PANE_B])
    expect(plan.excluded.map((s) => [s.paneKey, s.exclusionReason])).toEqual([
      [PANE_A, 'tab-pinned']
    ])
    expect(plan.estimate.knownBytes).toBe(700)
  })
})

/** Pane A (pinned in the test) owns pid 101, pane B owns pid 202. */
function measuredSnapshot(): MemorySnapshot {
  const sessionFor = (paneKey: string, pid: number, memory: number) => ({
    sessionId: `s-${paneKey}`,
    paneKey,
    pid,
    cpu: 0,
    memory,
    processes: [{ pid, memory }]
  })
  return {
    app: {
      cpu: 0,
      memory: 1,
      main: { cpu: 0, memory: 1 },
      renderer: { cpu: 0, memory: 0 },
      other: { cpu: 0, memory: 0 },
      history: []
    },
    worktrees: [
      {
        worktreeId: 'wt-bg',
        worktreeName: 'bg',
        repoId: 'fixture-repo',
        repoName: 'Repo',
        cpu: 0,
        memory: 1600,
        sessions: [sessionFor(PANE_A, 101, 900), sessionFor(PANE_B, 202, 700)],
        history: []
      }
    ],
    host: {
      totalMemory: 1,
      freeMemory: 1,
      availableMemory: 1,
      availableMemorySource: 'free-memory',
      usedMemory: 0,
      memoryUsagePercent: 0,
      cpuCoreCount: 1,
      loadAverage1m: 0
    },
    processMemoryMetric: 'working-set',
    totalCpu: 0,
    totalMemory: 1,
    collectedAt: 1,
    sweepStartedAt: 1
  } as MemorySnapshot
}

describe('automatic sleep leaves a pinned tab awake', () => {
  it('control: two ticks sleep both unpinned panes', async () => {
    const shutdown = installTwoEligiblePanes()
    withUnifiedTerminalTabs()

    await runAgentHibernationTick()
    await runAgentHibernationTick()
    await settle()

    expect(sleptPaneKeys(shutdown).sort()).toEqual([PANE_A, PANE_B].sort())
  })

  it('never sleeps a pinned pane on the tick path', async () => {
    const shutdown = installTwoEligiblePanes()
    withUnifiedTerminalTabs()
    useAppStore.getState().pinTab('tab-a')

    await runAgentHibernationTick()
    await runAgentHibernationTick()
    await settle()

    expect(sleptPaneKeys(shutdown)).toEqual([PANE_B])
  })

  it('drops a pane pinned between the two confirming ticks', async () => {
    const shutdown = installTwoEligiblePanes()
    withUnifiedTerminalTabs()

    await runAgentHibernationTick()
    useAppStore.getState().pinTab('tab-a')
    await runAgentHibernationTick()
    await settle()

    expect(sleptPaneKeys(shutdown)).toEqual([PANE_B])
  })
})
