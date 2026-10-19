import { buildTerminalShortcutKey, type TerminalAccessoryKey } from './terminal-accessory-keys'

export type StickyCtrlState = 'off' | 'armed' | 'locked'

export type StickyCtrlSend = {
  readonly bytes: string
  readonly next: StickyCtrlState
}

export function tapStickyCtrl(state: StickyCtrlState): StickyCtrlState {
  return state === 'off' ? 'armed' : state === 'armed' ? 'locked' : 'off'
}

function consume(state: StickyCtrlState): StickyCtrlState {
  return state === 'locked' ? 'locked' : 'off'
}

export function applyStickyCtrlToAccessoryKey(
  state: StickyCtrlState,
  key: Pick<TerminalAccessoryKey, 'id' | 'bytes'>
): StickyCtrlSend {
  if (state === 'off') {
    return { bytes: key.bytes, next: 'off' }
  }
  // Why: built-ins that are already chords (ctrlC…) have no special-key id, so the builder declines and their own bytes go out.
  const chord = buildTerminalShortcutKey({ key: key.id, modifiers: ['ctrl'] })
  return { bytes: chord?.bytes ?? key.bytes, next: consume(state) }
}

/** A field change Ctrl takes over; offline it takes nothing, so local composing keeps every character (#6713). */
export function claimCtrlTyping(args: {
  readonly state: StickyCtrlState
  readonly canSend: boolean
  readonly previous: string
  readonly next: string
}): StickyCtrlSend | null {
  if (!args.canSend) {
    return null
  }
  return applyStickyCtrlToTypedText(args.state, typedAppend(args.previous, args.next))
}

/** The Ctrl key is disabled while nothing can be sent, so an engaged Ctrl must not outlive that. */
export function stickyCtrlForSendability(
  state: StickyCtrlState,
  canSend: boolean
): StickyCtrlState {
  return canSend ? state : 'off'
}

/** What a field change appended at the end, or '' when it was an edit, deletion or replacement. */
export function typedAppend(previous: string, next: string): string {
  return next.length > previous.length && next.startsWith(previous)
    ? next.slice(previous.length)
    : ''
}

/** Claims only one typed ASCII character; a paste, a dictated phrase or an IME commit is left to the normal input path. */
export function applyStickyCtrlToTypedText(
  state: StickyCtrlState,
  text: string
): StickyCtrlSend | null {
  if (state === 'off' || text.length !== 1 || text < ' ' || text > '~') {
    return null
  }
  const chord = buildTerminalShortcutKey({ key: text, modifiers: ['ctrl'] })
  return { bytes: chord?.bytes ?? text, next: consume(state) }
}
