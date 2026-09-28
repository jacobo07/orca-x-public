import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resumeMocks = vi.hoisted(() => ({ resume: vi.fn() }))
vi.mock('@/lib/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: resumeMocks.resume
}))

import { useAppStore } from '@/store'
import type { WakeAdmissionResult } from '../../../../shared/desk-continuity-read-types'
import type { WorkspaceRowModel } from './resume-center-model'
import type { LayoutRestoreResult } from './resume-center-restore'
import { resumeDeskOrphan, resumeDeskTab, type WakeDeps } from './resume-center-wake'
import {
  continueResumeAll,
  hasPausedResumeAll,
  planResumeAll,
  runResumeAll
} from './resume-all-queue'
import { readWakeState, resetWakeStateForTests } from './resume-center-wake-state'

const ADMITTED: WakeAdmissionResult = {
  verdict: 'admitted',
  availableMemoryBytes: 9e9,
  floorBytes: 4e9
}
const LOW_MEMORY: WakeAdmissionResult = {
  verdict: 'refused',
  reason: 'insufficient-available-memory',
  detail: 'low'
}
const UNMEASURED: WakeAdmissionResult = {
  verdict: 'refused',
  reason: 'executor-unobservable',
  detail: 'ssh'
}

function row(tabIds: string[], orphanKeys: string[] = []): WorkspaceRowModel {
  return {
    kind: 'projected',
    key: 'wt-1',
    hostId: 'local',
    identity: { kind: 'known', name: 'repo', path: '/repo' },
    window: { kind: 'unattributed', reason: 'no-window-binding' },
    lastVisitedAt: null,
    tabs: tabIds.map((tabId) => ({
      tabId,
      title: tabId,
      agent: null,
      residency: 'no-process' as const,
      resume: 'none' as const,
      panes: []
    })),
    orphanSessions: orphanKeys.map((paneKey) => ({
      paneKey,
      agent: 'codex',
      capturedAt: 1,
      resume: 'unconfirmed' as const
    })),
    openFileCount: 0,
    browserTabCount: 0,
    windowOrder: null,
    counts: { tabs: tabIds.length, panes: 0, warm: 0, dormant: 0, unknown: 0 }
  }
}

const requestOpen = vi.fn()
const setActiveTab = vi.fn()

function seedDormantTabs(tabIds: string[]): void {
  useAppStore.setState({
    tabsByWorktree: {
      'wt-1': tabIds.map((id) => ({
        id,
        ptyId: null,
        worktreeId: 'wt-1',
        title: id,
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0,
        dormancy: { reason: 'layout-restore', resumeContinuity: 'none' }
      }))
    },
    ptyIdsByTabId: {},
    requestDormantTerminalTabOpen: requestOpen,
    setActiveTab
  } as never)
}

/** Binds a PTY to the tab the way the runtime does: the marker clears only then. */
function bind(tabId: string): void {
  useAppStore.setState((s) => ({
    tabsByWorktree: {
      'wt-1': s.tabsByWorktree['wt-1']!.map((tab) =>
        tab.id === tabId ? { ...tab, dormancy: undefined, ptyId: `pty-${tabId}` } : tab
      )
    }
  }))
}

type Trace = string[]

function deps(
  admissions: WakeAdmissionResult[],
  trace: Trace,
  options: { bindOnWait?: boolean } = {}
): WakeDeps {
  let call = 0
  return {
    admit: vi.fn(async () => {
      trace.push('admit')
      return admissions[Math.min(call++, admissions.length - 1)]!
    }),
    restore: vi.fn(async (r: WorkspaceRowModel): Promise<LayoutRestoreResult> => {
      trace.push('restore')
      return {
        activated: true,
        outcomes: r.tabs.map((t) => ({ tabId: t.tabId, outcome: 'already-dormant' as const }))
      }
    }),
    waitFor: vi.fn(async (ready: () => boolean) => {
      const requested = requestOpen.mock.calls.at(-1)?.[0] as string | undefined
      trace.push(`wait:${requested ?? 'orphan'}`)
      if (options.bindOnWait !== false && requested) {
        bind(requested)
      }
      return ready()
    })
  }
}

describe('resumeDeskTab', () => {
  beforeEach(() => {
    resetWakeStateForTests()
    requestOpen.mockReset()
    setActiveTab.mockReset()
    seedDormantTabs(['a', 'b'])
  })

  it('opens exactly the chosen row after admission and calls it running only once its PTY binds', async () => {
    const trace: Trace = []
    const phase = await resumeDeskTab(row(['a', 'b']), 'a', 'selected', deps([ADMITTED], trace))
    expect(trace).toEqual(['admit', 'restore', 'wait:a'])
    expect(requestOpen.mock.calls).toEqual([['a']])
    expect(phase).toEqual({ phase: 'running' })
    expect(readWakeState().phases.get('b')).toBeUndefined()
  })

  it('refuses before restoring or opening anything when admission says no', async () => {
    const trace: Trace = []
    const phase = await resumeDeskTab(row(['a']), 'a', 'selected', deps([LOW_MEMORY], trace))
    expect(phase).toMatchObject({ phase: 'refused', reason: 'insufficient-available-memory' })
    expect(trace).toEqual(['admit'])
    expect(requestOpen).not.toHaveBeenCalled()
  })

  it('lets a chosen row on an unmeasured host go ahead, said to be unmeasured, but not in Resume all', async () => {
    const trace: Trace = []
    const seen: string[] = []
    const d = deps([UNMEASURED], trace)
    const original = d.waitFor
    d.waitFor = async (ready, ms) => {
      seen.push(JSON.stringify(readWakeState().phases.get('a')))
      return original(ready, ms)
    }
    expect(await resumeDeskTab(row(['a']), 'a', 'selected', d)).toEqual({ phase: 'running' })
    expect(seen).toEqual([JSON.stringify({ phase: 'materializing', notMeasured: true })])

    requestOpen.mockReset()
    seedDormantTabs(['a'])
    const all = await resumeDeskTab(row(['a']), 'a', 'resume-all', deps([UNMEASURED], []))
    expect(all).toMatchObject({ phase: 'refused', reason: 'executor-unobservable' })
    expect(requestOpen).not.toHaveBeenCalled()
  })

  it('never reports running when no PTY binds within the bound', async () => {
    const phase = await resumeDeskTab(
      row(['a']),
      'a',
      'selected',
      deps([ADMITTED], [], { bindOnWait: false })
    )
    expect(phase).toEqual({ phase: 'failed', reason: 'not-started' })
    expect(readWakeState().phases.get('a')).toEqual({ phase: 'failed', reason: 'not-started' })
  })
})

describe('resumeDeskOrphan', () => {
  beforeEach(() => {
    resetWakeStateForTests()
    resumeMocks.resume.mockReset()
    seedDormantTabs([])
  })

  it('resumes only the chosen record through the canonical resume', async () => {
    resumeMocks.resume.mockImplementation(
      (_key: string, options: { onSessionLaunched: (id: string) => void }) => {
        options.onSessionLaunched('new-tab')
        useAppStore.setState({ ptyIdsByTabId: { 'new-tab': ['pty-new'] } })
        return 1
      }
    )
    const phase = await resumeDeskOrphan(
      row([], ['k1', 'k2']),
      'k1',
      'selected',
      deps([ADMITTED], [])
    )
    expect(phase).toEqual({ phase: 'running' })
    const [key, options] = resumeMocks.resume.mock.calls[0] as [
      string,
      { onlyPaneKeys: Set<string> }
    ]
    expect(key).toBe('wt-1')
    expect([...options.onlyPaneKeys]).toEqual(['k1'])
  })

  it('says it could not be resumed when the canonical resume declines it', async () => {
    resumeMocks.resume.mockReturnValue(0)
    const phase = await resumeDeskOrphan(row([], ['k1']), 'k1', 'selected', deps([ADMITTED], []))
    expect(phase).toEqual({ phase: 'failed', reason: 'not-launched' })
  })
})

describe('runResumeAll', () => {
  beforeEach(() => {
    resetWakeStateForTests()
    requestOpen.mockReset()
    seedDormantTabs(['a', 'b', 'c'])
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes one at a time, each only after the previous bound', async () => {
    const trace: Trace = []
    const outcome = await runResumeAll(
      planResumeAll([row(['a', 'b', 'c'])]),
      0,
      deps([ADMITTED], trace)
    )
    expect(outcome).toEqual({ status: 'finished', started: 3, leftAsleep: 0 })
    expect(trace).toEqual([
      'admit',
      'restore',
      'wait:a',
      'admit',
      'restore',
      'wait:b',
      'admit',
      'restore',
      'wait:c'
    ])
  })

  it('stops at the first host-wide refusal, leaves the rest asleep, and Continue asks again there', async () => {
    const trace: Trace = []
    const items = planResumeAll([row(['a', 'b', 'c'])])
    const outcome = await runResumeAll(items, 0, deps([ADMITTED, LOW_MEMORY], trace))
    expect(outcome).toMatchObject({ status: 'stopped', started: 1, resumeFrom: 1 })
    expect(requestOpen.mock.calls).toEqual([['a']])
    expect(readWakeState().resumeAll).toMatchObject({ status: 'stopped', started: 1, remaining: 2 })
    expect(hasPausedResumeAll()).toBe(true)

    const resumed = await continueResumeAll(deps([ADMITTED], trace))
    expect(resumed).toEqual({ status: 'finished', started: 2, leftAsleep: 0 })
    expect(requestOpen.mock.calls).toEqual([['a'], ['b'], ['c']])
    expect(hasPausedResumeAll()).toBe(false)
  })

  it('skips an unmeasured item and carries on with the rest', async () => {
    const outcome = await runResumeAll(
      planResumeAll([row(['a', 'b'])]),
      0,
      deps([UNMEASURED, ADMITTED], [])
    )
    expect(outcome).toEqual({ status: 'finished', started: 1, leftAsleep: 1 })
    expect(requestOpen.mock.calls).toEqual([['b']])
  })

  it('joins a run already in flight instead of starting a second', async () => {
    const d = deps([ADMITTED], [])
    const items = planResumeAll([row(['a'])])
    const first = runResumeAll(items, 0, d)
    const second = runResumeAll(items, 0, d)
    expect(second).toBe(first)
    await first
    expect(requestOpen.mock.calls).toEqual([['a']])
  })
})
