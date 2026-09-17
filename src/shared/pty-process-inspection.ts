import type {
  ShellInputSincePrompt,
  ShellPromptState
} from './terminal-osc133-prompt-state'

export type PtyProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
  /** The shell's own marker state; absent from authorities that predate it (older daemons). */
  promptState?: ShellPromptState
  /**
   * Whether the shell has taken user input since its last prompt, as seen by whoever owns the
   * pty — the only party that saw every byte, and so the only one that still knows after a
   * renderer reload. Absent means the authority predates input tracking: unknown, never 'clean'.
   */
  inputSincePrompt?: ShellInputSincePrompt
}
