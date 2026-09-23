// The `agentProcess.*` relay wire: a provider process run on an ssh host over streaming stdio.
// Shared so the relay that serves it and the desktop that drives it cannot disagree on a name.

export const AGENT_PROCESS_METHODS = {
  getCapabilities: 'agentProcess.getCapabilities',
  run: 'agentProcess.run',
  write: 'agentProcess.write',
  closeStdin: 'agentProcess.closeStdin',
  started: 'agentProcess.started',
  stdout: 'agentProcess.stdout',
  stderr: 'agentProcess.stderr'
} as const

export const AGENT_PROCESS_STREAMING_STDIO_VERSION = 1

export type AgentProcessRefusal =
  | 'command-not-allowed'
  | 'env-not-allowed'
  | 'platform-unsupported'
  | 'command-not-found'
  | 'cwd-missing'

export type AgentProcessRunParams = {
  streamId: string
  command: string
  args: string[]
  cwd: string
  envOverlay?: Record<string, string>
  deadlineMs: number
}

export type AgentProcessRunOutcome =
  | { outcome: 'refused'; reason: AgentProcessRefusal }
  | {
      outcome: 'exited'
      exitCode: number | null
      signal: string | null
      /** Last seq sent on each stream: a consistency check the client verifies before 'close'. */
      finalStdoutSeq: number
      finalStderrSeq: number
      stderrTail: string
      reason: 'closed' | 'deadline' | 'cancelled' | 'spawn-error'
    }

export type AgentProcessOutputFrame = { streamId: string; seq: number; data: string }
