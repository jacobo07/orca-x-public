import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from './agent-hibernation-planner'
import {
  resetAgentHibernationCoordinatorForTests,
  runAgentHibernationTick,
  startAgentHibernationCoordinator
} from './agent-hibernation-coordinator'
import { hydrateDrivers, setDriverForPty } from './pane-manager/mobile-driver-state'
import {
  registerVisibleTerminalTab,
  resetForegroundTerminalTabIdsForTests,
  setForegroundTerminalTabIds
} from './foreground-terminal-tabs'
import {
  recordAgentHibernationPaneOutput,
  resetAgentHibernationOutputActivityForTests
} from './agent-hibernation-output-activity'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'
import { resetRuntimePtyLivenessQueueForTests } from './runtime-pty-liveness-sample'
import type { AppState } from '@/store/types'

const NOW = 10_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const PI_TRANSCRIPT_PATH = join(tmpdir(), 'pi-session-1.jsonl')

const mockRuntimeEnvironmentCall = vi.fn()
// Default answers exactly what a host with nothing to report answers, so the effect-time draft
// probe is a no-op for every test that is not about it.
const mockInspectProcess = vi.fn(async () => ({
  foregroundProcess: null,
  hasChildProcesses: false
}))

vi.stubGlobal('window', {
  api: {
    runtimeEnvironments: {
      call: mockRuntimeEnvironmentCall
    },
    pty: {
      inspectProcess: mockInspectProcess
    }
  }
})

function tab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF]: 'pty-1' }
  }
}

function entry(): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1,
    stateStartedAt: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1,
    paneKey: `tab-1:${LEAF}`,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: []
  }
}

function installEligibleState(
  shutdownCompletedAgentPaneForHibernation = vi.fn(),
  overrides: Partial<AppState> = {}
): typeof shutdownCompletedAgentPaneForHibernation {
  const e = entry()
  const runtimeOwnerEnvironmentId = overrides.settings?.activeRuntimeEnvironmentId ?? undefined
  useAppStore.setState({
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    } as never,
    activeWorktreeId: 'wt-active',
    repos: [],
    worktreesByRepo: {
      'fixture-repo': [
        { id: 'wt-bg', repoId: 'fixture-repo', hostId: 'local', runtimeOwnerEnvironmentId }
      ]
    } as never,
    detectedWorktreesByRepo: {},
    tabsByWorktree: { 'wt-bg': [tab()] },
    terminalLayoutsByTabId: { 'tab-1': layout() },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    agentStatusByPaneKey: { [e.paneKey]: e },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    shutdownCompletedAgentPaneForHibernation: shutdownCompletedAgentPaneForHibernation as never,
    shutdownWorktreeTerminals: vi.fn() as never,
    ...overrides
  })
  return shutdownCompletedAgentPaneForHibernation
}

function runtimeListResult(ptyIds: string[], truncated = false) {
  return {
    terminals: ptyIds.map((ptyId) => ({
      handle: `handle-${ptyId}`,
      ptyId,
      worktreeId: 'wt-bg',
      worktreePath: '/tmp/wt-bg',
      branch: 'feature',
      tabId: `pty:${ptyId}`,
      leafId: `pty:${ptyId}`,
      title: 'Agent',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: ''
    })),
    totalCount: ptyIds.length,
    truncated
  }
}

function installRuntimeListResponses(
  ...responses: (ReturnType<typeof runtimeListResult> | Error)[]
): void {
  const queue = [...responses]
  mockRuntimeEnvironmentCall.mockImplementation((args: { method: string }) => {
    const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
    if (compatible) {
      return Promise.resolve(compatible)
    }
    if (args.method === 'terminal.list') {
      const response = queue.shift() ?? runtimeListResult(['pty-1'])
      if (response instanceof Error) {
        return Promise.reject(response)
      }
      return Promise.resolve({
        id: 'terminal-list',
        ok: true,
        result: response,
        _meta: { runtimeId: 'runtime-1' }
      })
    }
    return Promise.resolve({
      id: 'default',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  resetAgentHibernationCoordinatorForTests()
  resetRuntimePtyLivenessQueueForTests()
  clearRuntimeCompatibilityCacheForTests()
  resetForegroundTerminalTabIdsForTests()
  resetAgentHibernationOutputActivityForTests()
  hydrateDrivers([])
  mockRuntimeEnvironmentCall.mockReset()
  vi.useRealTimers()
})

describe('agent sleep coordinator', () => {
  // The planner's input guard is the better instrument and owns every pane it has evidence for.
  // But its evidence is renderer-only and the shell outlives the renderer, so after a reload a
  // pane with a line waiting at it reads as untouched. These cover only that hole.
  describe('a line the host holds and this renderer never saw', () => {
    // mockResolvedValue replaces the implementation for good, so without this a 'typed' answer
    // leaks into every later test in the file and keeps their panes awake.
    afterEach(() => {
      mockInspectProcess.mockResolvedValue({
        foregroundProcess: null,
        hasChildProcesses: false
      })
    })

    it('keeps a pane awake when the host still holds a line', async () => {
      vi.useFakeTimers()
      mockInspectProcess.mockResolvedValue({
        foregroundProcess: null,
        hasChildProcesses: false,
        inputSincePrompt: 'typed'
      } as never)
      const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
      startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

      await vi.advanceTimersByTimeAsync(2000)

      expect(shutdown).not.toHaveBeenCalled()
    })

    it('sleeps when the host vouches the prompt is clean', async () => {
      vi.useFakeTimers()
      mockInspectProcess.mockResolvedValue({
        foregroundProcess: null,
        hasChildProcesses: false,
        inputSincePrompt: 'clean'
      } as never)
      const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
      startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

      await vi.advanceTimersByTimeAsync(2000)

      expect(shutdown).toHaveBeenCalled()
    })

    it('leaves a pane the renderer does have input for to the planner', async () => {
      // Not second-guessed: the segment logic already decided this pane, and it is the
      // instrument that can tell a draft from a submission.
      vi.useFakeTimers()
      mockInspectProcess.mockResolvedValue({
        foregroundProcess: null,
        hasChildProcesses: false,
        inputSincePrompt: 'typed'
      } as never)
      const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
        lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: 1 }
      })
      startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

      await vi.advanceTimersByTimeAsync(2000)

      expect(shutdown).toHaveBeenCalled()
    })

    // Phase 7: the stamp above belonged to a shell that is gone. A fresh shell in the same pane
    // has no renderer evidence, so the host must be asked again rather than skipped.
    it('asks the host again once a fresh shell has replaced the stamped one', async () => {
      vi.useFakeTimers()
      mockInspectProcess.mockResolvedValue({
        foregroundProcess: null,
        hasChildProcesses: false,
        inputSincePrompt: 'typed'
      } as never)
      const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
        lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: 1 }
      })
      useAppStore.getState().resetTerminalInputForFreshShell(`tab-1:${LEAF}`)
      startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

      await vi.advanceTimersByTimeAsync(2000)

      expect(shutdown).not.toHaveBeenCalled()
    })

    it('keeps the explicit exit when a fresh shell resets the input evidence', () => {
      const exited = {
        paneKey: `tab-1:${LEAF}`,
        worktreeId: 'wt-bg',
        tabId: 'tab-1',
        leafId: LEAF,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'exited-session' },
        updatedAt: 1,
        automaticResumeBlockedBy: 'agent-exited'
      } as never
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: { [`tab-1:${LEAF}`]: exited },
        lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: 1 },
        terminalInputPendingByPaneKey: { [`tab-1:${LEAF}`]: true }
      })

      useAppStore.getState().resetTerminalInputForFreshShell(`tab-1:${LEAF}`)

      const state = useAppStore.getState()
      expect(state.lastTerminalInputAtByPaneKey[`tab-1:${LEAF}`]).toBeUndefined()
      expect(state.terminalInputPendingByPaneKey[`tab-1:${LEAF}`]).toBeUndefined()
      expect(state.sleepingAgentSessionsByPaneKey[`tab-1:${LEAF}`]).toBe(exited)
    })

    it('sleeps when no authority can see the line, so an older host is not frozen awake', async () => {
      vi.useFakeTimers()
      mockInspectProcess.mockResolvedValue({
        foregroundProcess: null,
        hasChildProcesses: false
      } as never)
      const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
      startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

      await vi.advanceTimersByTimeAsync(2000)

      expect(shutdown).toHaveBeenCalled()
    })
  })

  it('hibernates an eligible background worktree after two stable ticks', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
    expect(useAppStore.getState().shutdownWorktreeTerminals).not.toHaveBeenCalled()
  })

  it('hibernates completed Pi after the periodic recovery capture', async () => {
    vi.useFakeTimers()
    const piEntry = {
      ...entry(),
      agentType: 'pi' as const,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-session-1',
        transcriptPath: PI_TRANSCRIPT_PATH
      }
    }
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      agentStatusByPaneKey: { [piEntry.paneKey]: piEntry },
      sleepingAgentSessionsByPaneKey: {
        [piEntry.paneKey]: {
          paneKey: piEntry.paneKey,
          tabId: piEntry.tabId,
          worktreeId: piEntry.worktreeId!,
          agent: 'pi',
          providerSession: piEntry.providerSession,
          prompt: '',
          state: 'working',
          capturedAt: piEntry.updatedAt,
          updatedAt: piEntry.updatedAt,
          origin: 'live'
        }
      }
    })

    const liveRecord = useAppStore.getState().sleepingAgentSessionsByPaneKey[piEntry.paneKey]
    useAppStore.getState().captureAllSleepingAgentSessions('periodic')
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[piEntry.paneKey]).toBe(liveRecord)

    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })
    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: piEntry.paneKey,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
  })

  it('hibernates an eligible pane when a sibling shell PTY is live', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-shell'] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
  })

  it('cancels timers when stopped', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    const stop = startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })
    stop()

    await vi.advanceTimersByTimeAsync(3000)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('revalidates fresh state before shutdown', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    useAppStore.setState({ activeWorktreeId: 'wt-bg' })
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not hibernate a foreground terminal tab that is not in the active worktree', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    setForegroundTerminalTabIds(['tab-1'])
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(3000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not hibernate a visible mounted terminal tab', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    const unregister = registerVisibleTerminalTab('tab-1')

    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 1_000)
    unregister()
    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 1_000 + DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1)
    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    await runAgentHibernationTick()
    // Why not a fixed number of microtask flushes: the tick dispatches its shutdown
    // fire-and-forget, so hand-counting hops pins the assertion to the call depth of the day.
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
  })

  it('requires the same candidate signature during final revalidation', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    let nowCalls = 0
    startAgentHibernationCoordinator({
      intervalMs: 1000,
      now: () => {
        nowCalls += 1
        if (nowCalls === 3) {
          const e = entry()
          useAppStore.setState({
            agentStatusByPaneKey: {
              [e.paneKey]: {
                ...e,
                providerSession: { key: 'session_id', id: 'session-2' }
              }
            }
          })
        }
        return NOW
      }
    })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('rechecks dispatch settlement before shutdown', async () => {
    vi.useFakeTimers()
    const completed = {
      ...entry(),
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        dispatchStatus: 'completed' as const
      }
    }
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      agentStatusByPaneKey: { [completed.paneKey]: completed }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [completed.paneKey]: {
          ...completed,
          orchestration: { ...completed.orchestration, dispatchStatus: 'dispatched' }
        }
      }
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('restarts confirmation when a foreground terminal visit refreshes idle state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))

    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 1_999)
    setForegroundTerminalTabIds(['tab-1'])
    vi.setSystemTime(NOW + 2_000)
    setForegroundTerminalTabIds([])

    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 2_000 + DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1)
    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    await runAgentHibernationTick()
    // Why not a fixed number of microtask flushes: the tick dispatches its shutdown
    // fire-and-forget, so hand-counting hops pins the assertion to the call depth of the day.
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
  })

  it('blocks shutdown when terminal input arrives between confirmation ticks', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    useAppStore.getState().recordTerminalInput(`tab-1:${LEAF}`, NOW)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('blocks shutdown when terminal output arrives between confirmation ticks', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    recordAgentHibernationPaneOutput(`tab-1:${LEAF}`)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not mutate the running coordinator clock on a second start', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })
    startAgentHibernationCoordinator({
      intervalMs: 1000,
      now: () => NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1
    })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalled()
  })

  it('does not hibernate a mobile-driven terminal', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    setDriverForPty('pty-1', { kind: 'mobile', clientId: 'phone-1' })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(3000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('hibernates a runtime-backed candidate with fresh liveness and exact PTYs', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-1'])
    )
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1',
      expectedRuntimePtyId: 'pty-1'
    })
    expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ requireFreshPtyLiveness: true })
      })
    )
  })

  it('requires fresh runtime liveness for confirmation and pre-shutdown recheck', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-shell'])
    )
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
    expect(
      mockRuntimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'terminal.list')
    ).toHaveLength(3)
  })

  it('uses fresh store state after awaiting runtime liveness before shutdown', async () => {
    vi.useFakeTimers()
    const delayed = deferred<ReturnType<typeof runtimeListResult>>()
    const responses: (
      | ReturnType<typeof runtimeListResult>
      | Promise<ReturnType<typeof runtimeListResult>>
    )[] = [runtimeListResult(['pty-1']), runtimeListResult(['pty-1']), delayed.promise]
    mockRuntimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.list') {
        return Promise.resolve(responses.shift() ?? runtimeListResult(['pty-1'])).then(
          (result) => ({
            id: 'terminal-list',
            ok: true,
            result,
            _meta: { runtimeId: 'runtime-1' }
          })
        )
      }
      return Promise.resolve({
        id: 'default',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-1' }
      })
    })
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    useAppStore.setState({ activeWorktreeId: 'wt-bg' })
    delayed.resolve(runtimeListResult(['pty-1']))
    await Promise.resolve()

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('hibernates runtime-backed candidates independently when siblings remain live', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(
      runtimeListResult(['pty-1', 'pty-2']),
      runtimeListResult(['pty-1', 'pty-2']),
      runtimeListResult(['pty-1', 'pty-2']),
      runtimeListResult(['pty-1', 'pty-2']),
      runtimeListResult(['pty-1', 'pty-2'])
    )
    const secondLeaf = '22222222-2222-4222-8222-222222222222'
    const e = {
      ...entry(),
      paneKey: `tab-1:${secondLeaf}`,
      providerSession: { key: 'session_id' as const, id: 'session-2' }
    }
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...layout(),
          ptyIdsByLeafId: { [LEAF]: 'pty-1', [secondLeaf]: 'pty-2' }
        }
      },
      agentStatusByPaneKey: {
        [`tab-1:${LEAF}`]: entry(),
        [e.paneKey]: e
      }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1',
      expectedRuntimePtyId: 'pty-1'
    })
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${secondLeaf}`,
      tabId: 'tab-1',
      leafId: secondLeaf,
      ptyId: 'pty-2',
      expectedRuntimePtyId: 'pty-2'
    })
  })

  it('samples every runtime worktree on one host, which rejects overlapping listings', async () => {
    vi.useFakeTimers()
    let inFlight = 0
    mockRuntimeEnvironmentCall.mockImplementation(
      (args: { method: string; params: { worktree: string } }) => {
        const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
        if (compatible) {
          return Promise.resolve(compatible)
        }
        if (args.method !== 'terminal.list') {
          return Promise.resolve({ id: 'x', ok: true, result: {}, _meta: { runtimeId: 'r' } })
        }
        // Like the host: a listing overtaken by another fails closed.
        inFlight += 1
        const overlapped = inFlight > 1
        const worktreeId = args.params.worktree.replace(/^id:/, '')
        return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
          inFlight -= 1
          if (overlapped) {
            throw new Error('terminal_liveness_unavailable')
          }
          const result = runtimeListResult([worktreeId === 'wt-bg' ? 'pty-1' : 'pty-2'])
          return {
            id: 'terminal-list',
            ok: true,
            result: {
              ...result,
              terminals: result.terminals.map((t) => ({ ...t, worktreeId }))
            },
            _meta: { runtimeId: 'r' }
          }
        })
      }
    )
    const leaf2 = '22222222-2222-4222-8222-222222222222'
    const second = {
      ...entry(),
      paneKey: `tab-2:${leaf2}`,
      tabId: 'tab-2',
      worktreeId: 'wt-bg2',
      providerSession: { key: 'session_id' as const, id: 'session-2' }
    }
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      worktreesByRepo: {
        'fixture-repo': ['wt-bg', 'wt-bg2'].map((id) => ({
          id,
          repoId: 'fixture-repo',
          hostId: 'local',
          runtimeOwnerEnvironmentId: 'runtime-1'
        }))
      } as never,
      tabsByWorktree: {
        'wt-bg': [tab()],
        'wt-bg2': [{ ...tab(), id: 'tab-2', worktreeId: 'wt-bg2' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': layout(),
        'tab-2': {
          root: { type: 'leaf', leafId: leaf2 },
          activeLeafId: leaf2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf2]: 'pty-2' }
        }
      },
      ptyIdsByTabId: { 'tab-1': [], 'tab-2': [] },
      agentStatusByPaneKey: { [`tab-1:${LEAF}`]: entry(), [second.paneKey]: second }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(100)

    expect(shutdown.mock.calls.map(([worktreeId]) => worktreeId).sort()).toEqual([
      'wt-bg',
      'wt-bg2'
    ])
  })

  it('fails closed on truncated runtime liveness samples', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(runtimeListResult(['pty-1'], true), runtimeListResult(['pty-1']))
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('fails closed when fresh runtime liveness rejects after an earlier good sample', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(runtimeListResult(['pty-1']), new Error('runtime unavailable'))
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
    expect(
      mockRuntimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'terminal.list')
    ).toHaveLength(2)
  })
})
