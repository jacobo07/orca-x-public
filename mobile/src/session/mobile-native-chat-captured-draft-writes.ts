// Writes addressed to a composer that was captured earlier, rather than to
// whichever tab is current when the write happens.
//
// Every write here takes its draft key as an argument. That is the whole point:
// a send captures its origin before the RPC, and a dictation captures its draft
// key before ASR, because both settle at a moment when the user may be looking
// at a different tab. A writer that read the live draft key would land the text
// on another agent's composer -- the leak mobile-native-chat-scope-key.ts
// documents as impossible.
//
// Pure record -> record, so the ownership rule can be tested without a renderer.

import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'

export type NativeChatDrafts = Record<string, string>

/** Clear at send time, but only if the composer still holds what was sent. */
export function clearCapturedDraft(
  drafts: NativeChatDrafts,
  draftKey: string,
  text: string
): NativeChatDrafts {
  return (drafts[draftKey] ?? '').trim() === text.trim() ? { ...drafts, [draftKey]: '' } : drafts
}

/** Put text back after a definite rejection, never clobbering newer typing. */
export function restoreCapturedDraft(
  drafts: NativeChatDrafts,
  draftKey: string,
  text: string
): NativeChatDrafts {
  return (drafts[draftKey] ?? '') === '' ? { ...drafts, [draftKey]: text } : drafts
}

/** Fold new text into a captured composer, leaving the record alone on no-op. */
export function appendToCapturedDraft(
  drafts: NativeChatDrafts,
  draftKey: string,
  append: (current: string) => string
): NativeChatDrafts {
  const current = drafts[draftKey] ?? ''
  const next = append(current)
  return next === current ? drafts : { ...drafts, [draftKey]: next }
}

/** The three writes bound to one drafts setter. Each names its own key, so none
 *  can be re-pointed by a tab switch between capture and settlement. */
/** Durable-draft hooks: a user edit is persisted; the send-time clear only flushes. */
export type CapturedDraftPersistence = {
  readonly markUserEdit: (draftKey: string) => void
  readonly flushPendingSave: (draftKey: string) => void
}

const NO_PERSISTENCE: CapturedDraftPersistence = {
  markUserEdit: () => {},
  flushPendingSave: () => {}
}

export function useCapturedDraftWrites(
  setDrafts: Dispatch<SetStateAction<NativeChatDrafts>>,
  persistence: CapturedDraftPersistence = NO_PERSISTENCE
): {
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  appendDictationToDraft: (capturedDraftKey: string, append: (current: string) => string) => void
} {
  const { markUserEdit, flushPendingSave } = persistence
  // Why: over relay the send RPC can take seconds (or lose only its ack), and a
  // composer that waits for settlement to empty reads as "my prompt didn't
  // send". Clear at send time; a definite rejection restores the text.
  // The clear is NOT a user edit: the RPC can still be rejected, so the durable
  // copy must outlive it until the send is confirmed.
  const clearDraftForSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string) => {
      flushPendingSave(origin.draftKey)
      setDrafts((previous) => clearCapturedDraft(previous, origin.draftKey, text))
    },
    [flushPendingSave, setDrafts]
  )

  const restoreRejectedDraft = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string) => {
      markUserEdit(origin.draftKey)
      setDrafts((previous) => restoreCapturedDraft(previous, origin.draftKey, text))
    },
    [markUserEdit, setDrafts]
  )

  // Why: dictation captures its composer when recording starts, so the write must
  // name that draft key rather than whichever tab is current when ASR finishes.
  const appendDictationToDraft = useCallback(
    (capturedDraftKey: string, append: (current: string) => string) => {
      markUserEdit(capturedDraftKey)
      setDrafts((previous) => appendToCapturedDraft(previous, capturedDraftKey, append))
    },
    [markUserEdit, setDrafts]
  )

  return { clearDraftForSend, restoreRejectedDraft, appendDictationToDraft }
}
