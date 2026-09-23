// A `spawn`-shaped adapter that runs a provider process ON an ssh host through the relay's
// `agentProcess.*` methods, returning a child the local app-server session can drive unchanged.
//
// Three rules hold it together:
// - `pid` is undefined. The session's reap runs a LOCAL `taskkill /pid` on Windows desktops; a remote
//   pid there would kill an unrelated local process.
// - `options.env` is ignored. It is this desktop's environment merged with the overlay, and shipping
//   it would send local secrets and a meaningless Windows PATH to the remote host. Only the
//   invocation's own overlay crosses.
// - Output arrives as sequenced frames; a gap is a protocol error that ends the child, never a
//   silent hole in a JSON-RPC stream.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

import {
  AGENT_PROCESS_METHODS,
  type AgentProcessOutputFrame,
  type AgentProcessRunOutcome
} from '../../shared/agent-process-wire'

export type AgentProcessMux = {
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<unknown>
  onNotificationByMethod: (
    method: string,
    handler: (params: Record<string, unknown>) => void
  ) => () => void
  onDispose: (handler: (reason: 'shutdown' | 'connection_lost') => void) => () => void
}

export type SshAgentProcessOptions = {
  /** The project directory on the remote host — never a local path. */
  cwd: string
  /** The remote child's lifetime; the relay kills its group when it lapses. */
  deadlineMs: number
  envOverlay?: Record<string, string>
  mintStreamId?: () => string
}

/** Margin between the remote deadline and the local wait for its answer, so the relay's own kill
 *  reports first instead of racing the mux timeout. */
const RUN_RESPONSE_MARGIN_MS = 30_000
const WRITE_TIMEOUT_MS = 30_000

export type SshAgentProcessChild = EventEmitter & {
  pid: undefined
  stdout: PassThrough
  stderr: PassThrough
  stdin: Writable
  exitCode: number | null
  kill: (signal?: NodeJS.Signals | number) => boolean
}

/** Error codes a caller can branch on without reading prose. */
export type SshAgentProcessErrorCode =
  | 'REMOTE_PROCESS_REFUSED'
  | 'REMOTE_HOST_DISCONNECTED'
  | 'REMOTE_RELAY_UNSUPPORTED'
  | 'REMOTE_STREAM_GAP'
  | 'REMOTE_PROCESS_FAILED'

function processError(
  code: SshAgentProcessErrorCode,
  message: string
): Error & { code: SshAgentProcessErrorCode } {
  return Object.assign(new Error(message), { code })
}

export function createSshAgentProcessSpawn(mux: AgentProcessMux, options: SshAgentProcessOptions) {
  return (command: string, args: readonly string[]): SshAgentProcessChild =>
    startSshAgentProcess(mux, options, command, [...args])
}

function startSshAgentProcess(
  mux: AgentProcessMux,
  options: SshAgentProcessOptions,
  command: string,
  args: string[]
): SshAgentProcessChild {
  const streamId = options.mintStreamId?.() ?? `ap_${randomUUID()}`
  const abort = new AbortController()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const expected = { stdout: 1, stderr: 1 }
  let ended = false

  let markStarted: () => void = () => {}
  let failStart: (error: Error) => void = () => {}
  const started = new Promise<void>((resolve, reject) => {
    markStarted = resolve
    failStart = reject
  })
  // A refusal before start leaves `started` rejected with nobody awaiting it yet.
  started.catch(() => {})

  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      // Held until the remote child exists; the relay resolves the command before it spawns.
      started
        .then(() =>
          mux.request(
            AGENT_PROCESS_METHODS.write,
            { streamId, data: chunk.toString() },
            { timeoutMs: WRITE_TIMEOUT_MS }
          )
        )
        .then(
          () => callback(),
          (error: Error) => callback(error)
        )
    },
    final(callback) {
      started
        .then(() =>
          mux.request(
            AGENT_PROCESS_METHODS.closeStdin,
            { streamId },
            { timeoutMs: WRITE_TIMEOUT_MS }
          )
        )
        .then(
          () => callback(),
          // EOF on a child that is already gone is not an error worth surfacing.
          () => callback()
        )
    }
  })

  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout,
    stderr,
    stdin,
    exitCode: null as number | null,
    kill: (): boolean => {
      abort.abort()
      return true
    }
  }) satisfies SshAgentProcessChild

  const end = (outcome: {
    exitCode: number | null
    signal: string | null
    error?: Error
  }): void => {
    if (ended) {
      return
    }
    ended = true
    unsubscribe()
    failStart(outcome.error ?? processError('REMOTE_PROCESS_FAILED', 'remote process ended'))
    if (outcome.error) {
      child.emit('error', outcome.error)
    }
    stdout.end()
    stderr.end()
    child.exitCode = outcome.exitCode
    // 'exit' then 'close', as a real child: the session reads its stderr tail on 'close'.
    child.emit('exit', outcome.exitCode, outcome.signal)
    setImmediate(() => child.emit('close', outcome.exitCode, outcome.signal))
  }

  const deliver =
    (stream: 'stdout' | 'stderr', target: PassThrough) =>
    (params: Record<string, unknown>): void => {
      const frame = params as AgentProcessOutputFrame
      if (frame.streamId !== streamId || ended) {
        return
      }
      if (frame.seq !== expected[stream]) {
        // End WITH the error before aborting: the abort path ends as a plain kill, and running it
        // first would report a protocol failure as an ordinary exit.
        end({
          exitCode: null,
          signal: null,
          error: processError(
            'REMOTE_STREAM_GAP',
            `remote ${stream} frame ${frame.seq} arrived where ${expected[stream]} was due`
          )
        })
        abort.abort()
        return
      }
      expected[stream] += 1
      target.write(Buffer.from(frame.data, 'base64'))
    }

  const subscriptions = [
    mux.onNotificationByMethod(AGENT_PROCESS_METHODS.started, (params) => {
      if (params.streamId === streamId) {
        markStarted()
      }
    }),
    mux.onNotificationByMethod(AGENT_PROCESS_METHODS.stdout, deliver('stdout', stdout)),
    mux.onNotificationByMethod(AGENT_PROCESS_METHODS.stderr, deliver('stderr', stderr)),
    mux.onDispose(() => {
      end({
        exitCode: null,
        signal: 'SIGKILL',
        error: processError('REMOTE_HOST_DISCONNECTED', 'the ssh connection to the host closed')
      })
    })
  ]
  const unsubscribe = (): void => {
    for (const stop of subscriptions) {
      stop()
    }
  }

  // A local kill does not wait for the relay: a cancelled request gets no response, so waiting for
  // one would stall the reap. The remote group kill is requested; its confirmation is not awaited.
  abort.signal.addEventListener('abort', () => end({ exitCode: null, signal: 'SIGKILL' }), {
    once: true
  })

  const params = {
    streamId,
    command,
    args,
    cwd: options.cwd,
    deadlineMs: options.deadlineMs,
    ...(options.envOverlay ? { envOverlay: options.envOverlay } : {})
  }
  mux
    .request(AGENT_PROCESS_METHODS.run, params, {
      timeoutMs: options.deadlineMs + RUN_RESPONSE_MARGIN_MS,
      signal: abort.signal
    })
    .then((result) => {
      const outcome = result as AgentProcessRunOutcome
      if (outcome.outcome === 'refused') {
        end({
          exitCode: null,
          signal: null,
          error: processError('REMOTE_PROCESS_REFUSED', `remote host refused: ${outcome.reason}`)
        })
        return
      }
      // The relay publishes every frame before it answers, on the same client, so a count short
      // of the final seq means frames were lost, not late.
      if (
        expected.stdout - 1 !== outcome.finalStdoutSeq ||
        expected.stderr - 1 !== outcome.finalStderrSeq
      ) {
        end({
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          error: processError('REMOTE_STREAM_GAP', 'remote output ended with frames missing')
        })
        return
      }
      end({ exitCode: outcome.exitCode, signal: outcome.signal })
    })
    .catch((error: { code?: unknown; name?: string; message?: string }) => {
      if (error?.name === 'AbortError') {
        return
      }
      const code =
        error?.code === -32601
          ? 'REMOTE_RELAY_UNSUPPORTED'
          : error?.code === 'CONNECTION_LOST' || error?.code === 'DISPOSED'
            ? 'REMOTE_HOST_DISCONNECTED'
            : 'REMOTE_PROCESS_FAILED'
      end({
        exitCode: null,
        signal: null,
        error: processError(code, error?.message ?? 'remote process failed')
      })
    })

  return child
}
