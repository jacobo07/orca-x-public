// A REAL relay dispatcher and agentProcess handler talking to a REAL multiplexer over an in-memory
// transport: the whole remote-provider path in one process, with nothing faked but the ssh wire.
// Shared by the rung-2 and rung-3 tests; never imported by product code.

import { readdirSync, readlinkSync, realpathSync } from 'node:fs'

import { AgentProcessHandler } from '../../relay/agent-process-handler'
import { RelayDispatcher } from '../../relay/dispatcher'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'

export type RelayHarness = {
  dispatcher: RelayDispatcher
  mux: SshChannelMultiplexer
  handler: AgentProcessHandler
}

/** `realHost` keeps the handler's own host deps (command resolution, spawn, group kill). Otherwise
 *  "codex" resolves to this node, so a script file named after the subcommand is what runs. */
export function createRelayHarness(realHost = false): RelayHarness {
  let relayFeed: ((data: Buffer) => void) | undefined
  const clientDataCallbacks: ((data: Buffer) => void)[] = []
  const transport: MultiplexerTransport = {
    write: (data, onSettled) => {
      setImmediate(() => {
        relayFeed?.(data)
        onSettled?.({ ok: true })
      })
    },
    supportsWriteSettlement: true,
    onData: (cb) => {
      clientDataCallbacks.push(cb)
    },
    onClose: () => {}
  }
  const dispatcher = new RelayDispatcher(
    (data: Buffer, onSettled) => {
      setImmediate(() => {
        for (const cb of clientDataCallbacks) {
          cb(data)
        }
        onSettled({ ok: true })
      })
    },
    { supportsWriteCallback: true }
  )
  relayFeed = (data) => dispatcher.feed(data)
  // The handler refuses Windows hosts; a scripted run may be on Windows, and that refusal is not
  // what it proves. Everything else — spawn, streams, kill — is the real code.
  const handler = new AgentProcessHandler(
    dispatcher,
    realHost ? {} : { resolveCommand: async () => process.execPath, platform: 'linux' }
  )
  return { dispatcher, mux: new SshChannelMultiplexer(transport), handler }
}

export async function disposeRelayHarness(harness: RelayHarness): Promise<void> {
  await harness.handler.dispose()
  harness.mux.dispose()
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

/** The executable of every process whose working directory is `dir`, read from the kernel (Linux). */
export function processesIn(dir: string): string[] {
  const real = realpathSync(dir)
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        return readlinkSync(`/proc/${name}/cwd`) === real ? [readlinkSync(`/proc/${name}/exe`)] : []
      } catch {
        // Exited between the listing and the read, or not ours to inspect.
        return []
      }
    })
}
