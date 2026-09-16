import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from './agent-hibernation-planner'
import {
  resetAgentHibernationCoordinatorForTests,
  sleepAuthorizedAgentPanes,
  type AgentSleepAuthorization
} from './agent-hibernation-coordinator'
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
