import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { MemorySnapshot } from '../../../shared/process-stats-types'
import { useAppStore } from '@/store'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from './agent-hibernation-planner'
import {
  resetAgentHibernationCoordinatorForTests,
  sleepAuthorizedAgentPanes
} from './agent-hibernation-coordinator'
import { observeSleepAuthorizationPlan } from './observe-sleep-authorization-plan'
import {
  resetRuntimePtyLivenessQueueForTests,
  sampleRuntimePtyLiveness
} from './runtime-pty-liveness-sample'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'

// Display-time runtime liveness only decides what is shown; each sleep re-samples.

const call = vi.fn()
vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'
const PANE_A = `tab-a:${LEAF_A}`
const PANE_B = `tab-b:${LEAF_B}`
const PANE_C = `tab-c:${LEAF_C}`

/**
 * What each host answers per worktree: live PTY ids, or a failure. A `handle>pty`
 * entry is a terminal whose handle differs from its host PTY, as a paired client sees it.
 */
let hosts: Record<string, Record<string, string[] | Error>> = {}

function installHosts(): void {
  call.mockImplementation(
    (args: { selector: string; method: string; params: { worktree: string } }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method !== 'terminal.list') {
        return Promise.resolve({ id: 'x', ok: true, result: {}, _meta: { runtimeId: 'r' } })
      }
      const worktreeId = args.params.worktree.replace(/^id:/, '')
      const answer = hosts[args.selector]?.[worktreeId] ?? new Error('unreachable')
      if (answer instanceof Error) {
        return Promise.reject(answer)
      }
      return Promise.resolve({
        id: 'terminal-list',
        ok: true,
        result: {
          terminals: answer
            .map((listed) => {
              const [handle, ptyId] = listed.includes('>')
                ? listed.split('>')
                : [`h-${listed}`, listed]
              return { handle, ptyId }
            })
            .map(({ handle, ptyId }) => ({
              handle,
              ptyId,
              worktreeId,
              worktreePath: `/tmp/${worktreeId}`,
              branch: 'b',
              tabId: `pty:${ptyId}`,
              leafId: `pty:${ptyId}`,
              title: '',
              connected: true,
              writable: true,
              lastOutputAt: null,
              preview: ''
            })),
          totalCount: answer.length,
          truncated: false
        },
        _meta: { runtimeId: 'r' }
      })
    }
  )
}

function entry(paneKey: string, tabId: string, worktreeId: string): AgentStatusEntry {
  const doneAt = Date.now() - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 60_000
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: doneAt,
    stateStartedAt: doneAt,
    paneKey,
    tabId,
    worktreeId,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: `session-${tabId}` },
    stateHistory: []
  }
}

function tab(id: string, worktreeId: string) {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function leafLayout(leafId: string, ptyId: string) {
  return {
    root: { type: 'leaf' as const, leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function owners(wtBg: string, wtOther: string) {
  return {
    'fixture-repo': [
      { id: 'wt-bg', repoId: 'fixture-repo', hostId: 'local', runtimeOwnerEnvironmentId: wtBg },
      {
        id: 'wt-other',
        repoId: 'fixture-repo',
        hostId: 'local',
        runtimeOwnerEnvironmentId: wtOther
      }
    ]
  } as never
}

/** A and B on runtime-1's wt-bg; C on runtime-2's wt-other. No local memory rows. */
function installRuntimePanes(shutdown = vi.fn().mockResolvedValue(undefined)) {
  const noRows: MemorySnapshot = {
    // A usable sweep (app memory measured) that simply has no row for a runtime pane.
    app: {
      cpu: 0,
      memory: 200,
      main: { cpu: 0, memory: 100 },
      renderer: { cpu: 0, memory: 100 },
      other: { cpu: 0, memory: 0 },
      history: []
    },
    worktrees: [],
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
    processMemoryMetric: 'rss',
    totalCpu: 0,
    totalMemory: 0,
    processSweep: 'measured',
    collectedAt: Date.now()
  }
  useAppStore.setState({
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    } as never,
    activeWorktreeId: 'wt-active',
    repos: [],
    detectedWorktreesByRepo: {},
    worktreesByRepo: owners('runtime-1', 'runtime-2'),
    tabsByWorktree: {
      'wt-bg': [tab('tab-a', 'wt-bg'), tab('tab-b', 'wt-bg')],
      'wt-other': [tab('tab-c', 'wt-other')]
    },
    terminalLayoutsByTabId: {
      'tab-a': leafLayout(LEAF_A, 'pty-a'),
      'tab-b': leafLayout(LEAF_B, 'pty-b'),
      'tab-c': leafLayout(LEAF_C, 'pty-c')
    },
    ptyIdsByTabId: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {
      [PANE_A]: entry(PANE_A, 'tab-a', 'wt-bg'),
      [PANE_B]: entry(PANE_B, 'tab-b', 'wt-bg'),
      [PANE_C]: entry(PANE_C, 'tab-c', 'wt-other')
    },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    memorySnapshot: noRows,
    shutdownCompletedAgentPaneForHibernation: shutdown as never,
    shutdownWorktreeTerminals: vi.fn() as never
  })
  return shutdown
}

/** What the popover shows after its one sample. */
async function display() {
  const sample = await sampleRuntimePtyLiveness(useAppStore.getState())
  return observeSleepAuthorizationPlan(sample)
}

async function authorizationsOnScreen() {
  return (await display()).reclaimable.map((subject) => subject.authorization!)
}

function slept(shutdown: ReturnType<typeof vi.fn>) {
  return shutdown.mock.calls.map(([worktreeId, opts]) => ({
    worktreeId,
    paneKey: (opts as { paneKey: string }).paneKey,
    expectedRuntimePtyId: (opts as { expectedRuntimePtyId?: string }).expectedRuntimePtyId
  }))
}

beforeEach(() => {
  resetAgentHibernationCoordinatorForTests()
  hosts = {
    'runtime-1': { 'wt-bg': ['pty-a', 'pty-b'] },
    'runtime-2': { 'wt-other': ['pty-c'] }
  }
  installHosts()
})

afterEach(() => {
  resetAgentHibernationCoordinatorForTests()
  resetRuntimePtyLivenessQueueForTests()
  clearRuntimeCompatibilityCacheForTests()
  call.mockReset()
})

describe('sleeping runtime-backed panes the user was shown', () => {
  it('offers proven-live panes as unmeasured and sleeps each exact PTY', async () => {
    const shutdown = installRuntimePanes()
    const plan = await display()
    expect(plan.reclaimable.map((s) => s.paneKey)).toEqual([PANE_A, PANE_B, PANE_C])
    expect(plan.estimate).toMatchObject({
      knownBytes: 0,
      knownCount: 0,
      unknownCount: 3,
      unknownReasons: ['not-locally-measured']
    })

    const results = await sleepAuthorizedAgentPanes(
      plan.reclaimable.map((subject) => subject.authorization!)
    )

    expect(results.map((r) => r.outcome)).toEqual(['slept', 'slept', 'slept'])
    expect(slept(shutdown)).toEqual([
      { worktreeId: 'wt-bg', paneKey: PANE_A, expectedRuntimePtyId: 'pty-a' },
      { worktreeId: 'wt-bg', paneKey: PANE_B, expectedRuntimePtyId: 'pty-b' },
      { worktreeId: 'wt-other', paneKey: PANE_C, expectedRuntimePtyId: 'pty-c' }
    ])
  })

  it('skips a pane whose PTY exited after display', async () => {
    const shutdown = installRuntimePanes()
    const shown = await authorizationsOnScreen()
    hosts['runtime-1']['wt-bg'] = ['pty-a']

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['slept', 'not-eligible', 'slept'])
    expect(slept(shutdown).map((s) => s.paneKey)).toEqual([PANE_A, PANE_C])
  })

  it('refuses a pane whose PTY was replaced after display, even though the new one lives', async () => {
    const shutdown = installRuntimePanes()
    const shown = await authorizationsOnScreen()
    hosts['runtime-1']['wt-bg'] = ['pty-a', 'pty-b2']
    useAppStore.setState((s) => ({
      terminalLayoutsByTabId: { ...s.terminalLayoutsByTabId, 'tab-b': leafLayout(LEAF_B, 'pty-b2') }
    }))

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['slept', 'changed', 'slept'])
    expect(slept(shutdown).map((s) => s.expectedRuntimePtyId)).toEqual(['pty-a', 'pty-c'])
  })

  it('sleeps nothing on a host that stops answering after display', async () => {
    const shutdown = installRuntimePanes()
    const shown = await authorizationsOnScreen()
    hosts['runtime-1']['wt-bg'] = new Error('terminal_liveness_unavailable')

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['not-eligible', 'not-eligible', 'slept'])
    expect(slept(shutdown).map((s) => s.paneKey)).toEqual([PANE_C])
  })

  it('refuses a worktree re-homed to another host after display, whatever that host lists', async () => {
    const shutdown = installRuntimePanes()
    const shown = await authorizationsOnScreen()
    hosts['runtime-2']['wt-bg'] = ['pty-a', 'pty-b']
    useAppStore.setState({ worktreesByRepo: owners('runtime-2', 'runtime-2') })

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['changed', 'changed', 'slept'])
    expect(slept(shutdown).map((s) => s.paneKey)).toEqual([PANE_C])
  })

  it('never adds a pane that was unknown when shown and became provable later', async () => {
    const shutdown = installRuntimePanes()
    hosts['runtime-2']['wt-other'] = new Error('unreachable')
    const plan = await display()
    expect(plan.reclaimable.map((s) => s.paneKey)).toEqual([PANE_A, PANE_B])
    expect(plan.excluded.map((s) => [s.paneKey, s.exclusionReason])).toEqual([
      [PANE_C, 'runtime-liveness-unknown']
    ])
    hosts['runtime-2']['wt-other'] = ['pty-c']

    const results = await sleepAuthorizedAgentPanes(
      plan.reclaimable.map((subject) => subject.authorization!)
    )

    expect(results.map((r) => r.candidateId)).toEqual([`wt-bg|${PANE_A}`, `wt-bg|${PANE_B}`])
    expect(slept(shutdown).map((s) => s.paneKey)).toEqual([PANE_A, PANE_B])
  })

  it("sleeps a paired client's pane by the host PTY behind its terminal handle", async () => {
    const shutdown = installRuntimePanes()
    // A paired client knows its pane only as remote:<env>@@<terminal handle>.
    useAppStore.setState((s) => ({
      terminalLayoutsByTabId: {
        ...s.terminalLayoutsByTabId,
        'tab-a': leafLayout(LEAF_A, 'remote:runtime-1@@term_a')
      }
    }))
    hosts['runtime-1']['wt-bg'] = ['term_a>host-pty-a', 'pty-b']
    const shown = await authorizationsOnScreen()
    expect(shown.map((a) => a.candidateId)).toContain(`wt-bg|${PANE_A}`)

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['slept', 'slept', 'slept'])
    expect(slept(shutdown)[0]).toEqual({
      worktreeId: 'wt-bg',
      paneKey: PANE_A,
      expectedRuntimePtyId: 'host-pty-a'
    })
  })

  it('refuses a paired pane whose handle now names a different host PTY', async () => {
    const shutdown = installRuntimePanes()
    useAppStore.setState((s) => ({
      terminalLayoutsByTabId: {
        ...s.terminalLayoutsByTabId,
        'tab-a': leafLayout(LEAF_A, 'remote:runtime-1@@term_a')
      }
    }))
    hosts['runtime-1']['wt-bg'] = ['term_a>host-pty-a', 'pty-b']
    const shown = await authorizationsOnScreen()
    hosts['runtime-1']['wt-bg'] = ['term_a>host-pty-a2', 'pty-b']

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['changed', 'slept', 'slept'])
    expect(slept(shutdown).map((s) => s.expectedRuntimePtyId)).toEqual(['pty-b', 'pty-c'])
  })

  it('keeps a pane pinned after display awake although its host proves it live', async () => {
    const shutdown = installRuntimePanes()
    const shown = await authorizationsOnScreen()
    useAppStore.setState((s) => ({
      tabsByWorktree: {
        ...s.tabsByWorktree,
        'wt-bg': [{ ...tab('tab-a', 'wt-bg'), isPinned: true }, tab('tab-b', 'wt-bg')]
      }
    }))

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => r.outcome)).toEqual(['not-eligible', 'slept', 'slept'])
    expect(slept(shutdown).map((s) => s.paneKey)).toEqual([PANE_B, PANE_C])
  })
})

/**
 * Two refusals can be identical to a user and need opposite fixes: a pin is a decision, an
 * unanswered host is a question we could not ask. The outcome word is the same for both, so
 * the cause is the only thing that can tell them apart afterwards.
 */
describe('why a runtime pane did not sleep', () => {
  it('separates a host that could not be asked from a pane the user pinned', async () => {
    installRuntimePanes()
    const shown = await authorizationsOnScreen()
    hosts['runtime-1']['wt-bg'] = new Error('terminal_liveness_unavailable')
    useAppStore.setState((s) => ({
      tabsByWorktree: {
        ...s.tabsByWorktree,
        'wt-other': [{ ...tab('tab-c', 'wt-other'), isPinned: true }]
      }
    }))

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.map((r) => ({ outcome: r.outcome, cause: r.cause }))).toEqual([
      { outcome: 'not-eligible', cause: 'runtime-liveness-unknown' },
      { outcome: 'not-eligible', cause: 'runtime-liveness-unknown' },
      { outcome: 'not-eligible', cause: 'tab-pinned' }
    ])
  })

  it('says nothing about a pane that slept', async () => {
    installRuntimePanes()
    const shown = await authorizationsOnScreen()

    const results = await sleepAuthorizedAgentPanes(shown)

    expect(results.every((r) => r.outcome === 'slept' && r.cause === undefined)).toBe(true)
  })

  it.each([
    ['agent_hibernation_pane_binding_mismatch', 'pane-binding-mismatch'],
    ['agent_hibernation_capture_missing', 'capture-missing'],
    ['missing_runtime_for_exact_terminal_stop', 'runtime-missing'],
    ['exact_terminal_stop_mismatch', 'stop-targeted-wrong-pty'],
    ['terminal_worktree_sleep_still_live', 'stop-still-live']
  ])('names the effect that threw %s', async (thrown, cause) => {
    installRuntimePanes(vi.fn().mockRejectedValue(new Error(thrown)))
    const shown = await authorizationsOnScreen()

    const results = await sleepAuthorizedAgentPanes([shown[0]!])

    expect(results).toEqual([{ candidateId: shown[0]!.candidateId, outcome: 'failed', cause }])
  })

  it('reads the token through a transport that re-wrapped it', async () => {
    installRuntimePanes(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'runtimeEnvironments:call': Error: exact_terminal_stop_mismatch"
          )
        )
    )
    const shown = await authorizationsOnScreen()

    const results = await sleepAuthorizedAgentPanes([shown[0]!])

    expect(results[0]).toMatchObject({ outcome: 'failed', cause: 'stop-targeted-wrong-pty' })
  })

  it('does not dress an unrecognised failure as a known one', async () => {
    installRuntimePanes(vi.fn().mockRejectedValue(new Error('something nobody named')))
    const shown = await authorizationsOnScreen()

    const results = await sleepAuthorizedAgentPanes([shown[0]!])

    expect(results[0]).toMatchObject({ outcome: 'failed', cause: 'effect-threw' })
  })
})
