import { describe, expect, it } from 'vitest'
import {
  agentReplyFor,
  buildAgentPrompt,
  classifyAgentReply,
  expectedAgentAnswer
} from './dws-offload-workload.mjs'
import {
  applyLegOutcomes,
  failedLegsFromManifest,
  judgeLegMarker,
  observationDefects,
  summarizeRun
} from './dws-offload-measurement.mjs'

const NONCE = '0123456789abcdef'
// observed verbatim from the claude CLI as orca-svc on GEX44, 2026-09-29
const LOGIN_LINE = 'Not logged in · Please run /login'

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

describe('agent reply outcomes (02-07)', () => {
  const ANSI_LOGIN = `\u001b[31m${LOGIN_LINE}\u001b[0m\n`

  it('names the observed login line as not-logged-in, with or without ANSI codes', () => {
    expect(classifyAgentReply(LOGIN_LINE, NONCE)).toBe('not-logged-in')
    expect(classifyAgentReply(ANSI_LOGIN, NONCE)).toBe('not-logged-in')
  })

  it('lets the answer marker win over a login line', () => {
    expect(classifyAgentReply(`${LOGIN_LINE}\n${expectedAgentAnswer(NONCE)}`, NONCE)).toBe('matched')
  })

  it('is not a bare substring match on "logged"', () => {
    expect(classifyAgentReply('logged 3 warnings, see /var/log/app', NONCE)).toBe('missing')
  })

  it('keeps usage-limit distinct from the login line', () => {
    expect(classifyAgentReply('Claude usage limit reached. Try again later.', NONCE)).toBe('usage-limit')
    expect(classifyAgentReply(LOGIN_LINE, NONCE)).not.toBe('usage-limit')
  })

  it('reports a child that could not start as spawn-failed, else delegates to the classifier', () => {
    const spawnError = new Error('spawn claude ENOENT')
    expect(agentReplyFor({ captured: '', nonce: NONCE, spawnError })).toBe('spawn-failed')
    expect(agentReplyFor({ captured: LOGIN_LINE, nonce: NONCE, spawnError: null })).toBe('not-logged-in')
  })

  it('emits only whitespace-free tokens (the spec LEG_END_RE contract)', () => {
    const tokens = [
      classifyAgentReply(expectedAgentAnswer(NONCE), NONCE),
      classifyAgentReply(LOGIN_LINE, NONCE),
      classifyAgentReply('usage limit', NONCE),
      classifyAgentReply('x', NONCE),
      agentReplyFor({ captured: '', nonce: NONCE, spawnError: new Error('x') })
    ]
    expect(tokens).toEqual(['matched', 'not-logged-in', 'usage-limit', 'missing', 'spawn-failed'])
    for (const token of tokens) {
      expect(token).toMatch(/^\S+$/)
    }
  })

  it('carries the login cause from the classifier through every leg verdict', () => {
    const agentReply = classifyAgentReply(LOGIN_LINE, NONCE)
    const marker = { leg: 'agent', exit: '1', agentReply }
    expect(judgeLegMarker(marker).reason).toBe('exit=1 agentReply=not-logged-in')
    const failedLegs = failedLegsFromManifest({ legs: [marker] })
    expect(observationDefects(summarizeRun([], { failedLegs })).join(' ')).toContain(
      'agent exit=1 agentReply=not-logged-in'
    )
    const [proof] = applyLegOutcomes([{ leg: 'agent', verdict: 'PASS' }], [marker])
    expect(proof.verdict).toBe('FAIL')
    expect(proof.reason).toContain('agentReply=not-logged-in')
  })
})
