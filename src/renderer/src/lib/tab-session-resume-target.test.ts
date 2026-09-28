import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { PaneSessionResumeCapability } from './pane-session-resume-capability'

let capabilities: Record<string, PaneSessionResumeCapability>
const read = vi.fn((_state: unknown, target: { paneKey: string }) => {
  return capabilities[target.paneKey] ?? { kind: 'hidden' }
})
vi.mock('@/lib/pane-session-resume-capability', () => ({
  readPaneSessionResumeCapability: (state: unknown, target: { paneKey: string }) =>
    read(state, target)
}))

const { resolveTabSessionResumeTargetKey, decodeTabSessionResumeTarget } =
  await import('./tab-session-resume-target')

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const TAB = { id: 'tab-1', worktreeId: 'wt-1' }
const A = `tab-1:${LEAF_A}`
const B = `tab-1:${LEAF_B}`
const OTHER_TAB = `tab-2:${LEAF_A}`

function record(blocked: boolean): SleepingAgentSessionRecord {
  return {
    agent: 'claude',
    ...(blocked ? { automaticResumeBlockedBy: 'agent-exited' } : {})
  } as SleepingAgentSessionRecord
}

function stateWith(records: Record<string, SleepingAgentSessionRecord>): AppState {
  return { sleepingAgentSessionsByPaneKey: records } as unknown as AppState
}

function resolve(records: Record<string, SleepingAgentSessionRecord>) {
  return decodeTabSessionResumeTarget(resolveTabSessionResumeTargetKey(stateWith(records), TAB))
}

describe('resolveTabSessionResumeTargetKey', () => {
  beforeEach(() => {
    capabilities = {}
    read.mockClear()
  })

  it('names the one exited pane of this tab that can resume', () => {
    capabilities[A] = { kind: 'available' }
    expect(resolve({ [A]: record(true) })).toEqual({
      kind: 'one',
      paneKey: A,
      state: 'available'
    })
  })

  it('keeps a pane waiting on its prompt, with the reason, so the tooltip can say why', () => {
    capabilities[A] = { kind: 'disabled', reason: 'shell-unconfirmed' }
    expect(resolve({ [A]: record(true) })).toEqual({
      kind: 'one',
      paneKey: A,
      state: 'disabled',
      reason: 'shell-unconfirmed'
    })
  })

  it('never offers another tab’s session, even when it is the only one that can resume', () => {
    capabilities[OTHER_TAB] = { kind: 'available' }
    expect(resolve({ [OTHER_TAB]: record(true) })).toEqual({ kind: 'none' })
  })

  it('does not ask about a live session at all', () => {
    capabilities[A] = { kind: 'available' }
    expect(resolve({ [A]: record(false) })).toEqual({ kind: 'none' })
    expect(read).not.toHaveBeenCalled()
  })

  it('offers nothing for a pane the capability hides or cannot serve here', () => {
    capabilities[A] = { kind: 'hidden' }
    capabilities[B] = { kind: 'unavailable', reason: 'remote' }
    expect(resolve({ [A]: record(true), [B]: record(true) })).toEqual({ kind: 'none' })
  })

  it('sees a session that exits in the next snapshot, and treats a missing map as none', () => {
    capabilities[A] = { kind: 'available' }
    expect(resolve({ [A]: record(false) })).toEqual({ kind: 'none' })
    expect(resolve({ [A]: record(true) })).toEqual({ kind: 'one', paneKey: A, state: 'available' })
    expect(resolveTabSessionResumeTargetKey({} as AppState, TAB)).toBe('none')
  })

  it('refuses to choose between two resumable panes of one tab', () => {
    capabilities[A] = { kind: 'available' }
    capabilities[B] = { kind: 'disabled', reason: 'shell-busy' }
    expect(resolve({ [A]: record(true), [B]: record(true) })).toEqual({ kind: 'several' })
  })
})
