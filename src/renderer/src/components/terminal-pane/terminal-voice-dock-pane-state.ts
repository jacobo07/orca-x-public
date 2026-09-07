import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

// `terminal` is here so a dock can focus the pane it belongs to before starting
// a job. Optional because the reservation below has no use for it, and a pane
// fixture that only exercises reservation should not have to invent one.
export type TerminalVoiceDockPane = Pick<ManagedPane, 'id' | 'container'> &
  Partial<Pick<ManagedPane, 'terminal'>>

/**
 * Reserves the bottom strip each pane's voice dock occupies.
 *
 * Why reserve rather than float: the pane's other chrome controls are
 * reveal-on-hover, so they are absent from the pixels almost always and can sit
 * over row one. The dock is persistently visible by design — a control nobody
 * can find is not an affordance — so floating it would permanently cover the
 * bottom row, which is exactly where an agent TUI draws its prompt and status.
 *
 * Why there is no active-pane input: reserved geometry must not track focus. If
 * it did, every focus change would resize a PTY and SIGWINCH the TUI inside it.
 * Leaving focus out of the signature makes that structural instead of a rule to
 * remember. Which pane *shows* a recording state is a separate question, and
 * which pane *owns* a running job is a third one.
 *
 * Returns whether any reservation changed, so the caller re-fits only then.
 */
export function syncTerminalVoiceDockSpace(args: {
  panes: readonly TerminalVoiceDockPane[]
  isVoiceDockEnabled: boolean
}): boolean {
  let needsFit = false
  for (const pane of args.panes) {
    const hadDock = pane.container.hasAttribute('data-has-voice-dock')
    if (args.isVoiceDockEnabled && !hadDock) {
      pane.container.setAttribute('data-has-voice-dock', '')
      needsFit = true
    } else if (!args.isVoiceDockEnabled && hadDock) {
      pane.container.removeAttribute('data-has-voice-dock')
      needsFit = true
    }
  }
  return needsFit
}
