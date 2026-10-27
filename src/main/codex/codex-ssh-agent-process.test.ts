import { describe, expect, it } from 'vitest'

import { AGENT_PROCESS_METHODS } from '../../shared/agent-process-wire'

import { createSshAgentProcessSpawn, type AgentProcessMux } from './codex-ssh-agent-process'

type Call = { method: string; params: Record<string, unknown>; signal?: AbortSignal }

function fakeMux() {
  const calls: Call[] = []
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  const disposers = new Set<(reason: 'shutdown' | 'connection_lost') => void>()
  let finishRun: (value: unknown) => void = () => {}
  let failRun: (error: unknown) => void = () => {}
  let failWrites: unknown = null
  const mux: AgentProcessMux = {
    request: (method, params = {}, options) => {
      calls.push({ method, params, signal: options?.signal })
      if (method === AGENT_PROCESS_METHODS.run) {
        return new Promise((resolve, reject) => {
          finishRun = resolve
          failRun = reject
          options?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
          )
        })
      }
      return failWrites ? Promise.reject(failWrites) : Promise.resolve({ ok: true })
    },
    onNotificationByMethod: (method, handler) => {
      const set = listeners.get(method) ?? new Set()
      set.add(handler)
      listeners.set(method, set)
      return () => set.delete(handler)
    },
    onDispose: (handler) => {
      disposers.add(handler)
      return () => disposers.delete(handler)
    }
  }
  return {
    mux,
    calls,
    emit: (method: string, params: Record<string, unknown>) =>
      listeners.get(method)?.forEach((handler) => handler(params)),
    dispose: () => disposers.forEach((handler) => handler('connection_lost')),
    finishRun: (value: unknown) => finishRun(value),
    failRun: (error: unknown) => failRun(error),
    failWritesWith: (error: unknown) => (failWrites = error)
  }
}

const OPTIONS = { cwd: '/srv/ledger', deadlineMs: 60_000, mintStreamId: () => 's1' }
const flush = () => new Promise((resolve) => setImmediate(resolve))
const frame = (seq: number, text: string) => ({
  streamId: 's1',
  seq,
  data: Buffer.from(text).toString('base64')
})

function events(child: NodeJS.EventEmitter): string[] {
  const seen: string[] = []
  for (const name of ['error', 'exit', 'close']) {
    child.on(name, (value: unknown) =>
      seen.push(name === 'error' ? `error:${(value as { code?: string }).code}` : name)
    )
  }
  return seen
}

describe('ssh agent process: the spawn contract the local session relies on', () => {
  it('has no pid, so the local reap can never taskkill a remote number', () => {
    const f = fakeMux()
    const child = createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server'])
    expect(child.pid).toBeUndefined()
  })

  it('sends the remote cwd and only the invocation overlay — never this desktop environment', () => {
    process.env.ORCA_LOCAL_SENTINEL = 'must-not-cross'
    const f = fakeMux()
    createSshAgentProcessSpawn(f.mux, { ...OPTIONS, envOverlay: { CODEX_HOME: '/h/.codex' } })(
      'codex',
      ['app-server']
    )
    const run = f.calls.find((call) => call.method === AGENT_PROCESS_METHODS.run)!
    expect(run.params).toEqual({
      streamId: 's1',
      command: 'codex',
      args: ['app-server'],
      cwd: '/srv/ledger',
      deadlineMs: 60_000,
      envOverlay: { CODEX_HOME: '/h/.codex' }
    })
    expect(JSON.stringify(f.calls)).not.toContain('must-not-cross')
    delete process.env.ORCA_LOCAL_SENTINEL
  })

  it('holds stdin until the remote child has started, then writes in order', async () => {
    const f = fakeMux()
    const child = createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server'])
    child.stdin.write('{"id":1}\n')
    await flush()
    expect(f.calls.map((call) => call.method)).toEqual([AGENT_PROCESS_METHODS.run])

    f.emit(AGENT_PROCESS_METHODS.started, { streamId: 's1' })
    await flush()
    expect(f.calls.filter((call) => call.method === AGENT_PROCESS_METHODS.write)).toEqual([
      expect.objectContaining({ params: { streamId: 's1', data: '{"id":1}\n' } })
    ])
  })

  it('surfaces a failed write on stdin, where the session listens for EPIPE', async () => {
    const f = fakeMux()
    const child = createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server'])
    const errors: Error[] = []
    child.stdin.on('error', (error) => errors.push(error))
    f.failWritesWith(new Error('AGENT_PROCESS_NOT_RUNNING'))
    f.emit(AGENT_PROCESS_METHODS.started, { streamId: 's1' })
    child.stdin.write('x\n')
    await flush()
    await flush()
    expect(errors.map((error) => error.message)).toEqual(['AGENT_PROCESS_NOT_RUNNING'])
  })

  it('delivers output in sequence and exits then closes once the run answers with a matching final seq', async () => {
    const f = fakeMux()
    const child = createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server'])
    const seen = events(child)
    let text = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (text += chunk))
    f.emit(AGENT_PROCESS_METHODS.stdout, frame(1, 'hello '))
    f.emit(AGENT_PROCESS_METHODS.stdout, frame(2, 'world\n'))
    f.finishRun({
      outcome: 'exited',
      exitCode: 0,
      signal: null,
      finalStdoutSeq: 2,
      finalStderrSeq: 0,
      stderrTail: '',
      reason: 'closed'
    })
    await flush()
    await flush()
    expect(text).toBe('hello world\n')
    expect(seen).toEqual(['exit', 'close'])
  })

  it('treats a missing frame as a protocol error, never a silent hole', async () => {
    const f = fakeMux()
    const child = createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server'])
    const seen = events(child)
    f.emit(AGENT_PROCESS_METHODS.stdout, frame(1, 'a'))
    f.emit(AGENT_PROCESS_METHODS.stdout, frame(3, 'c'))
    await flush()
    expect(seen[0]).toBe('error:REMOTE_STREAM_GAP')
    expect(f.calls.find((call) => call.method === AGENT_PROCESS_METHODS.run)!.signal!.aborted).toBe(
      true
    )
  })

  it('reports frames lost before the answer as a gap, not a clean exit', async () => {
    const f = fakeMux()
    const child = createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server'])
    const seen = events(child)
    f.emit(AGENT_PROCESS_METHODS.stdout, frame(1, 'a'))
    f.finishRun({
      outcome: 'exited',
      exitCode: 0,
      signal: null,
      finalStdoutSeq: 2,
      finalStderrSeq: 0,
      stderrTail: '',
      reason: 'closed'
    })
    await flush()
    expect(seen[0]).toBe('error:REMOTE_STREAM_GAP')
  })
})

describe('ssh agent process: every way it can end has its own name', () => {
  it('a refusal from the host', async () => {
    const f = fakeMux()
    const seen = events(createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server']))
    f.finishRun({ outcome: 'refused', reason: 'cwd-missing' })
    await flush()
    expect(seen.slice(0, 2)).toEqual(['error:REMOTE_PROCESS_REFUSED', 'exit'])
  })

  it('a relay too old to know the method, classified by its numeric code', async () => {
    const f = fakeMux()
    const seen = events(createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server']))
    f.failRun(Object.assign(new Error('Method not found'), { code: -32601 }))
    await flush()
    expect(seen[0]).toBe('error:REMOTE_RELAY_UNSUPPORTED')
  })

  it('a connection that closed mid-turn', async () => {
    const f = fakeMux()
    const seen = events(createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server']))
    f.dispose()
    await flush()
    expect(seen.slice(0, 2)).toEqual(['error:REMOTE_HOST_DISCONNECTED', 'exit'])
  })

  it('a local kill ends the child at once and cancels the remote run — it does not wait for an answer that will not come', async () => {
    const f = fakeMux()
    const child = createSshAgentProcessSpawn(f.mux, OPTIONS)('codex', ['app-server'])
    const seen = events(child)
    child.kill('SIGKILL')
    await flush()
    expect(seen).toEqual(['exit', 'close'])
    expect(f.calls.find((call) => call.method === AGENT_PROCESS_METHODS.run)!.signal!.aborted).toBe(
      true
    )
  })
})
