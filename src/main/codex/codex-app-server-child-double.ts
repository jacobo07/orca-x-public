// An in-process stand-in for a spawned `codex app-server`, so transport behaviour can be driven
// without a real child.
//
// Why not spawn a real node: the thing under test here is how inbound lines are CLASSIFIED, and a
// real process adds a spawn cost that has nothing to do with that. On a loaded host that cost has
// been measured above the session deadline itself, at which point every such test reports a
// timeout no matter what the transport does — a instrument that can only return one answer.

import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { spawn } from 'node:child_process'

export type CodexAppServerChildDouble = {
  /** Every line the client wrote to stdin, JSON-parsed in send order. */
  sent: Record<string, unknown>[]
  /** Deliver one line on the child's stdout, exactly as the server would frame it. */
  emit: (payload: unknown) => void
  /** Deliver a raw stdout string — for framing cases a JSON payload cannot express. */
  emitRaw: (text: string) => void
  emitStderr: (text: string) => void
  /** End the child. Fires 'exit' then 'close', in the order node does. */
  exit: (code?: number) => void
  killCount: number
  exited: boolean
  /** Resolves once the client has written a line whose `method` matches. */
  waitForSend: (method: string) => Promise<Record<string, unknown>>
}

export type CodexAppServerChildDoubleHandle = {
  double: CodexAppServerChildDouble
  spawnImpl: typeof spawn
  /** The invocation the client spawned with, or null when it never spawned. */
  spawnedWith: () => { command: string; args: string[]; env: NodeJS.ProcessEnv } | null
}

/**
 * @param options.exitOnStdinEnd mirrors the real server, which exits on EOF. Left on by default so
 *   a session's own teardown settles instead of waiting out its grace period.
 */
export function createCodexAppServerChildDouble(
  options: { exitOnStdinEnd?: boolean } = {}
): CodexAppServerChildDoubleHandle {
  const exitOnStdinEnd = options.exitOnStdinEnd ?? true
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const sent: Record<string, unknown>[] = []
  const sendWaiters: { method: string; resolve: (line: Record<string, unknown>) => void }[] = []

  let spawnedWith: { command: string; args: string[]; env: NodeJS.ProcessEnv } | null = null
  let stdinBuffer = ''

  const double: CodexAppServerChildDouble = {
    sent,
    emit: (payload) => stdout.write(`${JSON.stringify(payload)}\n`),
    emitRaw: (text) => stdout.write(text),
    emitStderr: (text) => stderr.write(text),
    exit: (code = 0) => {
      if (double.exited) {
        return
      }
      double.exited = true
      child.emit('exit', code, null)
      // Why separately: the session treats 'close' as the point the stderr tail is complete, so a
      // double that only fired 'exit' would never exercise its early-exit classification.
      child.emit('close', code, null)
    },
    killCount: 0,
    exited: false,
    waitForSend: (method) => {
      const already = sent.find((line) => line.method === method)
      if (already) {
        return Promise.resolve(already)
      }
      return new Promise((resolve) => sendWaiters.push({ method, resolve }))
    }
  }

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinBuffer += String(chunk)
      let newlineIndex: number
      while ((newlineIndex = stdinBuffer.indexOf('\n')) !== -1) {
        const line = stdinBuffer.slice(0, newlineIndex).trim()
        stdinBuffer = stdinBuffer.slice(newlineIndex + 1)
        if (!line) {
          continue
        }
        const parsed = JSON.parse(line) as Record<string, unknown>
        sent.push(parsed)
        for (let i = sendWaiters.length - 1; i >= 0; i -= 1) {
          if (sendWaiters[i].method === parsed.method) {
            sendWaiters.splice(i, 1)[0].resolve(parsed)
          }
        }
      }
      callback()
    }
  })
  stdin.on('finish', () => {
    if (exitOnStdinEnd) {
      double.exit(0)
    }
  })

  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.pid = 4242
  child.kill = (): boolean => {
    double.killCount += 1
    double.exit(137)
    return true
  }

  const spawnImpl = ((command: string, args: string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
    spawnedWith = { command, args, env: spawnOptions?.env ?? {} }
    return child
  }) as unknown as typeof spawn

  return { double, spawnImpl, spawnedWith: () => spawnedWith }
}

/** Yields to the microtask queue and one macrotask, so stream 'data' handlers have run. */
export async function flushChildIo(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
