import {
  createShellPromptStateTracker,
  resolveShellPromptState,
  shellPromptMarkerTrust,
  type ShellInputSincePrompt,
  type ShellPromptState
} from '../../shared/terminal-osc133-prompt-state'
import { createShellInputSincePromptTracker } from '../../shared/terminal-shell-input-since-prompt'

/** One shell process's own last OSC 133 marker; survives any client or app restart. */
export class SessionShellPromptState {
  private readonly input = createShellInputSincePromptTracker()
  private readonly tracker = createShellPromptStateTracker(
    () => this.trust(),
    (sequence) => this.input.notePromptMarker(sequence)
  )

  constructor(private readonly getShellPath: () => string | undefined) {}

  observe(data: string): void {
    this.tracker.observe(data)
  }

  /** Every write heading for this shell's stdin, so a typed line outlives its renderer. */
  noteWrite(data: string): void {
    this.input.noteWrite(data)
  }

  read(): ShellPromptState {
    return resolveShellPromptState(this.tracker, this.trust())
  }

  /**
   * Whether a line is waiting at the prompt. A shell Orca never instrumented cannot retire
   * this state, so it must not claim to hold it either — an unsupported shell answers
   * `undefined`, which its readers treat as unknown rather than as an empty line.
   */
  readInputSincePrompt(): ShellInputSincePrompt | undefined {
    return this.trust() === 'none' ? undefined : this.input.read()
  }

  private trust() {
    return shellPromptMarkerTrust(this.getShellPath(), process.platform)
  }
}
