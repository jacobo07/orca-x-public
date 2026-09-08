import { describe, expect, it } from 'vitest'
import {
  buildTabAgentLaunchOptions,
  findMatchingTabAgentLaunchOptions,
  orderTabLaunchAgents
} from './tab-agent-launch-options'
import { agentProfileId, buildTerminalLaunchProfiles } from '@/lib/terminal-launch-profiles'

describe('tab agent launch options', () => {
  it('orders detected agents by the configured default first', () => {
    expect(orderTabLaunchAgents('codex', ['claude', 'codex', 'gemini'])).toEqual([
      'codex',
      'claude',
      'gemini'
    ])
  })

  it('excludes disabled agents from the launch list', () => {
    expect(orderTabLaunchAgents(null, ['claude', 'codex', 'openclaude'], ['openclaude'])).toEqual([
      'claude',
      'codex'
    ])
  })

  it('drops a disabled default agent instead of surfacing it first', () => {
    const ordered = orderTabLaunchAgents(
      'openclaude',
      ['claude', 'codex', 'openclaude'],
      ['openclaude']
    )
    expect(ordered).not.toContain('openclaude')
    expect(ordered).toEqual(['claude', 'codex'])
  })

  it('keeps a disabled agent out of new-tab search results', () => {
    const options = buildTabAgentLaunchOptions(
      orderTabLaunchAgents('codex', ['claude', 'codex', 'openclaude'], ['openclaude'])
    )
    expect(findMatchingTabAgentLaunchOptions('open', options).map((o) => o.agent)).toEqual([])
  })

  it('matches detected agents by id, label, command, and command override', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'antigravity'], {
      codex: 'codex-beta'
    })

    expect(
      findMatchingTabAgentLaunchOptions('Claude', options).map((option) => option.agent)
    ).toEqual(['claude'])
    expect(findMatchingTabAgentLaunchOptions('openai codex', options)).toEqual([])
    expect(
      findMatchingTabAgentLaunchOptions('codex-beta', options).map((option) => option.agent)
    ).toEqual(['codex'])
    expect(findMatchingTabAgentLaunchOptions('agy', options).map((option) => option.agent)).toEqual(
      ['antigravity']
    )
  })

  it('matches agents on a partial prefix so the launcher actually searches', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'gemini', 'antigravity'])

    // Each is one character short of the full agent name.
    expect(findMatchingTabAgentLaunchOptions('gemin', options).map((o) => o.agent)).toEqual([
      'gemini'
    ])
    expect(findMatchingTabAgentLaunchOptions('clau', options).map((o) => o.agent)).toEqual([
      'claude'
    ])
    expect(findMatchingTabAgentLaunchOptions('anti', options).map((o) => o.agent)).toEqual([
      'antigravity'
    ])
  })

  it('ranks an exact alias above weaker prefix matches', () => {
    const options = buildTabAgentLaunchOptions(['codex', 'copilot', 'codebuff'])

    // "co" prefixes all three; "codex" exactly matches one and must lead.
    expect(findMatchingTabAgentLaunchOptions('codex', options)[0]?.agent).toBe('codex')
    expect(findMatchingTabAgentLaunchOptions('co', options).map((o) => o.agent)).toEqual(
      expect.arrayContaining(['codex', 'copilot', 'codebuff'])
    )
  })

  it('does not match on a mid-string substring that would hijack file results', () => {
    const options = buildTabAgentLaunchOptions(['opencode', 'claude'])

    // "ode" is inside "opencode" but not a prefix — agents rank above files, so
    // a noisy mid-string hit must not surface.
    expect(findMatchingTabAgentLaunchOptions('ode', options)).toEqual([])
  })

  it('requires at least two characters before a prefix matches (no single-key flood)', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'copilot', 'cursor'])

    // A lone "c" must not surface (and auto-launch) an agent.
    expect(findMatchingTabAgentLaunchOptions('c', options)).toEqual([])
    // Two characters is enough to start searching.
    expect(findMatchingTabAgentLaunchOptions('co', options).map((o) => o.agent)).toEqual(
      expect.arrayContaining(['codex', 'copilot'])
    )
  })

  // Why these live together: they are the two halves of one contract. The product identity the user
  // picks is ChatGPT; the identity everything else persists, resolves and recognises is `codex`. A
  // rename that let the label reach an id, or an id that leaked into the label, would break one half
  // while leaving the other green.
  describe('ChatGPT display identity over the Codex runtime identity', () => {
    it('offers OpenAI Codex to the user as ChatGPT', () => {
      const [option] = buildTabAgentLaunchOptions(['codex'])

      expect(option?.label).toBe('ChatGPT')
    })

    it('keeps the launch profile id on the runtime identity, not the brand', () => {
      // The persisted id outlives renames and localization: a tab restored tomorrow must resolve to
      // the same agent even if the row is relabelled again.
      expect(agentProfileId('codex')).toBe('agent:codex')

      const { profiles } = buildTerminalLaunchProfiles({
        shellEntries: [{ label: 'PowerShell', shell: 'powershell.exe' }],
        agentOptions: buildTabAgentLaunchOptions(['codex']),
        defaultAgent: null,
        hostDefaultShellLabel: 'Terminal'
      })
      const codex = profiles.find((profile) => profile.id === 'agent:codex')

      expect(codex).toMatchObject({ kind: 'agent', agent: 'codex', label: 'ChatGPT' })
    })

    it('finds it under the brand and under the runtime name', () => {
      // Users arrive from both directions — "chatgpt" is the product they know, "codex" is the
      // binary on their PATH and the name every existing doc and muscle memory uses.
      const options = buildTabAgentLaunchOptions(['codex'])

      expect(findMatchingTabAgentLaunchOptions('chatgpt', options).map((o) => o.agent)).toEqual([
        'codex'
      ])
      expect(findMatchingTabAgentLaunchOptions('codex', options).map((o) => o.agent)).toEqual([
        'codex'
      ])
    })
  })
})
