import type { PtyProcessInspection } from '../../../shared/pty-process-inspection'

export type PaneShellIdleVerdict =
  | 'idle'
  | 'busy'
  | 'unconfirmed'
  | 'unsupported'
  | 'host-outdated'
  | 'unsent-input'

/**
 * Fresh check, just before a respawn destroys the pane's shell, that the shell is at its
 * prompt. Why the markers are required: on Windows the process half names the shell for
 * any non-agent command, so only the shell's own 133;C proves a command is running.
 */
export async function checkPaneShellIdle(args: {
  getPtyId: () => string | null
  inspect: (ptyId: string) => Promise<PtyProcessInspection>
  /** True while the pane has taken user input that no command start or fresh prompt has
   *  since consumed — so the shell's line may hold text the respawn would destroy. */
  hasUnsentInput?: () => boolean
}): Promise<PaneShellIdleVerdict> {
  const ptyId = args.getPtyId()
  if (!ptyId) {
    return 'unconfirmed'
  }
  let inspection: PtyProcessInspection
  try {
    inspection = await args.inspect(ptyId)
  } catch {
    return 'unconfirmed'
  }
  if (args.getPtyId() !== ptyId || inspection.unavailable === true) {
    return 'unconfirmed'
  }
  if (inspection.hasChildProcesses || inspection.promptState === 'running') {
    return 'busy'
  }
  if (inspection.promptState === 'unsupported') {
    return 'unsupported'
  }
  // Why absent is not idle: a host that predates marker tracking cannot tell, and says so.
  if (inspection.promptState === undefined) {
    return 'host-outdated'
  }
  if (inspection.promptState !== 'prompt') {
    return 'unconfirmed'
  }
  // Why after the prompt proof: a typed line only exists at a prompt, and a busy shell
  // has a louder reason to refuse. Markers cannot see the line editor, so this is
  // deliberately conservative — it refuses input the user may already have cleared.
  //
  // Why two sources: the host saw every byte and still knows after this renderer reloaded,
  // while the renderer knows about writes that never reached the host's own input path. So
  // either may refuse, and the renderer's answer can only ADD safety, never withdraw it.
  if (inspection.inputSincePrompt === 'typed' || args.hasUnsentInput?.() === true) {
    return 'unsent-input'
  }
  // Why absent is not clean: a host that predates input tracking cannot see the line, and
  // silence about a draft is not evidence there is none. Same remedy as any outdated host.
  if (inspection.inputSincePrompt === undefined) {
    return 'host-outdated'
  }
  return 'idle'
}
