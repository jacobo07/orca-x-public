import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeActiveTerminalState(tabId: string, worktreeId = 'wt-1'): Record<string, unknown> {
  return {
    activeWorktreeId: worktreeId,
    activeTabType: 'terminal',
    activeTabId: tabId,
    activeTabIdByWorktree: { [worktreeId]: tabId }
  }
}

const ptyLessLayout = {
  root: { type: 'leaf', leafId: LEAF_ID },
  activeLeafId: LEAF_ID,
  expandedLeafId: null
}

describe('resumeSleepingAgentSessionsForWorktree revival fidelity', () => {
  // Why: an agent parked on a permission prompt or question emits no hooks, so its age says
  // nothing about whether it is still resumable; discarding it stranded the pane as a plain shell.
  it.each(['waiting', 'blocked'] as const)(
    'keeps and resumes a quit record left %s longer than the stale window',
    (state) => {
      const record = makeRecord({ origin: 'quit', state, capturedAt: 3_000_000, updatedAt: 1 })
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [] },
        sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
      } as never)

      const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

      expect(launched).toBe(1)
      expect(useAppStore.getState().tabsByWorktree['wt-1']?.[0]?.launchAgent).toBe('claude')
    }
  )

  // Why: the claim is written when a wake creates the tab and outlives the spawn, so on the tab's
  // second sleep→wake it named the tab's own session and deleted the record its pane resumes from.
  it('keeps a pane-owned record whose own tab still carries the claim from an earlier wake', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep', capturedAt: 5, updatedAt: 5 })
    useAppStore.setState({
      ...makeActiveTerminalState('tab-1'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: {
        'tab-1': { ...ptyLessLayout, ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' } }
      },
      automaticAgentResumeClaimsByTabId: {
        'tab-1': {
          worktreeId: 'wt-1',
          launchAgent: 'claude',
          providerSession: record.providerSession
        }
      },
      sleepingAgentSessionsByPaneKey: { [paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBe(record)
  })

  it('still clears a record whose session a different tab has claimed', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep' })
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [makeTerminalTab('tab-1', 'wt-1'), makeTerminalTab('tab-2', 'wt-1')]
      },
      automaticAgentResumeClaimsByTabId: {
        'tab-2': {
          worktreeId: 'wt-1',
          launchAgent: 'claude',
          providerSession: record.providerSession
        }
      },
      sleepingAgentSessionsByPaneKey: { [paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })

  // Why: the preserved pane resumes its own record in place on mount even with no PTY; forking a
  // new tab here cleared that record first, so the original pane came back as a plain shell and the
  // session reopened at the end of the tab strip.
  it.each(['worktree-sleep', 'live', 'quit'] as const)(
    'leaves a %s record to its preserved leaf in the active worktree even with no PTY binding',
    (origin) => {
      const paneKey = makePaneKey('tab-1', LEAF_ID)
      const record = makeRecord({ paneKey, origin })
      useAppStore.setState({
        ...makeActiveTerminalState('tab-1'),
        tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
        terminalLayoutsByTabId: { 'tab-1': ptyLessLayout },
        sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
      } as never)

      const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

      const state = useAppStore.getState()
      expect(launched).toBe(0)
      expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
      expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    }
  )

  it('still forks a PTY-less preserved leaf whose worktree is not active', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'live' })
    useAppStore.setState({
      ...makeActiveTerminalState('other-tab', 'wt-other'),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': ptyLessLayout },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })
})
