import { win32 as pathWin32 } from 'node:path'
import { ORCA_PROMPT_MARKER_TAG } from '../../shared/terminal-osc133-prompt-state'

// Why ST ($e\): cmd's PROMPT has no BEL code. No marker ends the string, because node-pty
// doubles a trailing backslash before the closing quote it adds to a spaced argument.
const PROMPT_START = `$e]133;A;${ORCA_PROMPT_MARKER_TAG}$e\\`
// Why no exit code: cmd's PROMPT cannot print ERRORLEVEL, and a fake 0 would be a claim.
const COMMAND_FINISHED = `$e]133;D;;${ORCA_PROMPT_MARKER_TAG}$e\\`

/**
 * The first prompt, drawn before anything ran: a tagged A only. A D here would tell every
 * reader a command finished before Orca's own startup command was even typed, retiring the
 * launch identity of the agent it is about to start.
 */
export const CMD_PROMPT_BEFORE_ANY_COMMAND = `prompt ${PROMPT_START}%PROMPT%`

/** Last in the /K line, where %PROMPT% still expands to the user's own prompt. */
export const CMD_PROMPT_AFTER_EMBEDDED_STARTUP = `prompt ${COMMAND_FINISHED}${PROMPT_START}%PROMPT%`

// Why D only: typed at an interactive prompt, %PROMPT% already carries the A marker.
const CMD_PROMPT_AFTER_TYPED_STARTUP = `prompt ${COMMAND_FINISHED}%PROMPT%`

export function isCmdShellPath(shellPath: string | null | undefined): boolean {
  if (!shellPath) {
    return false
  }
  const name = pathWin32.basename(shellPath).toLowerCase()
  return name === 'cmd.exe' || name === 'cmd'
}

/**
 * cmd.exe has no pre-exec hook, so it can never say a command started or finished. Orca's
 * own startup command is the one it can bracket: the line installs the D-bearing prompt
 * after it, so the prompt drawn when the command returns is the proof that it finished.
 */
export function withCmdCommandFinishedPrompt(
  command: string,
  shellPath: string | null | undefined
): string {
  // Why single-line only: a multiline startup submits line by line, so a suffix would run early.
  if (!isCmdShellPath(shellPath) || /[\r\n]/.test(command)) {
    return command
  }
  return `${command} & ${CMD_PROMPT_AFTER_TYPED_STARTUP}`
}
