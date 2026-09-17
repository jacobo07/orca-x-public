import type { ShellInputSincePrompt } from './terminal-osc133-prompt-state'

const ESC = ''

/**
 * Sequences a terminal emits on its own behalf, not because anyone typed: focus in/out,
 * cursor-position and device-status reports, device attributes, DECRQM mode reports, and
 * OSC colour replies.
 *
 * Why an exclusion list rather than an inclusion list: the failure directions are not
 * symmetric. A shape missed here reads as typing, which refuses a respawn the user could
 * have had — annoying, and safe. A shape wrongly listed here reads as silence, which
 * destroys a line the user typed. So only sequences that cannot carry user intent are
 * listed, and anything unrecognised counts as the user.
 */
const AUTO_REPLY_PATTERNS: readonly RegExp[] = [
  /^\[[IO]$/, // focus in / focus out
  /^\[\d*(;\d+)*R$/, // cursor position report
  /^\[\d*n$/, // device status report
  /^\[[?>]?[\d;]*c$/, // primary / secondary device attributes
  /^\[\?[\d;]*\$y$/, // DECRQM mode report
  /^\][0-9]+;[^]*(|\\)$/ // OSC reply (colour, title)
]

/**
 * True only when the write is WHOLLY one reply. A chunk that merely contains one still
 * carries whatever else the user sent with it.
 */
export function isTerminalAutoReply(data: string): boolean {
  if (data === '' || !data.startsWith(ESC)) {
    return false
  }
  return AUTO_REPLY_PATTERNS.some((pattern) => pattern.test(data))
}

export type ShellInputSincePromptTracker = {
  /** Feed every write heading for this shell's stdin, in order. */
  noteWrite: (data: string) => void
  /** Feed the OSC 133 sequence letter the shell just emitted. */
  notePromptMarker: (sequence: string) => void
  read: () => ShellInputSincePrompt
}

/**
 * Whether a shell holds a line nobody has submitted, kept beside whoever owns the pty.
 *
 * Why it lives here and not in the renderer: the renderer's copy dies with the renderer,
 * while the shell it describes does not — so after a reload only this side still knows the
 * user had typed. It cannot read the line editor, so `typed` means "input arrived and no
 * marker has since retired it", which deliberately over-refuses a line the user cleared by
 * hand. Clearing that state needs the shell's own word, and Esc or ctrl+u are silent.
 */
export function createShellInputSincePromptTracker(): ShellInputSincePromptTracker {
  let typed = false
  return {
    noteWrite: (data) => {
      if (!isTerminalAutoReply(data)) {
        typed = true
      }
    },
    // Why C and a fresh prompt both clear: a command start means the line was submitted, and
    // A or D means the shell drew a new prompt over whatever was there. B is the start of the
    // command region within one prompt and retires nothing.
    notePromptMarker: (sequence) => {
      if (sequence === 'C' || sequence === 'A' || sequence === 'D') {
        typed = false
      }
    },
    read: () => (typed ? 'typed' : 'clean')
  }
}
