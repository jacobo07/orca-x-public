import { describe, expect, it } from 'vitest'
import { buildAgentPrompt, classifyAgentReply, expectedAgentAnswer } from './dws-offload-workload.mjs'

const NONCE = '0123456789abcdef'

describe('agent reply marker (WR-13)', () => {
  it('derives an expected answer that never appears verbatim in the prompt', () => {
    const prompt = buildAgentPrompt(NONCE)
    expect(prompt).toContain(NONCE)
    expect(prompt).not.toContain(expectedAgentAnswer(NONCE))
    expect(expectedAgentAnswer(NONCE)).toBe('DWS-P2-AGENT-OK-fedcba9876543210')
  })

  it('is matched when the CLI actually answers', () => {
    expect(classifyAgentReply(`${expectedAgentAnswer(NONCE)}\n`, NONCE)).toBe('matched')
  })

  it('is NOT matched when the CLI only echoes the prompt back (header / verbose / usage-error quoting)', () => {
    const echoed = `> ${buildAgentPrompt(NONCE)}\nerror: unexpected argument\nUsage: claude -p <prompt>`
    expect(classifyAgentReply(echoed, NONCE)).toBe('missing')
  })

  it('is NOT matched by the old forward marker, which the prompt used to contain verbatim', () => {
    expect(classifyAgentReply(`DWS-P2-AGENT-OK-${NONCE}`, NONCE)).toBe('missing')
  })

  it('holds even for a palindromic nonce (the answer is still not a substring of the prompt)', () => {
    expect(buildAgentPrompt('abccba')).not.toContain(expectedAgentAnswer('abccba'))
    expect(classifyAgentReply(buildAgentPrompt('abccba'), 'abccba')).toBe('missing')
  })
})

describe('agent reply classification', () => {
  it('is usage-limit for a limit message, even with exit 0 elsewhere', () => {
    expect(classifyAgentReply('Claude usage limit reached. Try again later.', NONCE)).toBe('usage-limit')
  })

  it('is missing for an unrelated failure', () => {
    expect(classifyAgentReply('some other failure', NONCE)).toBe('missing')
  })
})
