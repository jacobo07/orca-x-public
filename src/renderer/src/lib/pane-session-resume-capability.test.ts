import { describe, expect, it } from 'vitest'
import {
  resolvePaneSessionResumeCapability,
  type PaneSessionResumeInput
} from './pane-session-resume-capability'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-s' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 2,
    origin: 'live',
    automaticResumeBlockedBy: 'agent-exited',
    ...overrides
  }
}

const IDLE = { agent: null, shellForeground: true }

function input(overrides: Partial<PaneSessionResumeInput> = {}): PaneSessionResumeInput {
  return {
    hasLiveStatus: false,
    record: record(),
    foreground: IDLE,
    worktree: 'present',
    host: 'local',
    hasPlan: true,
    ...overrides
  }
}

describe('resolvePaneSessionResumeCapability', () => {
  it('offers the action for an exited pane at a confirmed idle prompt', () => {
    expect(resolvePaneSessionResumeCapability(input())).toEqual({ kind: 'available' })
  })

  it('stays hidden while the agent is running or the pane never exited', () => {
    expect(resolvePaneSessionResumeCapability(input({ hasLiveStatus: true })).kind).toBe('hidden')
    expect(resolvePaneSessionResumeCapability(input({ record: undefined })).kind).toBe('hidden')
    expect(
      resolvePaneSessionResumeCapability(
        input({ record: record({ automaticResumeBlockedBy: undefined }) })
      ).kind
    ).toBe('hidden')
  })

  it('hides a pane that is only fenced, and refuses one fenced and exited', () => {
    expect(
      resolvePaneSessionResumeCapability(
        input({ record: record({ automaticResumeBlockedBy: 'legacy-orchestration-worker' }) })
      ).kind
    ).toBe('hidden')
    expect(
      resolvePaneSessionResumeCapability(
        input({
          record: record({ automaticResumeBlockedBy: 'legacy-orchestration-worker-exited' })
        })
      )
    ).toEqual({ kind: 'unavailable', reason: 'legacy-fence' })
  })

  it('says why a resume cannot run here', () => {
    expect(resolvePaneSessionResumeCapability(input({ worktree: 'missing' }))).toEqual({
      kind: 'unavailable',
      reason: 'worktree-missing'
    })
    expect(resolvePaneSessionResumeCapability(input({ worktree: 'deleting' }))).toEqual({
      kind: 'unavailable',
      reason: 'worktree-deleting'
    })
    expect(resolvePaneSessionResumeCapability(input({ host: 'ssh' }))).toEqual({
      kind: 'unavailable',
      reason: 'remote'
    })
    expect(resolvePaneSessionResumeCapability(input({ host: 'runtime' }))).toEqual({
      kind: 'unavailable',
      reason: 'runtime-routed'
    })
    expect(resolvePaneSessionResumeCapability(input({ hasPlan: false }))).toEqual({
      kind: 'unavailable',
      reason: 'no-plan'
    })
  })

  it('never treats an unproven prompt as idle', () => {
    expect(resolvePaneSessionResumeCapability(input({ foreground: undefined }))).toEqual({
      kind: 'disabled',
      reason: 'shell-unconfirmed'
    })
    // A running command and a failed inspection both publish this reading.
    expect(
      resolvePaneSessionResumeCapability(
        input({ foreground: { agent: null, shellForeground: false } })
      )
    ).toEqual({ kind: 'disabled', reason: 'shell-unconfirmed' })
    expect(
      resolvePaneSessionResumeCapability(
        input({ foreground: { agent: 'claude', shellForeground: false } })
      )
    ).toEqual({ kind: 'disabled', reason: 'shell-busy' })
  })
})
