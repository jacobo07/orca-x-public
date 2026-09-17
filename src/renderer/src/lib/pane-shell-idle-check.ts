import type { PtyProcessInspection } from '../../../shared/pty-process-inspection'

export type PaneShellIdleVerdict = 'idle' | 'busy' | 'unconfirmed' | 'unsupported' | 'host-outdated'

/**
 * Fresh check, just before a respawn destroys the pane's shell, that the shell is at its
 * prompt. Why the markers are required: on Windows the process half names the shell for
 * any non-agent command, so only the shell's own 133;C proves a command is running.
 */
export async function checkPaneShellIdle(args: {
  getPtyId: () => string | null
  inspect: (ptyId: string) => Promise<PtyProcessInspection>
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
  return inspection.promptState === 'prompt' ? 'idle' : 'unconfirmed'
}
