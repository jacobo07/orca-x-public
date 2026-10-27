import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

/**
 * Where a shell stands by its own OSC 133 markers. `unsupported` is the
 * authority's answer for a shell Orca never injects markers into (Git Bash, WSL).
 */
export type ShellPromptState = 'prompt' | 'running' | 'unknown' | 'unsupported'

/**
 * Whether user input has reached the shell since its last prompt marker. `typed` is a line the
 * respawn would destroy; `clean` is a prompt nobody has typed at since it was drawn. There is no
 * third value: an authority that cannot tell omits the field, because unknown is not `clean`.
 */
export type ShellInputSincePrompt = 'typed' | 'clean'

/** Appended to the A/D markers of a PowerShell whose commands also emit 133;C. */
export const ORCA_PROMPT_MARKER_TAG = 'orca'

/**
 * Who vouches for a shell's prompt: nobody (no Orca integration), any A/D marker (the
 * zsh/bash rcfiles), or only Orca-tagged ones (PowerShell, where nested shells and a
 * missing readline hook would otherwise read as idle over a running command).
 */
export type ShellPromptMarkerTrust = 'none' | 'any' | 'tagged'

export type ShellPromptStateTracker = {
  /** Feed every output chunk of one shell process, in order. */
  observe: (data: string) => void
  /**
   * The host itself submitted a command line (cmd.exe emits no 133;C). Running until a D: the
   * shell may draw its first prompt after accepting the queued line, and that A proves nothing.
   */
  noteSubmittedCommand: () => void
  read: () => Exclude<ShellPromptState, 'unsupported'>
}

function isTagged(payload: string): boolean {
  return payload.split(';').slice(1).includes(ORCA_PROMPT_MARKER_TAG)
}

/**
 * Remembers the last OSC 133 marker of one shell process. Why a process-side
 * record: a reattached shell drew its prompt before the current app existed,
 * so only whoever saw every byte can say it is still sitting there.
 */
export function createShellPromptStateTracker(
  getTrust: () => ShellPromptMarkerTrust = () => 'any',
  /**
   * Called with the marker letter only when this tracker HONOURS it, so a caller that retires
   * its own state on a prompt retires it on exactly the markers that moved this one — never on
   * an untrusted prompt this tracker itself refused to believe.
   */
  onHonouredMarker?: (sequence: string) => void
): ShellPromptStateTracker {
  let state: Exclude<ShellPromptState, 'unsupported'> = 'unknown'
  let awaitingFinish = false
  // Why: any C means work may be running; only a trusted A/D may say it stopped.
  const onMarker = (payload: string): void => {
    const sequence = payload.split(';')[0]
    if (sequence === 'C') {
      state = 'running'
      onHonouredMarker?.('C')
      return
    }
    if (sequence !== 'A' && sequence !== 'D') {
      return
    }
    if (sequence === 'A' && awaitingFinish) {
      return
    }
    const trust = getTrust()
    if (trust === 'any' || (trust === 'tagged' && isTagged(payload))) {
      awaitingFinish = false
      state = 'prompt'
      onHonouredMarker?.(sequence)
    }
  }
  const scanner = createOsc133CommandFinishedScanner(() => {}, undefined, undefined, onMarker)
  return {
    observe: scanner.scan,
    noteSubmittedCommand: () => {
      awaitingFinish = true
      state = 'running'
      onHonouredMarker?.('C')
    },
    read: () => state
  }
}

function executableName(shellPath: string): string {
  return (shellPath.split(/[\\/]/).pop() ?? '').toLowerCase()
}

/**
 * Whether Orca injects OSC 133 into this shell: the PowerShell bootstrap and cmd.exe's PROMPT
 * on Windows, the zsh/bash rcfile wrappers elsewhere (Windows bash is Git Bash, which gets none).
 */
export function shellPromptMarkerTrust(
  shellPath: string | null | undefined,
  platform: string
): ShellPromptMarkerTrust {
  if (!shellPath) {
    return 'none'
  }
  const name = executableName(shellPath).replace(/\.exe$/, '')
  if (name === 'powershell' || name === 'pwsh') {
    return 'tagged'
  }
  // Why tagged: cmd has no pre-exec hook, so only Orca's own PROMPT may vouch; a nested cmd
  // inherits that PROMPT, which is why busy also rests on the host-held input line.
  if (platform === 'win32' && name === 'cmd') {
    return 'tagged'
  }
  if (platform === 'win32') {
    return 'none'
  }
  return name === 'zsh' || name === 'bash' ? 'any' : 'none'
}

/** A shell without Orca's integration never vouches for its prompt, whatever it prints. */
export function resolveShellPromptState(
  tracker: ShellPromptStateTracker,
  trust: ShellPromptMarkerTrust
): ShellPromptState {
  return trust === 'none' ? 'unsupported' : tracker.read()
}
