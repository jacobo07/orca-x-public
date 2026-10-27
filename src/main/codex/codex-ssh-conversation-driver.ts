// Resolves the Codex driver for a remote project's turn: the host's connection, whether its relay
// can run a provider process, the driver itself, and that host's own sign-in check.
//
// Every refusal is named before anything is committed: a host that is not connected and a relay
// too old to run the process are different fixes. A check that could not even ask THROWS rather
// than answering "not signed in", because that answer would send someone to fix the wrong thing.

import {
  AGENT_PROCESS_METHODS,
  AGENT_PROCESS_STREAMING_STDIO_VERSION
} from '../../shared/agent-process-wire'
import { parseExecutionHostId } from '../../shared/execution-host'
import type {
  RemoteDriverResolution,
  RemoteExecutionTarget
} from '../conversation/conversation-turn-runner'
import { ProviderUnavailableError } from '../conversation/provider-unavailable'
import { TurnInterruptedError } from '../conversation/turn-interruption'

import {
  isCodexAppServerUnsupportedError,
  runCodexAppServerSession
} from './codex-app-server-session'
import { createCodexConversationDriver } from './codex-conversation-driver'
import { createSshAgentProcessSpawn, type AgentProcessMux } from './codex-ssh-agent-process'

export type ConnectedMux = AgentProcessMux & { isDisposed: () => boolean }

const PROBE_TIMEOUT_MS = 5_000
const AUTH_CHECK_DEADLINE_MS = 30_000
/** A remote child's clean shutdown crosses a round trip; the local default of 1.5 s is too short. */
const REMOTE_EXIT_GRACE_MS = 5_000

function isMethodNotFound(error: unknown): boolean {
  // Numeric code only: a message regex misreads relay errors whose prose mentions a method.
  return (error as { code?: unknown } | null)?.code === -32601
}

export async function resolveSshCodexDriver(
  target: RemoteExecutionTarget,
  getMux: (targetId: string) => ConnectedMux | undefined,
  /** The target's device-independent address (`user@host:port`), so a thread recorded under
   *  another device's target id is still found for the same machine. */
  addressOf: (targetId: string) => string | null = () => null
): Promise<RemoteDriverResolution> {
  const host = parseExecutionHostId(target.hostId)
  const mux = host?.kind === 'ssh' ? getMux(host.targetId) : undefined
  if (!mux || mux.isDisposed()) {
    return { refusal: 'remote-host-unreachable' }
  }
  try {
    const capabilities = (await mux.request(
      AGENT_PROCESS_METHODS.getCapabilities,
      {},
      { timeoutMs: PROBE_TIMEOUT_MS }
    )) as { streamingStdioVersion?: unknown } | null
    const version = capabilities?.streamingStdioVersion
    if (typeof version !== 'number' || version < AGENT_PROCESS_STREAMING_STDIO_VERSION) {
      return { refusal: 'remote-relay-unsupported' }
    }
  } catch (error) {
    return isMethodNotFound(error)
      ? { refusal: 'remote-relay-unsupported' }
      : { refusal: 'remote-host-unreachable' }
  }
  if (await projectDirectoryIsGone(mux, target.path)) {
    return { refusal: 'remote-project-missing' }
  }

  const hostName = host?.kind === 'ssh' ? host.targetId : target.hostId
  const driver = createCodexConversationDriver({
    command: 'codex',
    runSession: (invocation, body, _spawn, handlers) =>
      runCodexAppServerSession(
        { ...invocation, exitGraceMs: REMOTE_EXIT_GRACE_MS },
        body,
        createSshAgentProcessSpawn(mux, {
          cwd: target.path,
          deadlineMs: invocation.timeoutMs,
          ...(invocation.env ? { envOverlay: invocation.env } : {})
        }) as never,
        handlers
      ).catch((error: unknown) => {
        if ((error as { code?: unknown } | null)?.code === 'REMOTE_HOST_DISCONNECTED') {
          throw new TurnInterruptedError(
            'host-lost',
            `the connection to ${hostName} closed mid-turn`
          )
        }
        throw isCodexAppServerUnsupportedError(error)
          ? new ProviderUnavailableError(
              'protocol-unsupported',
              `codex on ${hostName} is too old to hold a conversation (no app-server)`
            )
          : error
      })
  })
  return {
    driver,
    checkAuth: () => checkRemoteCodexAuth(mux, target.path, hostName),
    hostAddress: host?.kind === 'ssh' ? addressOf(host.targetId) : null
  }
}

/** True only on the host's positive answer that the directory is not there: a non-directory, or
 *  ENOENT/ENOTDIR from the relay's `fs.stat`. Any other failure is not an answer about the project,
 *  and the relay's own directory check still refuses before anything runs. */
async function projectDirectoryIsGone(mux: AgentProcessMux, path: string): Promise<boolean> {
  try {
    const stats = (await mux.request(
      'fs.stat',
      { filePath: path },
      { timeoutMs: PROBE_TIMEOUT_MS }
    )) as { type?: unknown } | null
    return typeof stats?.type === 'string' && stats.type !== 'directory'
  } catch (error) {
    return /^(ENOENT|ENOTDIR):/.test(error instanceof Error ? error.message : '')
  }
}

/** `codex login status` on the host: exit 0 signed in, 1 signed out — measured on codex-cli
 *  0.155.1. Anything else is not an answer about sign-in, so it throws. */
export function checkRemoteCodexAuth(
  mux: AgentProcessMux,
  cwd: string,
  hostName: string
): Promise<{ ready: true } | { ready: false; detail: string }> {
  return new Promise((resolve, reject) => {
    const child = createSshAgentProcessSpawn(mux, { cwd, deadlineMs: AUTH_CHECK_DEADLINE_MS })(
      'codex',
      ['login', 'status']
    )
    let failure: (Error & { refusal?: unknown }) | null = null
    child.on('error', (error: Error) => {
      failure = error
    })
    child.stdout.resume()
    child.stderr.resume()
    child.stdin.end()
    child.on('close', (exitCode: number | null) => {
      // The relay looked for codex on this login's PATH and found none: an answer, not a failure.
      if (failure?.refusal === 'command-not-found') {
        reject(
          new ProviderUnavailableError('not-installed', `codex is not installed on ${hostName}`)
        )
      } else if (failure) {
        reject(failure)
      } else if (exitCode === 0) {
        resolve({ ready: true })
      } else if (exitCode === 1) {
        resolve({ ready: false, detail: `codex on ${hostName} is not signed in` })
      } else {
        reject(new Error(`codex login status on ${hostName} exited ${exitCode}`))
      }
    })
  })
}
