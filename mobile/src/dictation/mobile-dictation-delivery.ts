// Decides which surface a finished transcript is inserted into.
//
// The decision is made once, when recording starts, and this module is the only
// thing that reads it. resolveDictationDelivery deliberately takes no current
// surface state: a transcript cannot be retargeted by anything the user does
// while ASR is still running, because nothing that moves is in scope here.
//
// Subject validity is NOT decided here. A captured terminal that has since gone
// away is the send path's answer to give -- it already reports whether the bytes
// landed -- and a second liveness oracle here could only disagree with it.

export type DictationTarget =
  | { readonly surface: 'native-chat' }
  | {
      readonly surface: 'terminal'
      readonly handle: string
      readonly liveInputEnabled: boolean
    }

export type DictationDelivery =
  | { readonly kind: 'native-chat'; readonly text: string }
  | { readonly kind: 'terminal-live'; readonly handle: string; readonly text: string }
  | { readonly kind: 'command-field'; readonly text: string }
  // Nothing was captured when recording started, so there is no subject to
  // deliver to. Distinct from a delivery that reached a surface and failed:
  // this one never had a destination, and the caller must say so rather than
  // choosing one now.
  | { readonly kind: 'refused'; readonly reason: 'no-target-captured' }

export function captureDictationTarget(surfaces: {
  readonly nativeChatVisible: boolean
  readonly activeHandle: string | null
  readonly liveInputEnabled: boolean
}): DictationTarget | null {
  if (surfaces.nativeChatVisible) {
    return { surface: 'native-chat' }
  }
  if (!surfaces.activeHandle) {
    return null
  }
  return {
    surface: 'terminal',
    handle: surfaces.activeHandle,
    liveInputEnabled: surfaces.liveInputEnabled
  }
}

export function resolveDictationDelivery(
  text: string,
  target: DictationTarget | null
): DictationDelivery {
  if (!target) {
    return { kind: 'refused', reason: 'no-target-captured' }
  }
  if (target.surface === 'native-chat') {
    return { kind: 'native-chat', text }
  }
  if (target.liveInputEnabled) {
    return { kind: 'terminal-live', handle: target.handle, text }
  }
  return { kind: 'command-field', text }
}
