import type { ShellPromptState } from './terminal-osc133-prompt-state'

export type PtyProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
  /** The shell's own marker state; absent from authorities that predate it (older daemons). */
  promptState?: ShellPromptState
}
