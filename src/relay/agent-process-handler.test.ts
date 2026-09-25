import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MethodHandler, RequestContext } from './dispatcher'
import { AgentProcessHandler, type AgentProcessHandlerDeps } from './agent-process-handler'

type FakeChild = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: string | null
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
}

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough()
  })
}

type Bulk = { method: string; params: Record<string, unknown>; clientId?: number }

function harness(overrides: Partial<AgentProcessHandlerDeps> = {}) {
  const handlers = new Map<string, MethodHandler>()
  const bulk: Bulk[] = []
  let gate: Promise<void> = Promise.resolve()
  const dispatcher = {
    onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler),
    notifyBulk: (method: string, params: Record<string, unknown>, opts?: { clientId?: number }) => {
      bulk.push({ method, params, clientId: opts?.clientId })
      return gate
    }
  }
  const child = fakeChild()
  const spawn = vi.fn(() => child)
  const killGroup = vi.fn()
  const deps: Partial<AgentProcessHandlerDeps> = {
    spawn: spawn as never,
    resolveCommand: async () => '/opt/codex/bin/codex',
    isDirectory: async (path) => (path === '/srv/ledger' ? '/srv/ledger' : null),
    killGroup,
    platform: 'linux',
    ...overrides
  }
  const handler = new AgentProcessHandler(dispatcher as never, deps)
  return {
    handler,
    handlers,
    bulk,
    child,
    spawn,
    killGroup,
    holdBulk: () => {
      let release = (): void => {}
      gate = new Promise((resolve) => (release = resolve))
      return () => {
        gate = Promise.resolve()
        release()
      }
    }
  }
}

function context(clientId = 1, signal?: AbortSignal): RequestContext {
  return { clientId, isStale: () => false, signal }
}

const RUN = {
  streamId: 's1',
  command: 'codex',
  args: ['app-server'],
  cwd: '/srv/ledger',
  envOverlay: { CODEX_HOME: '/home/orca/.codex-isolated' },
  deadlineMs: 60_000
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('agentProcess.run refusals', () => {
  it('refuses anything but a provider invocation, spawning nothing', async () => {
    const h = harness()
    const run = h.handlers.get('agentProcess.run')!
    await expect(run({ ...RUN, command: 'bash', args: ['-c', 'id'] }, context())).resolves.toEqual({
      outcome: 'refused',
      reason: 'command-not-allowed'
    })
    await expect(run({ ...RUN, args: ['exec', 'rm'] }, context())).resolves.toEqual({
      outcome: 'refused',
      reason: 'command-not-allowed'
    })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('refuses a project directory that is not there, as its own answer', async () => {
    const h = harness()
    await expect(
      h.handlers.get('agentProcess.run')!({ ...RUN, cwd: '/srv/gone' }, context())
    ).resolves.toEqual({ outcome: 'refused', reason: 'cwd-missing' })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('refuses an env overlay beyond CODEX_HOME — NODE_OPTIONS would run code under an allowed name', async () => {
    const h = harness()
    await expect(
      h.handlers.get('agentProcess.run')!(
        { ...RUN, envOverlay: { NODE_OPTIONS: '--require /tmp/evil.js' } },
        context()
      )
    ).resolves.toEqual({ outcome: 'refused', reason: 'env-not-allowed' })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('refuses a Windows host explicitly rather than spawning a shim it cannot handle', async () => {
    const h = harness({ platform: 'win32' })
    await expect(h.handlers.get('agentProcess.run')!(RUN, context())).resolves.toEqual({
      outcome: 'refused',
      reason: 'platform-unsupported'
    })
  })

  it('refuses when the provider is not installed for this login', async () => {
    const h = harness({ resolveCommand: async () => null })
    await expect(h.handlers.get('agentProcess.run')!(RUN, context())).resolves.toEqual({
      outcome: 'refused',
      reason: 'command-not-found'
    })
  })
})

describe('agentProcess.run streaming', () => {
  it('spawns the resolved path in the project directory, in its own process group, with the overlay', async () => {
    const h = harness()
    void h.handlers.get('agentProcess.run')!(RUN, context())
    await flush()
    const [file, args, options] = h.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; detached: boolean; env: Record<string, string> }
    ]
    expect(file).toBe('/opt/codex/bin/codex')
    expect(args).toEqual(['app-server'])
    expect(options.cwd).toBe('/srv/ledger')
    expect(options.detached).toBe(true)
    expect(options.env.CODEX_HOME).toBe('/home/orca/.codex-isolated')
    // The shim's own directory first: an npm install's `env node` lives beside it.
    expect(options.env.PATH.split(':')[0]).toBe('/opt/codex/bin')
  })

  it('slices a large chunk into frames that stay under a client frame capacity', async () => {
    const h = harness()
    void h.handlers.get('agentProcess.run')!(RUN, context())
    await flush()
    h.child.stdout.write(Buffer.alloc(20 * 1024, 0x61))
    await flush()
    await flush()
    const frames = h.bulk.filter((frame) => frame.method === 'agentProcess.stdout')
    expect(frames.map((frame) => frame.params.seq)).toEqual([1, 2, 3])
    const bytes = frames.reduce(
      (total, frame) => total + Buffer.from(String(frame.params.data), 'base64').length,
      0
    )
    expect(bytes).toBe(20 * 1024)
  })

  it('streams output as sequenced frames to the asking client, and reports the final seq only after every frame was sent', async () => {
    const h = harness()
    const result = h.handlers.get('agentProcess.run')!(RUN, context(7))
    await flush()
    h.child.stdout.write('{"id":1}\n')
    await flush()
    h.child.stdout.write('{"id":2}\n')
    await flush()
    h.child.emit('close', 0, null)

    await expect(result).resolves.toMatchObject({
      outcome: 'exited',
      exitCode: 0,
      finalStdoutSeq: 2,
      reason: 'closed'
    })
    // `started` goes first on the same chain, so no output can overtake it.
    expect(h.bulk.map((frame) => [frame.method, frame.params.seq, frame.clientId])).toEqual([
      ['agentProcess.started', undefined, 7],
      ['agentProcess.stdout', 1, 7],
      ['agentProcess.stdout', 2, 7]
    ])
    expect(Buffer.from(String(h.bulk[1].params.data), 'base64').toString('utf8')).toBe('{"id":1}\n')
  })

  it('stops reading while a frame is still being sent — backpressure, not a queue', async () => {
    const h = harness()
    void h.handlers.get('agentProcess.run')!(RUN, context())
    await flush()
    const release = h.holdBulk()
    const stdoutFrames = () => h.bulk.filter((frame) => frame.method === 'agentProcess.stdout')
    h.child.stdout.write('first\n')
    await flush()
    h.child.stdout.write('second\n')
    await flush()
    expect(stdoutFrames()).toHaveLength(1)
    // The frame count alone holds without the pause (the send chain serializes); the unread bytes
    // left in the pipe are what bound the relay's memory against a fast child.
    expect(h.child.stdout.isPaused()).toBe(true)
    expect(h.child.stdout.readableLength).toBe('second\n'.length)

    release()
    await flush()
    await flush()
    expect(stdoutFrames()).toHaveLength(2)
    expect(h.child.stdout.readableLength).toBe(0)
  })

  it('writes and closes stdin only for the client that owns the stream', async () => {
    const h = harness()
    void h.handlers.get('agentProcess.run')!(RUN, context(1))
    await flush()
    const received: string[] = []
    h.child.stdin.on('data', (chunk: Buffer) => received.push(chunk.toString()))

    await expect(
      h.handlers.get('agentProcess.write')!({ streamId: 's1', data: 'hello\n' }, context(1))
    ).resolves.toEqual({ ok: true })
    await expect(
      h.handlers.get('agentProcess.write')!({ streamId: 's1', data: 'intrude\n' }, context(2))
    ).rejects.toThrow('AGENT_PROCESS_NOT_RUNNING')
    await flush()
    expect(received).toEqual(['hello\n'])
  })
})

describe('agentProcess.run lifetime', () => {
  it('kills the whole process group when the request is cancelled, then escalates', async () => {
    vi.useFakeTimers()
    const h = harness()
    const abort = new AbortController()
    void h.handlers.get('agentProcess.run')!(RUN, context(1, abort.signal))
    await vi.advanceTimersByTimeAsync(0)

    abort.abort()
    expect(h.killGroup).toHaveBeenCalledWith(h.child, 'SIGTERM')
    expect(h.killGroup).not.toHaveBeenCalledWith(h.child, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.killGroup).toHaveBeenCalledWith(h.child, 'SIGKILL')
  })

  it('kills a child that outlives its deadline', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.handlers.get('agentProcess.run')!({ ...RUN, deadlineMs: 5_000 }, context())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.killGroup).toHaveBeenCalledWith(h.child, 'SIGTERM')
    h.child.emit('close', null, 'SIGTERM')
    await expect(result).resolves.toMatchObject({ outcome: 'exited', reason: 'deadline' })
  })

  it('disposes by killing every running child and waiting for each to close', async () => {
    const h = harness()
    void h.handlers.get('agentProcess.run')!(RUN, context())
    await flush()
    const disposed = h.handler.dispose()
    expect(h.killGroup).toHaveBeenCalledWith(h.child, 'SIGTERM')
    let settled = false
    void disposed.then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)
    h.child.emit('close', null, 'SIGTERM')
    await disposed
    expect(settled).toBe(true)
  })

  it('does not spawn at all when the client left while the command was being resolved', async () => {
    let finishLookup: (path: string) => void = () => {}
    const h = harness({
      resolveCommand: () => new Promise((resolve) => (finishLookup = resolve))
    })
    const abort = new AbortController()
    const result = h.handlers.get('agentProcess.run')!(RUN, context(1, abort.signal))
    await flush()
    abort.abort()
    finishLookup('/opt/codex/bin/codex')
    await expect(result).resolves.toMatchObject({ outcome: 'exited', reason: 'cancelled' })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('advertises the streaming capability so an older relay can be told apart', async () => {
    const h = harness()
    await expect(h.handlers.get('agentProcess.getCapabilities')!({}, context())).resolves.toEqual({
      streamingStdioVersion: 1
    })
  })
})
