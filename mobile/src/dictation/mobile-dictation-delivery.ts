// Decides which surface a finished transcript is inserted into.
//
// The decision is made once, when recording starts, and this module is the only
// thing that reads it. resolveDictationDelivery deliberately takes no current
// surface state: a transcript cannot be retargeted by anything the user does
// while ASR is still running, because nothing that moves is in scope here.
//
// A target names a surface INSTANCE, never a surface kind. A terminal is its
// handle; a chat composer is its draft key (host + worktree + tab), which is the
// same identity the send path captures in MobileNativeChatSendOrigin. Recording
// only "the chat" would leave the tab to be re-derived at delivery, and both
// tabs follow a chat default -- so switching tabs during ASR would carry the
// words into another agent's composer.
//
// Subject validity is NOT decided here. A captured terminal that has since gone
// away is the send path's answer to give -- it already reports whether the bytes
// landed -- and a second liveness oracle here could only disagree with it.

export type DictationTarget =
  | { readonly surface: 'native-chat'; readonly draftKey: string }
  | {
      readonly surface: 'terminal'
      readonly handle: string
      readonly liveInputEnabled: boolean
    }

export type DictationDelivery =
  | { readonly kind: 'native-chat'; readonly draftKey: string; readonly text: string }
  | { readonly kind: 'terminal-live'; readonly handle: string; readonly text: string }
  | { readonly kind: 'command-field'; readonly text: string }
  // Nothing was captured when recording started, so there is no subject to
  // deliver to. Distinct from a delivery that reached a surface and failed:
  // this one never had a destination, and the caller must say so rather than
  // choosing one now.
  | { readonly kind: 'refused'; readonly reason: 'no-target-captured' }

export function captureDictationTarget(surfaces: {
  readonly nativeChatVisible: boolean
  readonly nativeChatDraftKey: string | null
  readonly activeHandle: string | null
  readonly liveInputEnabled: boolean
}): DictationTarget | null {
  if (surfaces.nativeChatVisible) {
    // A chat with no draft key is a composer we cannot name. Capturing it as
    // "the chat" would hand the tab back to delivery-time state, which is the
    // retarget this module exists to make unreachable.
    return surfaces.nativeChatDraftKey
      ? { surface: 'native-chat', draftKey: surfaces.nativeChatDraftKey }
      : null
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
    return { kind: 'native-chat', draftKey: target.draftKey, text }
  }
  if (target.liveInputEnabled) {
    return { kind: 'terminal-live', handle: target.handle, text }
  }
  return { kind: 'command-field', text }
}
