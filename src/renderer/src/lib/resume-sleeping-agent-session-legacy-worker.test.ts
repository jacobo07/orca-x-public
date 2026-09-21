import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

describe('blocked sleeping-session recovery', () => {
  it.each([
    ['a proven-exited legacy worker', 'legacy-orchestration-worker'],
    ['an agent the user exited to its shell', 'agent-exited']
  ] as const)('never resumes %s on workspace activation', (_label, blockedBy) => {
    const record: SleepingAgentSessionRecord = {
      paneKey: 'tab-legacy:leaf-legacy',
      tabId: 'tab-legacy',
      worktreeId: 'wt-legacy',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'session-legacy' },
      prompt: 'continue legacy work',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live',
      automaticResumeBlockedBy: blockedBy
    }
    useAppStore.setState({
      tabsByWorktree: {
        'wt-legacy': [
          {
            id: 'tab-legacy',
            ptyId: null,
            worktreeId: 'wt-legacy',
            title: 'Legacy worker',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-legacy')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)

    useAppStore.getState().clearSleepingAgentSession(record.paneKey)
    expect(resumeSleepingAgentSessionsForWorktree('wt-legacy')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })
})
