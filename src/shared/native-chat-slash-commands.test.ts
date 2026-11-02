import { describe, expect, it } from 'vitest'
import {
  applySlashSuggestion,
  filterSlashCommands,
  getAgentSlashCommands,
  isSlashCommandDraft,
  opensAgentTuiPicker,
  slashCommandDispatchText
} from './native-chat-slash-commands'

describe('opensAgentTuiPicker', () => {
  it('flags a bare Claude /resume, which answers with a picker drawn in the terminal', () => {
    expect(opensAgentTuiPicker('claude', '/resume')).toBe(true)
    expect(opensAgentTuiPicker('claude', '  /resume  ')).toBe(true)
    expect(opensAgentTuiPicker('openclaude', '/resume')).toBe(true)
    expect(opensAgentTuiPicker('codex', '/resume')).toBe(true)
  })

  it('control: arguments, prose and non-picker commands stay in native chat', () => {
    expect(opensAgentTuiPicker('claude', '/resume 3f2a')).toBe(false)
    expect(opensAgentTuiPicker('claude', '/resumes')).toBe(false)
    expect(opensAgentTuiPicker('claude', 'please /resume')).toBe(false)
    expect(opensAgentTuiPicker('claude', '/compact')).toBe(false)
    expect(opensAgentTuiPicker('gemini', '/resume')).toBe(false)
  })

  it('lists every Claude picker command in the Claude autocomplete catalog', () => {
    const names = getAgentSlashCommands('claude').map((c) => c.name)
    for (const name of ['resume', 'agents', 'mcp', 'config', 'permissions', 'hooks']) {
      expect(opensAgentTuiPicker('claude', `/${name}`)).toBe(true)
      expect(names).toContain(name)
    }
  })
})

describe('getAgentSlashCommands', () => {
  it('returns Codex-specific commands (e.g. /model, /resume) for codex', () => {
    const names = getAgentSlashCommands('codex').map((c) => c.name)
    expect(names).toContain('model')
    expect(names).toContain('resume')
    expect(names).toContain('diff')
  })

  it('returns Claude commands for claude (no Codex-only /model)', () => {
    const names = getAgentSlashCommands('claude').map((c) => c.name)
    expect(names).toContain('clear')
    expect(names).toContain('compact')
    expect(names).not.toContain('model')
  })

  it('falls back to a small common set for an unknown agent (never empty)', () => {
    const names = getAgentSlashCommands('some-other-agent').map((c) => c.name)
    expect(names).toEqual(['clear', 'help'])
  })
})

describe('isSlashCommandDraft', () => {
  it('is true for a leading slash, even with leading whitespace', () => {
    expect(isSlashCommandDraft('/clear')).toBe(true)
    expect(isSlashCommandDraft('  /model')).toBe(true)
  })

  it('is false for ordinary prose or a mid-line slash', () => {
    expect(isSlashCommandDraft('fix the bug')).toBe(false)
    expect(isSlashCommandDraft('run a/b test')).toBe(false)
    expect(isSlashCommandDraft('')).toBe(false)
  })
})

describe('filterSlashCommands', () => {
  const codex = getAgentSlashCommands('codex')

  it('returns all commands for an empty query (bare /)', () => {
    expect(filterSlashCommands(codex, '')).toHaveLength(codex.length)
  })

  it('prefix-matches case-insensitively', () => {
    const names = filterSlashCommands(codex, 'mod').map((c) => c.name)
    expect(names).toEqual(['model'])
    expect(filterSlashCommands(codex, 'MOD').map((c) => c.name)).toEqual(['model'])
  })
})

describe('dispatch vs completion text', () => {
  it('dispatch text has no trailing space (Enter dispatches the command)', () => {
    expect(slashCommandDispatchText({ name: 'clear' })).toBe('/clear')
  })

  it('completion text has a trailing space (Tab completes for arguments)', () => {
    expect(applySlashSuggestion({ name: 'model' })).toBe('/model ')
  })
})
