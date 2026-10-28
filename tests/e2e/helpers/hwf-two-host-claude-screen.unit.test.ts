import { describe, expect, it } from 'vitest'

import { classifyClaudeScreen, cleanInkScreen, makeLetterNonce } from './hwf-two-host-claude-screen'

const idle = { asked: false, answer: 'qzabcdefghij' }

describe('classifyClaudeScreen', () => {
  it('reports the Bypass consent dialog even when the trust text is on screen too', () => {
    const screen =
      'WARNING: Claude Code running in Bypass Permissions mode 1. No, exit 2. Yes, I accept ' +
      'Do you trust this folder?'
    expect(classifyClaudeScreen(screen, idle)).toBe('bypass-consent-asked')
  })

  it('keeps reporting Bypass after the prompt was sent', () => {
    expect(classifyClaudeScreen('Bypass Permissions mode', { ...idle, asked: true })).toBe(
      'bypass-consent-asked'
    )
  })

  it('does not call the answer present before the prompt was sent', () => {
    expect(classifyClaudeScreen('? for shortcuts qzabcdefghij', idle)).toBe('ready')
  })

  it('answers only when the prompt was sent and the lowercase answer is on screen', () => {
    const screen = 'Reply with these letters: QZABCDEFGHIJ qzabcdefghij'
    expect(classifyClaudeScreen(screen, { ...idle, asked: true })).toBe('answered')
  })

  it('does not take the uppercase echo of the prompt for the answer', () => {
    expect(classifyClaudeScreen('QZABCDEFGHIJ', { ...idle, asked: true })).toBe('waiting')
  })

  it('names the login and usage-limit blockers', () => {
    expect(classifyClaudeScreen('Please run /login', idle)).toBe('login-needed')
    expect(classifyClaudeScreen('Claude usage limit reached. Resets 3pm', idle)).toBe('usage-limit')
  })

  it('reports the trust dialog and the ready prompt', () => {
    expect(classifyClaudeScreen('Do you trust the files in this folder?', idle)).toBe('trust')
    expect(classifyClaudeScreen('? for shortcuts', idle)).toBe('ready')
    expect(classifyClaudeScreen('', idle)).toBe('waiting')
  })
})

describe('cleanInkScreen', () => {
  it('turns cursor-forward moves into spaces so words stay apart', () => {
    expect(cleanInkScreen('Do\u001b[1Cyou\u001b[2Ctrust')).toBe('Do you trust')
  })
})

describe('makeLetterNonce', () => {
  it('is letters only and its answer is a string the prompt never holds', () => {
    const { word, answer, prompt } = makeLetterNonce()
    expect(word).toMatch(/^QZ[A-Z]{10}$/)
    expect(answer).toBe(word.toLowerCase())
    expect(prompt).toContain(word)
    expect(prompt).not.toContain(answer)
    expect(prompt).not.toMatch(/\d/)
  })
})
