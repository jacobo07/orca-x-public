import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { runParkPhase, type ParkPhaseDeps } from './run-park-request'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

const LEAF = '11111111-1111-4111-8111-111111111111'

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

type World = {
  state: AppState
  events: string[]
  children: Record<string, boolean | 'unknown'>
  hostHoldsLine: string[]
  deps: ParkPhaseDeps
}

function world(overrides: { agentState?: AgentStatusEntry['state'] } = {}): World {
  const agent: AgentStatusEntry = {
    state: overrides.agentState ?? 'done',
    prompt: 'p',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: `a-tab:${LEAF}`,
    tabId: 'a-tab',
    worktreeId: 'wt-a',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 's' },
    stateHistory: []
  }
  const state = {
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    tabsByWorktree: {
      'wt-a': [tab('a-tab', 'wt-a')],
      'wt-b': [tab('b-tab', 'wt-b')],
      'wt-idle': [{ ...tab('idle-tab', 'wt-idle'), dormancy: { reason: 'workspace-sleep' } }]
    },
    terminalLayoutsByTabId: {
      'a-tab': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-a' }
      }
    },
    ptyIdsByTabId: { 'a-tab': ['pty-a'], 'b-tab': ['pty-b'], 'idle-tab': [] },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: { [agent.paneKey]: agent },
    lastTerminalInputAtByPaneKey: {},
    terminalInputPendingByPaneKey: {}
  } as unknown as AppState
  const w: World = {
    state,
    events: [],
    children: { 'pty-a': true, 'pty-b': false },
    hostHoldsLine: [],
    deps: undefined as unknown as ParkPhaseDeps
  }
  w.deps = {
    getState: () => w.state,
    inspectPty: async (ptyId) => ({
      children: w.children[ptyId] ?? 'unknown',
      hostHoldsLine: w.hostHoldsLine.includes(ptyId)
    }),
    saveSession: async () => {
      w.events.push('save')
    },
    sleepWorkspace: async (worktreeId) => {
      w.events.push(`sleep:${worktreeId}`)
      const s = w.state as unknown as {
        tabsByWorktree: Record<string, TerminalTab[]>
        ptyIdsByTabId: Record<string, string[]>
      }
      w.state = {
        ...w.state,
        ptyIdsByTabId: {
          ...s.ptyIdsByTabId,
          ...Object.fromEntries((s.tabsByWorktree[worktreeId] ?? []).map((t) => [t.id, []]))
        },
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((t) => ({
            ...t,
            dormancy: { reason: 'workspace-sleep' as const }
          }))
        }
      } as unknown as AppState
    }
  }
  return w
}

const park = { mode: 'park', includePinned: false } as const

describe('runParkPhase', () => {
  it('refuses when only the host knows the agent pane holds an unsent line', async () => {
    const w = world()
    w.hostHoldsLine = ['pty-a']
    const result = await runParkPhase(park, w.deps)
    expect(result.status).toBe('refused')
    expect(result.workspaces).toContainEqual({
      worktreeId: 'wt-a',
      outcome: 'kept',
      reasons: ['unsent-input'],
      livePtyCount: 1
    })
    expect(w.events).toEqual([])
  })

  it('refuses when an idle shell holds a line the host vouches for', async () => {
    const w = world()
    w.hostHoldsLine = ['pty-b']
    const result = await runParkPhase(park, w.deps)
    expect(result.status).toBe('refused')
    expect(result.workspaces).toContainEqual({
      worktreeId: 'wt-b',
      outcome: 'kept',
      reasons: ['unsent-input'],
      livePtyCount: 1
    })
    expect(w.events).toEqual([])
  })

  it('plans without saving or sleeping anything', async () => {
    const w = world({ agentState: 'working' })
    const result = await runParkPhase({ mode: 'plan', includePinned: false }, w.deps)
    expect(result.status).toBe('planned')
    expect(result.workspaces).toEqual([
      { worktreeId: 'wt-a', outcome: 'kept', reasons: ['agent-working'], livePtyCount: 1 },
      { worktreeId: 'wt-b', outcome: 'would-sleep', livePtyCount: 1 }
    ])
    expect(result.alreadyAsleepCount).toBe(1)
    expect(w.events).toEqual([])
  })

  it('refuses the whole park when anything must keep running, and changes nothing', async () => {
    const w = world({ agentState: 'working' })
    const result = await runParkPhase(park, w.deps)
    expect(result.status).toBe('refused')
    expect(w.events).toEqual([])
    expect(result.sleptTabIds).toEqual([])
  })

  it('seals, sleeps every workspace, then seals again', async () => {
    const w = world()
    const result = await runParkPhase(park, w.deps)
    expect(w.events).toEqual(['save', 'sleep:wt-a', 'sleep:wt-b', 'save'])
    expect(result.status).toBe('parked')
    expect(result.sleptTabIds).toEqual(['a-tab', 'b-tab'])
    expect(result.workspaces.map((workspace) => workspace.outcome)).toEqual(['slept', 'slept'])
  })

  it('sleeps nothing when the first seal fails', async () => {
    const w = world()
    w.deps.saveSession = async () => {
      throw new Error('disk full')
    }
    const result = await runParkPhase(park, w.deps)
    expect(result.status).toBe('seal-failed')
    expect(w.events).toEqual([])
  })

  it('refuses to seal before the session has hydrated', async () => {
    const w = world()
    w.state = { ...w.state, hydrationSucceeded: false } as AppState
    const result = await runParkPhase(park, w.deps)
    expect(result).toMatchObject({ status: 'seal-failed', detail: 'session-not-ready' })
    expect(w.events).toEqual([])
  })

  it('leaves a workspace running when it gains a reason after the plan', async () => {
    const w = world()
    const sleep = w.deps.sleepWorkspace
    w.deps.sleepWorkspace = async (worktreeId) => {
      await sleep(worktreeId)
      // A dev server starts in the next workspace while the first one sleeps.
      w.children['pty-b'] = true
    }
    const result = await runParkPhase(park, w.deps)
    expect(w.events).toEqual(['save', 'sleep:wt-a', 'save'])
    expect(result.status).toBe('incomplete')
    expect(result.workspaces[1]).toEqual({
      worktreeId: 'wt-b',
      outcome: 'changed',
      reasons: ['shell-busy']
    })
    expect(result.sleptTabIds).toEqual(['a-tab'])
  })

  it('never widens: a terminal started mid-run is left alone and the park is not complete', async () => {
    const w = world()
    const sleep = w.deps.sleepWorkspace
    w.deps.sleepWorkspace = async (worktreeId) => {
      await sleep(worktreeId)
      // A new terminal opens in the idle workspace (an opened tab is no longer dormant).
      w.state = {
        ...w.state,
        tabsByWorktree: {
          ...w.state.tabsByWorktree,
          'wt-idle': [...(w.state.tabsByWorktree['wt-idle'] ?? []), tab('new-tab', 'wt-idle')]
        },
        ptyIdsByTabId: { ...w.state.ptyIdsByTabId, 'new-tab': ['pty-new'] }
      } as AppState
      w.children['pty-new'] = false
    }
    const result = await runParkPhase(park, w.deps)
    expect(w.events).toEqual(['save', 'sleep:wt-a', 'sleep:wt-b', 'save'])
    expect(result.status).toBe('incomplete')
    expect(result.workspaces.at(-1)).toEqual({
      worktreeId: 'wt-idle',
      outcome: 'changed',
      reasons: []
    })
  })

  it('reports a sleep that left processes running as failed', async () => {
    const w = world()
    w.deps.sleepWorkspace = async (worktreeId) => {
      w.events.push(`sleep:${worktreeId}`)
    }
    const result = await runParkPhase(park, w.deps)
    expect(result.status).toBe('incomplete')
    expect(result.workspaces).toEqual([
      { worktreeId: 'wt-a', outcome: 'failed', detail: 'still-running' },
      { worktreeId: 'wt-b', outcome: 'failed', detail: 'still-running' }
    ])
    expect(result.sleptTabIds).toEqual([])
  })

  it('says there was nothing to park when no workspace has a process', async () => {
    const w = world()
    w.state = { ...w.state, ptyIdsByTabId: {} } as AppState
    const result = await runParkPhase(park, w.deps)
    expect(result.status).toBe('nothing-to-park')
    expect(w.events).toEqual(['save'])
  })
})
