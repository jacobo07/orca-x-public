// Decides which surface a finished transcript is inserted into.
//
// CHARACTERIZATION of the behaviour that shipped in the session screen. It is
// extracted here unchanged, retargets included, so the defect is testable before
// it is fixed. `current` is the mutable state read at delivery time; every field
// on it is a retarget path, and the next commit removes them.

export type DictationCapturedTarget = {
  readonly handle: string
  readonly liveInputEnabled: boolean
} | null

export type DictationCurrentSurfaces = {
  readonly nativeChatVisible: boolean
  readonly liveInputEnabled: boolean
  readonly activeHandle: string | null
}

export type DictationDelivery =
  | { readonly kind: 'native-chat'; readonly text: string }
  | { readonly kind: 'terminal-live'; readonly handle: string; readonly text: string }
  | { readonly kind: 'command-field'; readonly text: string }
  // The screen returns without a toast when it has no handle, so a dropped
  // transcript is indistinguishable from an inserted one at the call site.
  | { readonly kind: 'dropped'; readonly reason: 'no-terminal-handle' }

export function resolveDictationDelivery(
  text: string,
  captured: DictationCapturedTarget,
  current: DictationCurrentSurfaces
): DictationDelivery {
  if (current.nativeChatVisible) {
    return { kind: 'native-chat', text }
  }
  const liveInputEnabled = captured?.liveInputEnabled ?? current.liveInputEnabled
  if (!liveInputEnabled) {
    return { kind: 'command-field', text }
  }
  const handle = captured?.handle ?? current.activeHandle
  if (!handle) {
    return { kind: 'dropped', reason: 'no-terminal-handle' }
  }
  return { kind: 'terminal-live', handle, text }
}
