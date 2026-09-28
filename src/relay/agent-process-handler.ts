import type { ChildProcess } from 'node:child_process'
import path from 'node:path'

import { defaultAgentProcessHostDeps, type AgentProcessHostDeps } from './agent-process-host-deps'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { buildRelayCommandEnv } from './relay-command-env'
import {
  AGENT_PROCESS_METHODS,
  AGENT_PROCESS_STREAMING_STDIO_VERSION,
  type AgentProcessRunOutcome
} from '../shared/agent-process-wire'
import { applyTerminalGitCredentialPromptGuard } from '../shared/terminal-git-credential-guard'

// A long-lived provider process (codex app-server) on the ssh host, spoken to over streaming stdio.
//
// Distinct from `agent.execNonInteractive`, which is one-shot: stdin once, output at exit, 4 MB and
// five minutes. A JSON-RPC provider session needs both directions open for the whole turn, so the
// `run` request is HELD for the child's life and its output streams as sequenced bulk frames.
//
// The child never outlives the client that asked for it: a JSON-RPC session's request ids died with
// the channel, so there is nothing to reattach to. Detach, cancel, timeout, deadline and relay
// shutdown all kill the whole process group.
//
// The invocation and env allow-lists bound PRODUCT SCOPE, not security: the relay already runs as the
// ssh user and trusts its client (context.ts), and `pty.spawn` reaches any command. They exist so this
// method cannot quietly become a second arbitrary-exec path.

const ALLOWED_INVOCATIONS = new Set(['codex app-server', 'codex login status'])
const ALLOWED_ENV_KEYS = new Set(['CODEX_HOME'])

const MIN_DEADLINE_MS = 1_000
const MAX_DEADLINE_MS = 30 * 60 * 1000
const KILL_GRACE_MS = 1_500
const STDERR_TAIL_BYTES = 8 * 1024
/** Raw bytes per frame. Bulk frame capacity is per client; base64 of this stays well under it. */
const FRAME_SLICE_BYTES = 8 * 1024

type RunParams = {
  streamId?: unknown
  command?: unknown
  args?: unknown
  cwd?: unknown
  envOverlay?: unknown
  deadlineMs?: unknown
}

type Running = { child: ChildProcess; stop: (reason: 'cancelled') => void }

export type AgentProcessHandlerDeps = AgentProcessHostDeps

const streamKey = (clientId: number, streamId: string): string => `${clientId}:${streamId}`

export class AgentProcessHandler {
  private readonly running = new Map<string, Running>()
  private readonly resolvedCommands = new Map<string, string>()
  private readonly deps: AgentProcessHandlerDeps
  private disposed = false

  constructor(
    private readonly dispatcher: RelayDispatcher,
    deps: Partial<AgentProcessHandlerDeps> = {}
  ) {
    this.deps = { ...defaultAgentProcessHostDeps, ...deps }
    dispatcher.onRequest(AGENT_PROCESS_METHODS.getCapabilities, async () => ({
      streamingStdioVersion: AGENT_PROCESS_STREAMING_STDIO_VERSION
    }))
    dispatcher.onRequest(AGENT_PROCESS_METHODS.run, (params, context) =>
      this.run(params as RunParams, context)
    )
    dispatcher.onRequest(AGENT_PROCESS_METHODS.write, async (params, context) =>
      this.write(params as { streamId?: unknown; data?: unknown }, context)
    )
    dispatcher.onRequest(AGENT_PROCESS_METHODS.closeStdin, async (params, context) =>
      this.closeStdin(params as { streamId?: unknown }, context)
    )
  }

  /** Kills every child and waits until each has closed. Awaited by relay shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true
    const closing = [...this.running.values()].map(
      (entry) =>
        new Promise<void>((resolve) => {
          if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
            resolve()
            return
          }
          entry.child.once('close', () => resolve())
          entry.stop('cancelled')
        })
    )
    await Promise.all(closing)
  }

  private owned(streamId: unknown, context: RequestContext): Running {
    // Keyed by client: another client's stream is not yours to write to or close.
    const entry =
      typeof streamId === 'string'
        ? this.running.get(streamKey(context.clientId, streamId))
        : undefined
    if (!entry) {
      throw new Error('AGENT_PROCESS_NOT_RUNNING')
    }
    return entry
  }

  private write(
    params: { streamId?: unknown; data?: unknown },
    context: RequestContext
  ): { ok: true } {
    const entry = this.owned(params.streamId, context)
    if (typeof params.data !== 'string') {
      throw new Error('agentProcess.write: data must be a string')
    }
    if (!entry.child.stdin || entry.child.stdin.destroyed || entry.child.stdin.writableEnded) {
      throw new Error('AGENT_PROCESS_NOT_RUNNING')
    }
    entry.child.stdin.write(params.data)
    return { ok: true }
  }

  private closeStdin(params: { streamId?: unknown }, context: RequestContext): { ok: true } {
    this.owned(params.streamId, context).child.stdin?.end()
    return { ok: true }
  }

  private async resolveCommand(command: string): Promise<string | null> {
    const cached = this.resolvedCommands.get(command)
    if (cached) {
      return cached
    }
    const resolved = await this.deps.resolveCommand(command)
    if (resolved) {
      this.resolvedCommands.set(command, resolved)
    }
    return resolved
  }

  private async run(params: RunParams, context: RequestContext): Promise<AgentProcessRunOutcome> {
    const streamId = typeof params.streamId === 'string' ? params.streamId : ''
    const key = streamKey(context.clientId, streamId)
    if (!streamId || this.running.has(key)) {
      throw new Error('agentProcess.run: a fresh streamId is required')
    }
    const command = typeof params.command === 'string' ? params.command : ''
    const args = Array.isArray(params.args) ? params.args.map((arg) => String(arg)) : []
    if (!ALLOWED_INVOCATIONS.has([command, ...args].join(' '))) {
      return { outcome: 'refused', reason: 'command-not-allowed' }
    }
    const overlay: Record<string, string> = {}
    if (params.envOverlay !== undefined && params.envOverlay !== null) {
      if (typeof params.envOverlay !== 'object' || Array.isArray(params.envOverlay)) {
        return { outcome: 'refused', reason: 'env-not-allowed' }
      }
      for (const [name, value] of Object.entries(params.envOverlay)) {
        if (!ALLOWED_ENV_KEYS.has(name) || typeof value !== 'string') {
          return { outcome: 'refused', reason: 'env-not-allowed' }
        }
        overlay[name] = value
      }
    }
    if (this.deps.platform === 'win32') {
      // Stated, not silent: `.cmd` shims and process-tree semantics on Windows hosts are unbuilt.
      return { outcome: 'refused', reason: 'platform-unsupported' }
    }
    const requestedCwd = typeof params.cwd === 'string' ? params.cwd : ''
    const cwd = requestedCwd ? await this.deps.isDirectory(requestedCwd) : null
    if (cwd === null) {
      // Its own answer: "the project is gone on that host" is not a spawn failure.
      return { outcome: 'refused', reason: 'cwd-missing' }
    }
    const executable = await this.resolveCommand(command)
    if (executable === null) {
      return { outcome: 'refused', reason: 'command-not-found' }
    }

    const env = buildRelayCommandEnv(process.env, this.deps.platform) as Record<string, string>
    // An npm-installed provider is a `#!/usr/bin/env node` script: its own directory holds the node
    // it was installed with, which the relay's PATH (no nvm/asdf) would otherwise miss.
    env.PATH = [path.posix.dirname(executable), env.PATH].filter(Boolean).join(':')
    Object.assign(env, overlay)
    applyTerminalGitCredentialPromptGuard(env, { isUnattended: true, platform: this.deps.platform })

    const requestedDeadline =
      typeof params.deadlineMs === 'number' ? params.deadlineMs : MAX_DEADLINE_MS
    const deadlineMs = Math.max(MIN_DEADLINE_MS, Math.min(MAX_DEADLINE_MS, requestedDeadline))

    // The lookups above awaited; a client that left meanwhile must not get a child nobody owns.
    if (this.disposed || context.signal?.aborted) {
      return exited(null, null, 0, 0, '', 'cancelled')
    }

    return new Promise<AgentProcessRunOutcome>((resolve) => {
      let child: ChildProcess
      try {
        child = this.deps.spawn(executable, args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Own process group, so a group kill reaches the provider's tool subprocesses.
          detached: true,
          windowsHide: true
        })
      } catch {
        resolve(exited(null, null, 0, 0, '', 'spawn-error'))
        return
      }

      let stdoutSeq = 0
      let stderrSeq = 0
      let stderrTail = ''
      let reason: 'closed' | 'deadline' | 'cancelled' | 'spawn-error' = 'closed'
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      let pending: Promise<void> = Promise.resolve()

      const stop = (why: 'deadline' | 'cancelled'): void => {
        if (reason === 'closed') {
          reason = why
        }
        this.deps.killGroup(child, 'SIGTERM')
        killTimer ??= setTimeout(() => this.deps.killGroup(child, 'SIGKILL'), KILL_GRACE_MS)
      }
      this.running.set(key, { child, stop })
      const publish = (method: string, frame: Record<string, unknown>): Promise<void> =>
        this.dispatcher.notifyBulk(method, { streamId, ...frame }, { clientId: context.clientId })

      // First frame on the same serialized chain as the output: the command lookup happens BEFORE
      // the spawn, so a client writing stdin on sending `run` would otherwise race a missing child.
      pending = publish(AGENT_PROCESS_METHODS.started, {}).catch(() => stop('cancelled'))
      const deadline = setTimeout(() => stop('deadline'), deadlineMs)
      const onAbort = (): void => stop('cancelled')
      context.signal?.addEventListener('abort', onAbort, { once: true })
      if (context.signal?.aborted) {
        stop('cancelled')
      }

      // Sequenced and AWAITED on one chain: the bulk lane is the only relay->client lane with
      // backpressure, and a dropped frame is a lost approval request or a lost turn/completed.
      const pump = (
        stream: NodeJS.ReadableStream | null,
        method: string,
        next: () => number
      ): void => {
        stream?.on('data', (chunk: Buffer) => {
          stream.pause()
          pending = pending
            .then(async () => {
              for (let offset = 0; offset < chunk.length; offset += FRAME_SLICE_BYTES) {
                // notifyBulk resolves quietly for a closed client; stop rather than pump into nothing.
                if (context.signal?.aborted) {
                  return
                }
                const slice = chunk.subarray(offset, offset + FRAME_SLICE_BYTES)
                await publish(method, { seq: next(), data: slice.toString('base64') })
              }
            })
            .catch(() => stop('cancelled'))
            .finally(() => stream.resume())
        })
      }
      pump(child.stdout, AGENT_PROCESS_METHODS.stdout, () => ++stdoutSeq)
      pump(child.stderr, AGENT_PROCESS_METHODS.stderr, () => ++stderrSeq)
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
      })
      child.stdin?.on('error', () => {
        // EPIPE after the child died; 'close' reports the exit.
      })

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(deadline)
        if (killTimer) {
          clearTimeout(killTimer)
        }
        context.signal?.removeEventListener('abort', onAbort)
        this.running.delete(key)
        // Resolve only after every frame was handed to the sink, so finalSeq is really final.
        void pending.then(() =>
          resolve(exited(exitCode, signal, stdoutSeq, stderrSeq, stderrTail, reason))
        )
      }
      child.on('error', () => {
        reason = 'spawn-error'
        finish(null, null)
      })
      child.on('close', (exitCode, signal) => finish(exitCode, signal))
    })
  }
}

function exited(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  finalStdoutSeq: number,
  finalStderrSeq: number,
  stderrTail: string,
  reason: 'closed' | 'deadline' | 'cancelled' | 'spawn-error'
): AgentProcessRunOutcome {
  return {
    outcome: 'exited',
    exitCode,
    signal,
    finalStdoutSeq,
    finalStderrSeq,
    stderrTail,
    reason
  }
}
