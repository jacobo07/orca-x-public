// Hands a resolved delivery to the surface it names, and to nothing else.
//
// Split out of the session route so the dispatch can be driven directly. The
// capture and resolve halves were already behaviourally pinned; this step was
// reachable only by reading [worktreeId].tsx as a string, so severing it reddened
// a source assertion while every behavioural case stayed green. A caller can now
// compose this with the real drafts hook and watch the words land on the captured
// tab -- the seam the original defect shipped through.
//
// It decides nothing about WHICH surface owns the transcript: resolveDictationDelivery
// already did that, from a target captured before ASR began. This only routes.
//
// A transcript that reaches no surface -- nothing was captured, or the captured PTY
// did not take the bytes -- is SALVAGED: handed to a durable store and the user is
// told. It is never re-aimed at another surface and never submitted.

import type { DictationDelivery } from './mobile-dictation-delivery'

export type DictationSalvageReason = 'no-target' | 'not-landed'

export interface DictationDeliveryHandlers {
  /** Fold text into the composer named by the CAPTURED key, never the current tab. */
  readonly appendToCapturedChatDraft: (
    draftKey: string,
    append: (current: string) => string
  ) => void
  /** Type into the captured PTY. Resolves true when the bytes actually landed. */
  readonly insertIntoLiveTerminal: (handle: string, text: string) => Promise<boolean>
  readonly appendToCommandField: (append: (current: string) => string) => void
  readonly notifyInserted: () => void
  /** A transcript that never had a destination is not one that went somewhere quietly. */
  readonly notifyNoTarget: () => void
  /** Keep text that reached no surface. Resolves true only when it is durably kept. */
  readonly salvageTranscript: (text: string) => Promise<boolean>
  /** Tell the user where the words went (or that keeping them failed). */
  readonly notifySalvaged: (outcome: {
    readonly reason: DictationSalvageReason
    readonly kept: boolean
  }) => void
}

function salvage(
  handlers: DictationDeliveryHandlers,
  text: string,
  reason: DictationSalvageReason
): void {
  if (text.trim() === '') {
    if (reason === 'no-target') {
      handlers.notifyNoTarget()
    }
    return
  }
  void handlers.salvageTranscript(text).then(
    (kept) => handlers.notifySalvaged({ reason, kept }),
    () => handlers.notifySalvaged({ reason, kept: false })
  )
}

export function dispatchDictationDelivery(
  delivery: DictationDelivery,
  append: (current: string, transcript: string) => string,
  handlers: DictationDeliveryHandlers
): void {
  if (delivery.kind === 'refused') {
    salvage(handlers, delivery.text, 'no-target')
    return
  }
  if (delivery.kind === 'native-chat') {
    handlers.appendToCapturedChatDraft(delivery.draftKey, (current) =>
      append(current, delivery.text)
    )
    handlers.notifyInserted()
    return
  }
  if (delivery.kind === 'terminal-live') {
    const { handle, text } = delivery
    // Why not awaited: the transcript callback is synchronous, and a flush that
    // never resolves must not hold it.
    void handlers.insertIntoLiveTerminal(handle, text).then(
      (landed) => {
        if (landed) {
          handlers.notifyInserted()
          return
        }
        salvage(handlers, text, 'not-landed')
      },
      () => salvage(handlers, text, 'not-landed')
    )
    return
  }
  handlers.appendToCommandField((current) => append(current, delivery.text))
  handlers.notifyInserted()
}
