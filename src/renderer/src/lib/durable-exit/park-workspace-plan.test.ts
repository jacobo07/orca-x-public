import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { planParkWorkspaces, type ParkPlanSnapshot } from './park-workspace-plan'

const WT = 'wt-1'
const OLD = 1_000
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_S = '22222222-2222-4222-8222-222222222222'
const LEAF_OTHER = '33333333-3333-4333-8333-333333333333'

function tab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WT,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function agent(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'p',
    updatedAt: OLD,
    stateStartedAt: OLD,
    paneKey: `agent-tab:${LEAF_A}`,
    tabId: 'agent-tab',
    worktreeId: WT,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: [],
    ...overrides
  }
}

function snapshot(overrides: Partial<ParkPlanSnapshot> = {}): ParkPlanSnapshot {
  const entry = agent()
  return {
    tabsByWorktree: { [WT]: [tab('agent-tab'), tab('shell-tab')], 'wt-idle': [tab('idle-tab')] },
    terminalLayoutsByTabId: {
      'agent-tab': {
        root: { type: 'leaf', leafId: LEAF_A },
        activeLeafId: LEAF_A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_A]: 'pty-agent' }
      },
      'shell-tab': {
        root: { type: 'leaf', leafId: LEAF_S },
        activeLeafId: LEAF_S,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_S]: 'pty-shell' }
      }
    },
    ptyIdsByTabId: { 'agent-tab': ['pty-agent'], 'shell-tab': ['pty-shell'], 'idle-tab': [] },
    mobileLockedPtyIds: [],
    pinnedTerminalTabIds: [],
    agentStatusByPaneKey: { [entry.paneKey]: entry },
    lastTerminalInputAtByPaneKey: {},
    ...overrides
  }
}

const idleShell = { 'pty-shell': false, 'pty-agent': true } as const

function reasons(
  snap: ParkPlanSnapshot,
  children: Record<string, boolean | 'unknown'> = idleShell,
  includePinned = false
) {
  return planParkWorkspaces(snap, children, { includePinned }).map((plan) => ({
    worktreeId: plan.worktreeId,
    keepReasons: plan.keepReasons
  }))
}

describe('planParkWorkspaces', () => {
  it('releases a finished resumable agent and an idle shell, and ignores a workspace with no process', () => {
    const plans = planParkWorkspaces(snapshot(), idleShell, { includePinned: false })
    expect(plans).toEqual([
      { worktreeId: WT, livePtyIds: ['pty-agent', 'pty-shell'], keepReasons: [] }
    ])
  })

  it('does not read an agent pane child process as a busy shell', () => {
    expect(reasons(snapshot(), { 'pty-shell': false, 'pty-agent': true })).toEqual([
      { worktreeId: WT, keepReasons: [] }
    ])
  })

  it.each([
    ['a working agent', agent({ state: 'working' }), 'agent-working'],
    ['an interrupted agent', agent({ interrupted: true }), 'agent-working'],
    [
      'an agent with subagents',
      agent({ subagents: [{ id: 's' }] as unknown as AgentStatusEntry['subagents'] }),
      'agent-subagents'
    ],
    ['an agent without a session', agent({ providerSession: undefined }), 'agent-not-resumable']
  ])('keeps the workspace for %s', (_label, entry, reason) => {
    expect(reasons(snapshot({ agentStatusByPaneKey: { [entry.paneKey]: entry } }))).toEqual([
      { worktreeId: WT, keepReasons: [reason] }
    ])
  })

  it('keeps the workspace when a draft typed after completion would be lost', () => {
    const entry = agent()
    expect(
      reasons(snapshot({ lastTerminalInputAtByPaneKey: { [entry.paneKey]: OLD + 5 } }))
    ).toEqual([{ worktreeId: WT, keepReasons: ['unsent-input'] }])
  })

  it('keeps a workspace a phone is driving', () => {
    expect(reasons(snapshot({ mobileLockedPtyIds: ['pty-shell'] }))).toEqual([
      { worktreeId: WT, keepReasons: ['mobile-held'] }
    ])
  })

  it('keeps a shell with children, and a shell nobody could inspect', () => {
    expect(reasons(snapshot(), { 'pty-shell': true })).toEqual([
      { worktreeId: WT, keepReasons: ['shell-busy'] }
    ])
    expect(reasons(snapshot(), { 'pty-shell': 'unknown' })).toEqual([
      { worktreeId: WT, keepReasons: ['process-unknown'] }
    ])
    expect(reasons(snapshot(), {})).toEqual([{ worktreeId: WT, keepReasons: ['process-unknown'] }])
  })

  it('keeps a pinned tab unless the caller includes pinned tabs', () => {
    const snap = snapshot({ pinnedTerminalTabIds: ['shell-tab'] })
    expect(reasons(snap)).toEqual([{ worktreeId: WT, keepReasons: ['pinned'] }])
    expect(reasons(snap, idleShell, true)).toEqual([{ worktreeId: WT, keepReasons: [] }])
  })

  it('does not count a dormant tab wake hint as a running terminal', () => {
    const snap = snapshot({
      tabsByWorktree: {
        [WT]: [tab('agent-tab'), tab('shell-tab')],
        'wt-slept': [tab('slept-tab', { dormancy: { reason: 'workspace-sleep' } })]
      },
      ptyIdsByTabId: {
        'agent-tab': ['pty-agent'],
        'shell-tab': ['pty-shell'],
        'slept-tab': ['pty-hint']
      }
    })
    expect(reasons(snap, { ...idleShell, 'pty-hint': 'unknown' })).toEqual([
      { worktreeId: WT, keepReasons: [] }
    ])
  })

  it('treats an agent record on another pane as no evidence for this one', () => {
    const elsewhere = agent({ paneKey: `agent-tab:${LEAF_OTHER}` })
    expect(
      reasons(snapshot({ agentStatusByPaneKey: { [elsewhere.paneKey]: elsewhere } }), {
        'pty-shell': false,
        'pty-agent': true
      })
    ).toEqual([{ worktreeId: WT, keepReasons: ['shell-busy'] }])
  })
})
