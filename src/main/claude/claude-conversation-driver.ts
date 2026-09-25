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
import { startTurnToolServer, turnToolMcpConfig } from '../conversation/turn-tool-mcp-server'

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

/** Orca's tools for this turn, served over MCP as the `orca` server. */
export type ClaudeTurnMcp = { config: string; toolNames: readonly string[] }

/** The only built-in tools a turn that is also offered Orca's tools gets: reading, never changing. */
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const

/**
 * The argv for one turn. `--setting-sources project` (measured) loads the project's own settings
 * and none of the user's global hooks; `--bare` would also drop OAuth. A turn with no Orca tools
 * runs in `plan` (read-only, as Codex conversations do). `--strict-mcp-config` keeps every MCP
 * server the user configured out of an agent's turn; only Orca's own, when offered, is loaded, and
 * only its named tools are pre-allowed.
 */
export function buildClaudeTurnArgs(request: ProviderTurnRequest, mcp: ClaudeTurnMcp | null = null): string[] {
  return [
    '-p',
    request.text,
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    ...(mcp
      ? [
          // Why not plan mode here (measured 2026-09-25): plan mode refuses the served tool even when
          // pre-allowed ("delegating starts an agent, which plan mode doesn't allow"). Read-only is
          // kept by construction instead: only the read tools exist, and only Orca's tools are allowed.
          '--permission-mode',
          'default',
          '--tools',
          CLAUDE_READ_ONLY_TOOLS.join(','),
          '--mcp-config',
          mcp.config,
          '--allowedTools',
          mcp.toolNames.map((name) => `mcp__orca__${name}`).join(',')
        ]
      : ['--permission-mode', 'plan']),
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
  /** Every request the turn's tool server received; for diagnosing a client that never arrived. */
  observeToolServerRequest?: (summary: { method: string | undefined; path: string | undefined }) => void
}

export function createClaudeConversationDriver(
  options: ClaudeConversationDriverOptions = {}
): ConversationTurnDriver {
  const spawnProcess = options.spawnProcess ?? spawnClaudeProcess
  return {
    provider: 'claude',
    async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
      const tools = request.tools ?? []
      // Why per turn: the server holds this turn's bound tools and dies with it, so a later turn
      // (or anything else on the machine) cannot reach a tool whose authority belonged to this one.
      const toolServer =
        tools.length > 0
          ? await startTurnToolServer(tools, { onRequest: options.observeToolServerRequest })
          : null
      const mcp = toolServer
        ? { config: turnToolMcpConfig(toolServer), toolNames: tools.map((tool) => tool.name) }
        : null
      const child = spawnProcess(options.command ?? 'claude', buildClaudeTurnArgs(request, mcp), request.cwd)
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
        await toolServer?.close()
      }
      return { providerSessionId: sessionId }
    }
  }
}
