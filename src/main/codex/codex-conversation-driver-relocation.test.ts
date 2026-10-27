// A resumed thread runs a turn only where the provider itself says it is. Every double here answers
// the way a real peer version was measured or can be expected to: echoing `cwd` (0.153.4/0.155.1),
// ignoring it, omitting it, or rejecting it as an unknown field.

import { describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'

import { TurnInterruptedError } from '../conversation/turn-interruption'

import { createCodexConversationDriver } from './codex-conversation-driver'
import {
  CodexAppServerTimeoutError,
  type runCodexAppServerSession
} from './codex-app-server-session'

type Call = { method: string; params: Record<string, unknown> }
type ResumeAnswer = (params: Record<string, unknown>) => unknown

/** The `initialize` answer of a measured peer; `null` is one whose version cannot be read. */
const MEASURED = { userAgent: 'orca_desktop/0.155.1 (Ubuntu 24.4.0; x86_64) unknown' }

function run(
  resumeAnswer: ResumeAnswer,
  request: { resumeCwd: string | null; cwd: string },
  initializeResult: unknown = MEASURED
): Promise<{ calls: Call[]; events: AgentTurnEvent[]; providerSessionId: string | null }> {
  const calls: Call[] = []
  const events: AgentTurnEvent[] = []
  const runSession = (async (
    _invocation: unknown,
    body: (rpc: {
      request: (method: string, params: Record<string, unknown>) => Promise<unknown>
      initializeResult: unknown
    }) => Promise<unknown>,
    _spawn: unknown,
    handlers?: { onNotification?: (notification: { method: string; params: unknown }) => void }
  ) =>
    body({
      initializeResult,
      request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'thread/resume') {
          return resumeAnswer(params)
        }
        if (method === 'thread/start') {
          return { thread: { id: 'thread-new', cwd: params.cwd } }
        }
        handlers?.onNotification?.({ method: 'turn/completed', params: { turn: { id: 't' } } })
        return {}
      }
    })) as unknown as typeof runCodexAppServerSession

  return createCodexConversationDriver({ runSession })
    .runTurn({
      resumeSessionId: 'thread-old',
      resumeCwd: request.resumeCwd,
      cwd: request.cwd,
      text: 'hi',
      developerInstructions: null,
      turnId: 'turn-1',
      onEvent: (event) => events.push(event)
    })
    .then((result) => ({ calls, events, providerSessionId: result.providerSessionId }))
}

const echoing: ResumeAnswer = (params) => ({
  thread: { id: 'thread-old', cwd: params.cwd ?? '/repos/a' }
})
const methods = (calls: Call[]) => calls.map((call) => call.method)
const unconfirmed = (events: AgentTurnEvent[]) =>
  events.some(
    (event) => event.kind === 'provider-status' && event.status === 'thread-relocation-unconfirmed'
  )

describe('codex resume — the thread runs where the provider says it is', () => {
  it('resumes an unmoved thread exactly as before: no cwd sent', async () => {
    const { calls, providerSessionId } = await run(echoing, {
      resumeCwd: '/repos/a',
      cwd: '/repos/a'
    })
    expect(calls[0].params).toEqual({ threadId: 'thread-old' })
    expect(methods(calls)).toEqual(['thread/resume', 'turn/start'])
    expect(providerSessionId).toBe('thread-old')
  })

  it('keeps continuity with a provider that does not report a directory, when nothing moved', async () => {
    const { calls } = await run(() => ({ thread: { id: 'thread-old' } }), {
      resumeCwd: '/repos/a',
      cwd: '/repos/a'
    })
    expect(methods(calls)).toEqual(['thread/resume', 'turn/start'])
  })

  it('relocates a moved thread when the provider confirms the new directory', async () => {
    const { calls, events, providerSessionId } = await run(echoing, {
      resumeCwd: '/repos/a',
      cwd: '/repos/b'
    })
    expect(calls[0].params).toEqual({ threadId: 'thread-old', cwd: '/repos/b' })
    expect(methods(calls)).toEqual(['thread/resume', 'turn/start'])
    expect(providerSessionId).toBe('thread-old')
    expect(unconfirmed(events)).toBe(false)
  })

  it('starts a new thread in the new directory when the provider keeps the old one', async () => {
    const ignoring: ResumeAnswer = () => ({ thread: { id: 'thread-old', cwd: '/repos/a' } })
    const { calls, events, providerSessionId } = await run(ignoring, {
      resumeCwd: '/repos/a',
      cwd: '/repos/b'
    })
    expect(methods(calls)).toEqual(['thread/resume', 'thread/start', 'turn/start'])
    expect(calls[1].params.cwd).toBe('/repos/b')
    expect(providerSessionId).toBe('thread-new')
    expect(unconfirmed(events)).toBe(true)
  })

  it('never runs a moved thread on a provider that cannot say where it is', async () => {
    const { calls, events } = await run(() => ({ thread: { id: 'thread-old' } }), {
      resumeCwd: '/repos/a',
      cwd: '/repos/b'
    })
    expect(methods(calls)).toEqual(['thread/resume', 'thread/start', 'turn/start'])
    expect(unconfirmed(events)).toBe(true)
  })

  it('treats an unrecorded directory as unknown, not as unmoved', async () => {
    const ignoring: ResumeAnswer = () => ({ thread: { id: 'thread-old', cwd: '/repos/a' } })
    const { calls } = await run(ignoring, { resumeCwd: null, cwd: '/repos/b' })
    expect(calls[0].params).toEqual({ threadId: 'thread-old', cwd: '/repos/b' })
    expect(methods(calls)).toContain('thread/start')
  })

  it('falls back to a new thread when an older provider rejects the field', async () => {
    const { calls, events } = await run(
      () => {
        throw new Error('Invalid params: unknown field `cwd`')
      },
      { resumeCwd: '/repos/a', cwd: '/repos/b' }
    )
    expect(methods(calls)).toEqual(['thread/resume', 'thread/start', 'turn/start'])
    expect(
      events.some(
        (event) => event.kind === 'provider-status' && event.status === 'thread-resume-failed'
      )
    ).toBe(true)
  })

  it('does not call a different spelling of the same directory a move', async () => {
    const windows: ResumeAnswer = () => ({ thread: { id: 'thread-old', cwd: 'C:\\Repos\\A' } })
    const { calls } = await run(windows, { resumeCwd: 'C:\\Repos\\A\\', cwd: 'c:/repos/a' })
    expect(calls[0].params).toEqual({ threadId: 'thread-old' })
    expect(methods(calls)).toEqual(['thread/resume', 'turn/start'])
  })
})

describe('codex turn — a lapsed deadline is its own state', () => {
  it('names a session timeout as a timed-out turn, not a provider failure', async () => {
    const runSession = (async () => {
      throw new CodexAppServerTimeoutError('codex app-server session exceeded 300000ms (codex)')
    }) as unknown as typeof runCodexAppServerSession
    const outcome = await createCodexConversationDriver({ runSession, timeoutMs: 300_000 })
      .runTurn({
        resumeSessionId: null,
        cwd: '/repos/a',
        text: 'hi',
        developerInstructions: null,
        turnId: 'turn-1',
        onEvent: () => {}
      })
      .then(
        () => 'returned',
        (error: unknown) => error
      )
    expect(outcome).toBeInstanceOf(TurnInterruptedError)
    expect(outcome).toMatchObject({
      cause: 'timed-out',
      message: 'the provider did not finish the turn within 300 s'
    })
  })
})

describe('codex resume — a peer not measured to relocate is never asked to', () => {
  const OLDER = { userAgent: 'orca_desktop/0.153.3 (Ubuntu 24.4.0; x86_64) unknown' }

  for (const [label, initializeResult] of [
    ['an older version', OLDER],
    ['an unreadable version', { userAgent: 'something else' }],
    ['no initialize answer', undefined]
  ] as const) {
    it(`starts a new thread for a moved project on ${label}, sending no cwd to resume`, async () => {
      const { calls, events, providerSessionId } = await run(
        echoing,
        { resumeCwd: '/repos/a', cwd: '/repos/b' },
        initializeResult ?? null
      )
      expect(methods(calls)).toEqual(['thread/start', 'turn/start'])
      expect(calls[0].params.cwd).toBe('/repos/b')
      expect(providerSessionId).toBe('thread-new')
      expect(
        events.some(
          (event) =>
            event.kind === 'provider-status' && event.status === 'thread-relocation-unsupported'
        )
      ).toBe(true)
    })
  }

  it('still resumes an unmoved thread on such a peer, exactly as before', async () => {
    const { calls } = await run(echoing, { resumeCwd: '/repos/a', cwd: '/repos/a' }, OLDER)
    expect(calls[0].params).toEqual({ threadId: 'thread-old' })
    expect(methods(calls)).toEqual(['thread/resume', 'turn/start'])
  })
})
