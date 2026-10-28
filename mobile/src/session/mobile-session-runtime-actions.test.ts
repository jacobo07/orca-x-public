import { describe, expect, it, vi } from 'vitest'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  buildMobileSessionRuntimeActions,
  resolveActiveTabRuntime,
  type RuntimeAgentAction
} from './mobile-session-runtime-actions'

vi.mock('../components/ActionSheetModal', () => ({}))

function agentAction(label: string, runtimeAgentId?: string): RuntimeAgentAction {
  return { label, onPress: vi.fn(), ...(runtimeAgentId ? { runtimeAgentId } : {}) }
}

const terminal: ActionSheetAction = { label: 'Terminal', onPress: vi.fn() }

function terminalTab(fields: Partial<Extract<MobileSessionTab, { type: 'terminal' }>> = {}) {
  return { type: 'terminal', id: 't1', title: 'zsh', terminal: 'term-1', ...fields } as const
}

function hints(actions: ActionSheetAction[]) {
  return actions.map((action) => [action.label, action.hint ?? null])
}

describe('resolveActiveTabRuntime', () => {
  it('reads the agent a terminal tab runs', () => {
    expect(resolveActiveTabRuntime(terminalTab({ launchAgent: 'claude' }))).toEqual({
      kind: 'agent',
      agentId: 'claude'
    })
  })

  it('reads a terminal tab with no agent as a shell', () => {
    expect(resolveActiveTabRuntime(terminalTab())).toEqual({ kind: 'shell' })
  })

  it('reads a non-terminal tab or no tab as no runtime', () => {
    const browser = { type: 'browser', id: 'b1', title: 'Docs', url: 'https://x' }
    expect(resolveActiveTabRuntime(browser as MobileSessionTab)).toEqual({ kind: 'none' })
    expect(resolveActiveTabRuntime(null)).toEqual({ kind: 'none' })
  })
})

describe('buildMobileSessionRuntimeActions', () => {
  const agents = [agentAction('Claude', 'claude'), agentAction('ChatGPT', 'codex')]

  it('lists the agent rows, then Terminal', () => {
    const actions = buildMobileSessionRuntimeActions(agents, terminal, { kind: 'none' })
    expect(actions.map((action) => action.label)).toEqual(['Claude', 'ChatGPT', 'Terminal'])
  })

  it('marks the agent the active tab runs, and nothing else', () => {
    const actions = buildMobileSessionRuntimeActions(agents, terminal, {
      kind: 'agent',
      agentId: 'codex'
    })
    expect(hints(actions)).toEqual([
      ['Claude', null],
      ['ChatGPT', 'Active tab'],
      ['Terminal', null]
    ])
  })

  it('marks Terminal for a plain shell tab', () => {
    const actions = buildMobileSessionRuntimeActions(agents, terminal, { kind: 'shell' })
    expect(hints(actions)).toEqual([
      ['Claude', null],
      ['ChatGPT', null],
      ['Terminal', 'Active tab']
    ])
  })

  it('marks nothing for a non-terminal tab', () => {
    const actions = buildMobileSessionRuntimeActions(agents, terminal, { kind: 'none' })
    expect(actions.every((action) => action.hint === undefined)).toBe(true)
  })

  it('keeps an existing hint beside the mark', () => {
    const actions = buildMobileSessionRuntimeActions(
      [{ ...agentAction('Claude', 'claude'), hint: 'New agent session' }],
      terminal,
      { kind: 'agent', agentId: 'claude' }
    )
    expect(actions[0].hint).toBe('New agent session · Active tab')
  })

  it('passes loading, empty and error rows through unmarked', () => {
    const detecting = { ...agentAction('Detecting Agents'), disabled: true, loading: true }
    const actions = buildMobileSessionRuntimeActions([detecting], terminal, {
      kind: 'agent',
      agentId: 'claude'
    })
    expect(actions[0]).toBe(detecting)
    expect(hints(actions)).toEqual([
      ['Detecting Agents', null],
      ['Terminal', null]
    ])
  })

  it('calls the same handler the row came with', () => {
    const actions = buildMobileSessionRuntimeActions(agents, terminal, {
      kind: 'agent',
      agentId: 'claude'
    })
    actions[0].onPress()
    actions[2].onPress()
    expect(agents[0].onPress).toHaveBeenCalledOnce()
    expect(terminal.onPress).toHaveBeenCalledOnce()
  })
})
