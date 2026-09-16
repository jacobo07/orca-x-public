// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { MemorySnapshot, ProcessSweepOutcome } from '../../../../shared/process-stats-types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from '@/lib/agent-hibernation-planner'
import { hydrateDrivers, setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { getResourceMemoryMetricCopy } from './resource-memory-metric-copy'
import { SleepReclaimAuthorizationPanel } from './SleepReclaimAuthorizationPanel'

const MB = 1024 * 1024
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

function snapshot(processSweep: ProcessSweepOutcome = 'measured'): MemorySnapshot {
  const sessionMemory = processSweep === 'measured' ? 300 * MB : 0
  return {
    app: {
      cpu: 1,
      memory: 200 * MB,
      main: { cpu: 1, memory: 100 * MB },
      renderer: { cpu: 0, memory: 100 * MB },
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
        memory: sessionMemory,
        sessions: [
          { sessionId: 'pty-1', paneKey: PANE_KEY, pid: 4242, cpu: 0, memory: sessionMemory }
        ],
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
    processMemoryMetric: 'rss',
    totalCpu: 1,
    totalMemory: 200 * MB + sessionMemory,
    processSweep,
    collectedAt: Date.now()
  }
}

function entry(): AgentStatusEntry {
  const idleSince = Date.now() - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 60_000
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: idleSince,
    stateStartedAt: idleSince,
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: []
  }
}

/** One completed agent in a background worktree: the planner's eligible shape. */
function installEligibleState(overrides: Partial<AppState> = {}): ReturnType<typeof vi.fn> {
  const shutdown = vi.fn()
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
    tabsByWorktree: {
      'wt-bg': [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: 'wt-bg',
          title: 'Agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    agentStatusByPaneKey: { [PANE_KEY]: entry() },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    memorySnapshot: snapshot(),
    shutdownCompletedAgentPaneForHibernation: shutdown as never,
    shutdownWorktreeTerminals: shutdown as never,
    ...overrides
  })
  return shutdown
}

describe('SleepReclaimAuthorizationPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    hydrateDrivers([])
  })

  function mount(): void {
    act(() => root.render(<SleepReclaimAuthorizationPanel />))
  }

  function known(): string | null {
    return container.querySelector('[data-testid="reclaim-known"]')?.textContent ?? null
  }

  it('shows the live plan for an eligible measured agent, in the collector metric', () => {
    installEligibleState()
    mount()
    expect(container.textContent).toContain('1 idle agent can sleep')
    expect(known()).toContain('300.0 MB')
    expect(known()).toContain(getResourceMemoryMetricCopy('rss').summaryLabel)
  })

  it('destroys nothing by being shown', () => {
    const shutdown = installEligibleState()
    mount()
    act(() => useAppStore.setState({ memorySnapshot: snapshot() }))
    expect(container.textContent).toContain('1 idle agent can sleep')
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('follows a Mobile lock taken after display, on the next snapshot poll', () => {
    installEligibleState()
    mount()
    expect(container.textContent).toContain('1 idle agent can sleep')

    // The lock lives outside the store; the poll is what makes the panel re-read it.
    setDriverForPty('pty-1', { kind: 'mobile', clientId: 'phone-1' })
    act(() => useAppStore.setState({ memorySnapshot: snapshot() }))

    expect(container.textContent).toContain('0 idle agents can sleep')
    expect(known()).toBeNull()
    expect(container.textContent).toContain('1 pane is kept awake')
  })

  it('reports a failed sweep as unmeasured rather than a size', () => {
    installEligibleState({ memorySnapshot: snapshot('failed') })
    mount()
    expect(container.textContent).toContain('1 idle agent can sleep')
    expect(known()).toBeNull()
    expect(container.textContent).toMatch(/not been measured/)
  })

  it('keeps every pane awake and states no size while agent sleep is off', () => {
    installEligibleState({ settings: { experimentalAgentHibernation: false } as never })
    mount()
    expect(container.textContent).toContain('0 idle agents can sleep')
    expect(known()).toBeNull()
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Agent sleep is off')
  })
})
