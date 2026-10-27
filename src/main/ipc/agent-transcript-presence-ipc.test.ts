import { describe, expect, it, vi } from 'vitest'
import { handleAgentTranscriptPresenceRequest } from './agent-transcript-presence-ipc'
import type { AgentTranscriptPresenceDeps } from '../native-chat/agent-transcript-presence'

/**
 * The probe two transitions ask on their way into releasing a live pane.
 *
 * Everything here is about the difference between `absent` and `unknown`. `absent` is a promise
 * being withdrawn on evidence; `unknown` is a promise being withheld for lack of it. A probe that
 * reported `absent` whenever it simply could not look would delete a resume offer the user can
 * still use, and one that reported `present` on a miss would promise a conversation that is gone.
 */

const ENOENT = Object.assign(new Error('no such file'), { code: 'ENOENT' })

function deps(overrides: Partial<AgentTranscriptPresenceDeps> = {}): AgentTranscriptPresenceDeps {
  return {
    statPath: vi.fn(async () => ({ isFile: () => true })),
    hostReadableTranscript: vi.fn(async () => null),
    findTranscript: vi.fn(async () => null),
    platform: 'linux',
    ...overrides
  }
}

const SUBJECT = { agent: 'claude', sessionId: 'abc-123' }

describe('handleAgentTranscriptPresenceRequest', () => {
  it('reads a recorded native path that stats as a file as present', async () => {
    const result = await handleAgentTranscriptPresenceRequest(
      { ...SUBJECT, transcriptPath: '/home/u/.claude/projects/p/abc-123.jsonl' },
      deps()
    )
    expect(result).toBe('present')
  })

  it('proves absence only from the filesystem saying so', async () => {
    const result = await handleAgentTranscriptPresenceRequest(
      { ...SUBJECT, transcriptPath: '/home/u/.claude/projects/p/abc-123.jsonl' },
      deps({
        statPath: vi.fn(async () => {
          throw ENOENT
        })
      })
    )
    expect(result).toBe('absent')
  })

  it('never proves absence for a WSL guest path on Windows, where "not found" also means "distro stopped"', async () => {
    const hostReadableTranscript = vi.fn(async () => null)
    const result = await handleAgentTranscriptPresenceRequest(
      { ...SUBJECT, transcriptPath: '/home/u/.claude/projects/p/abc-123.jsonl' },
      deps({ platform: 'win32', hostReadableTranscript })
    )
    expect(result).toBe('unknown')
    // The control: it took the host-readable route rather than statting a guest path directly.
    expect(hostReadableTranscript).toHaveBeenCalledOnce()
  })

  it('treats a search that found nothing as unknown, because a session may live under another account', async () => {
    const result = await handleAgentTranscriptPresenceRequest(SUBJECT, deps())
    expect(result).toBe('unknown')
  })

  it('finds a session with no recorded path by searching for it', async () => {
    const result = await handleAgentTranscriptPresenceRequest(
      SUBJECT,
      deps({ findTranscript: vi.fn(async () => '/home/u/.claude/projects/p/abc-123.jsonl') })
    )
    expect(result).toBe('present')
  })

  it.each([
    ['not an object', 'nonsense'],
    ['no session id', { agent: 'claude' }],
    ['an empty agent', { agent: '', sessionId: 'abc-123' }],
    ['a transcript path that is not a string', { ...SUBJECT, transcriptPath: 42 }]
  ])('answers unknown for %s rather than treating it as a deletion', async (_name, request) => {
    expect(await handleAgentTranscriptPresenceRequest(request, deps())).toBe('unknown')
  })

  it('answers unknown when the probe stalls, so a workspace can still go to sleep', async () => {
    const result = await handleAgentTranscriptPresenceRequest(
      SUBJECT,
      deps({ findTranscript: vi.fn(() => new Promise<string | null>(() => {})) }),
      5
    )
    expect(result).toBe('unknown')
  })

  it('answers unknown when the probe throws', async () => {
    const result = await handleAgentTranscriptPresenceRequest(
      SUBJECT,
      deps({
        findTranscript: vi.fn(async () => {
          throw new Error('mount is gone')
        })
      })
    )
    expect(result).toBe('unknown')
  })
})
