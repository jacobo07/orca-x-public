// The Claude implementation of ConversationTurnDriver: one `claude -p` process per turn.
//
// Coarse by construction (see coarse-provider-turn-contract.test.ts): no deltas, no channel to ask
// us anything, one process that ends by exiting. Everything Claude-shaped stops at this file.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import type {
  ConversationTurnDriver,
  ProviderTurnRequest,
  ProviderTurnResult
} from '../conversation/conversation-turn-runner'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { mapClaudeStreamLine, type ClaudeQuotaObservation } from './claude-stream-mapping'

/** A turn on a loaded host can be slow; this deadline ends a hung process rather than a slow one. */
const DEFAULT_TURN_DEADLINE_MS = 300_000
const STDERR_TAIL_CHARS = 2000

export type ClaudeProcess = {
  pid: number | undefined
  lines: AsyncIterable<string>
  stderrTail: () => string
  /** Resolves with the exit code once the process has ended. */
  exited: Promise<number | null>
  kill: () => Promise<void>
}

export type SpawnClaudeProcess = (command: string, args: string[], cwd: string) => ClaudeProcess

/**
 * The argv for one turn. `--setting-sources project` (measured) loads the project's own settings
 * and none of the user's global hooks; `--bare` would also drop OAuth. `plan` is read-only, the
 * same posture Codex conversations run under.
 */
export function buildClaudeTurnArgs(request: ProviderTurnRequest): string[] {
  return [
    '-p',
    request.text,
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project',
    '--permission-mode',
    'plan',
    ...(request.developerInstructions !== null
      ? ['--append-system-prompt', request.developerInstructions]
      : []),
    ...(request.resumeSessionId !== null ? ['--resume', request.resumeSessionId] : [])
  ]
}

export const spawnClaudeProcess: SpawnClaudeProcess = (command, args, cwd) => {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code))
    child.once('error', () => resolve(null))
  })
  return {
    pid: child.pid,
    lines: createInterface({ input: child.stdout!, crlfDelay: Infinity }),
    stderrTail: () => stderr,
    exited,
    kill: async () => {
      if (process.platform === 'win32' && child.pid) {
        await terminateWindowsProcessTree(child.pid)
      } else {
        child.kill('SIGKILL')
      }
    }
  }
}

export type ClaudeConversationDriverOptions = {
  command?: string
  timeoutMs?: number
  spawnProcess?: SpawnClaudeProcess
  /** Every quota observation the provider reports, for availability to read. */
  observeQuota?: (observation: ClaudeQuotaObservation) => void
}

export function createClaudeConversationDriver(
  options: ClaudeConversationDriverOptions = {}
): ConversationTurnDriver {
  const spawnProcess = options.spawnProcess ?? spawnClaudeProcess
  return {
    provider: 'claude',
    async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
      if (request.tools && request.tools.length > 0) {
        // Claude can take tools over MCP; Orca does not serve them to it yet. Said, not hidden.
        request.onEvent({
          kind: 'provider-status',
          status: 'tools-unavailable',
          detail: `this provider was offered ${request.tools.length} tool(s) Orca cannot serve to it`
        })
      }
      const child = spawnProcess(options.command ?? 'claude', buildClaudeTurnArgs(request), request.cwd)
      let sessionId: string | null = null
      let settled = false
      let timedOut = false
      const deadlineMs = options.timeoutMs ?? DEFAULT_TURN_DEADLINE_MS
      const deadline = setTimeout(() => {
        timedOut = true
        void child.kill()
      }, deadlineMs)
      try {
        for await (const line of child.lines) {
          if (!line.trim()) {
            continue
          }
          const mapped = mapClaudeStreamLine(line, request.turnId)
          if (mapped.sessionId) {
            sessionId = mapped.sessionId
          }
          if (mapped.quota) {
            options.observeQuota?.(mapped.quota)
          }
          if (mapped.settled) {
            settled = true
          }
          for (const event of mapped.events) {
            request.onEvent(event)
          }
        }
        const code = await child.exited
        if (!settled) {
          // Exited with no result line: the turn did not complete. Name why, from what the process said.
          const tail = child.stderrTail().trim()
          request.onEvent({
            kind: 'turn-ended',
            turnId: request.turnId,
            state: 'failed',
            reason: timedOut
              ? `claude did not finish within ${deadlineMs} ms and was stopped`
              : `claude exited ${code ?? 'abnormally'} without a result${tail ? `: ${tail}` : ''}`
          })
        }
      } finally {
        clearTimeout(deadline)
      }
      return { providerSessionId: sessionId }
    }
  }
}
