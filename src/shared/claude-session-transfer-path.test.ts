import { describe, expect, it } from 'vitest'
import {
  claudeProjectDirName,
  claudeTranscriptHomeRelativeDir,
  isTransferableClaudeSessionId
} from './claude-session-transfer-path'

describe('claudeProjectDirName', () => {
  it('replaces every non-alphanumeric character with a dash, as Claude does', () => {
    // Observed on GEX44: /tmp/orca-hwf-p70-xferA -> -tmp-orca-hwf-p70-xferA
    expect(claudeProjectDirName('/tmp/orca-hwf-p70-xferA')).toBe('-tmp-orca-hwf-p70-xferA')
    expect(claudeProjectDirName('/home/a.b/my_repo')).toBe('-home-a-b-my-repo')
  })

  it('refuses a cwd it cannot reproduce', () => {
    expect(claudeProjectDirName('C:/work/orca')).toBeNull()
    expect(claudeProjectDirName('relative/path')).toBeNull()
    expect(claudeProjectDirName(`/${'x'.repeat(250)}`)).toBeNull()
  })

  it('can only produce a single path segment', () => {
    expect(claudeProjectDirName('/a/../../etc')).toMatch(/^[A-Za-z0-9-]+$/)
    expect(claudeTranscriptHomeRelativeDir('/srv/orca')).toBe('~/.claude/projects/-srv-orca')
  })
})

describe('isTransferableClaudeSessionId', () => {
  it('accepts Claude session ids and refuses anything that could name another path', () => {
    expect(isTransferableClaudeSessionId('02453e1c-1955-496f-bf15-06721e1bc46b')).toBe(true)
    for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', '-x', 'a b', 'x'.repeat(129)]) {
      expect(isTransferableClaudeSessionId(bad)).toBe(false)
    }
  })
})
