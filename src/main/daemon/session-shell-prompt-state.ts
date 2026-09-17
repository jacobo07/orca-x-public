import {
  createShellPromptStateTracker,
  resolveShellPromptState,
  shellPromptMarkerTrust,
  type ShellPromptState
} from '../../shared/terminal-osc133-prompt-state'

/** One shell process's own last OSC 133 marker; survives any client or app restart. */
export class SessionShellPromptState {
  private readonly tracker = createShellPromptStateTracker(() => this.trust())

  constructor(private readonly getShellPath: () => string | undefined) {}

  observe(data: string): void {
    this.tracker.observe(data)
  }

  read(): ShellPromptState {
    return resolveShellPromptState(this.tracker, this.trust())
  }

  private trust() {
    return shellPromptMarkerTrust(this.getShellPath(), process.platform)
  }
}
