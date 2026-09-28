// Mirrors user-typed chat composer text into a durable store so it survives the
// process, and offers it back into an empty composer on the next mount.
//
// Only writes the user made are persisted (typing, dictation, a rejected send put
// back). The send-time clear is deliberately NOT persisted: the RPC can still be
// rejected, so the stored copy is cleared only once a send is confirmed. A restored
// draft only ever lands in the composer; nothing here submits.
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useCapturedDraftWrites } from './mobile-native-chat-captured-draft-writes'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'
import type {
  DraftClearOutcome,
  DraftIdentity,
  DraftLoadOutcome,
  DraftSaveOutcome
} from '../storage/draft-journal'

export type MobileNativeChatDraftStore = {
  readonly load: (identity: DraftIdentity) => Promise<DraftLoadOutcome>
  readonly save: (identity: DraftIdentity, text: string) => Promise<DraftSaveOutcome>
  readonly clearAfterConfirmed: (
    identity: DraftIdentity,
    confirmedText: string
  ) => Promise<DraftClearOutcome>
}

export type MobileNativeChatDraftPersistenceIssue =
  | { readonly kind: 'restore-unreadable' }
  | { readonly kind: 'restore-failed' | 'save-failed' | 'clear-failed'; readonly error: Error }

export const CHAT_DRAFT_SAVE_DEBOUNCE_MS = 300

export function chatDraftIdentity(
  hostId: string,
  worktreeId: string,
  tabId: string
): DraftIdentity {
  return { surface: 'chat-composer', hostId, worktreeId, subjectId: tabId }
}

export function useMobileNativeChatDraftPersistence(args: {
  store: MobileNativeChatDraftStore | undefined
  hostId: string
  worktreeId: string
  tabId: string | null
  draftKey: string | null
  drafts: Record<string, string>
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>
  onIssue?: (issue: MobileNativeChatDraftPersistenceIssue) => void
}): {
  markUserEdit: (draftKey: string) => void
  flushPendingSave: (draftKey: string) => void
  settleSentDraft: (draftKey: string, text: string) => void
} {
  const { store, hostId, worktreeId, tabId, draftKey, drafts, setDrafts, onIssue } = args
  const identityByKeyRef = useRef(new Map<string, DraftIdentity>())
  if (draftKey && tabId) {
    identityByKeyRef.current.set(draftKey, chatDraftIdentity(hostId, worktreeId, tabId))
  }
  const dirtyKeysRef = useRef(new Set<string>())
  const pendingSavesRef = useRef(
    new Map<string, { timer: ReturnType<typeof setTimeout>; text: string }>()
  )
  const loadedKeysRef = useRef(new Set<string>())
  const mountedRef = useRef(false)
  const storeRef = useRef(store)
  storeRef.current = store
  const onIssueRef = useRef(onIssue)
  onIssueRef.current = onIssue

  const runSave = useCallback((key: string, text: string) => {
    const identity = identityByKeyRef.current.get(key)
    const current = storeRef.current
    if (!identity || !current) {
      return
    }
    void current.save(identity, text).then((outcome) => {
      if (outcome.kind === 'failed') {
        onIssueRef.current?.({ kind: 'save-failed', error: outcome.error })
      }
    })
  }, [])

  const flushPendingSave = useCallback(
    (key: string) => {
      const pending = pendingSavesRef.current.get(key)
      if (!pending) {
        return
      }
      clearTimeout(pending.timer)
      pendingSavesRef.current.delete(key)
      runSave(key, pending.text)
    },
    [runSave]
  )

  const markUserEdit = useCallback((key: string) => {
    dirtyKeysRef.current.add(key)
  }, [])

  const settleSentDraft = useCallback(
    (key: string, text: string) => {
      const identity = identityByKeyRef.current.get(key)
      const current = storeRef.current
      if (!identity || !current) {
        return
      }
      // Why: a debounced save of the sent text must reach the journal before the
      // clear, or it would resurrect the draft the clear just removed.
      flushPendingSave(key)
      void current.clearAfterConfirmed(identity, text).then((outcome) => {
        if (outcome.kind === 'failed') {
          onIssueRef.current?.({ kind: 'clear-failed', error: outcome.error })
        }
      })
    },
    [flushPendingSave]
  )

  useEffect(() => {
    if (!store || dirtyKeysRef.current.size === 0) {
      return
    }
    for (const key of dirtyKeysRef.current) {
      const text = drafts[key] ?? ''
      const previous = pendingSavesRef.current.get(key)
      if (previous) {
        clearTimeout(previous.timer)
      }
      const timer = setTimeout(() => {
        pendingSavesRef.current.delete(key)
        runSave(key, text)
      }, CHAT_DRAFT_SAVE_DEBOUNCE_MS)
      pendingSavesRef.current.set(key, { timer, text })
    }
    dirtyKeysRef.current.clear()
  }, [drafts, runSave, store])

  // Restore once per key per mount, only into an empty composer: anything the
  // user or a launch seed already put there wins over the stored copy.
  useEffect(() => {
    if (!store || !draftKey || !tabId || loadedKeysRef.current.has(draftKey)) {
      return
    }
    loadedKeysRef.current.add(draftKey)
    const key = draftKey
    // Why no per-key cancel: the write names its own key, so a result landing after
    // a tab switch still restores the tab it was loaded for.
    void store.load(chatDraftIdentity(hostId, worktreeId, tabId)).then((outcome) => {
      if (outcome.kind === 'unreadable') {
        onIssueRef.current?.({ kind: 'restore-unreadable' })
        return
      }
      if (outcome.kind === 'failed') {
        onIssueRef.current?.({ kind: 'restore-failed', error: outcome.error })
        return
      }
      if (outcome.kind !== 'draft' || !mountedRef.current) {
        return
      }
      const restored = outcome.draft.text
      setDrafts((previous) =>
        (previous[key] ?? '') === '' ? { ...previous, [key]: restored } : previous
      )
    })
  }, [draftKey, hostId, setDrafts, store, tabId, worktreeId])

  // Unmount is not process death: write what is pending rather than drop it.
  useEffect(() => {
    mountedRef.current = true
    const pendingSaves = pendingSavesRef.current
    return () => {
      mountedRef.current = false
      for (const [key, pending] of pendingSaves) {
        clearTimeout(pending.timer)
        runSave(key, pending.text)
      }
      pendingSaves.clear()
    }
  }, [runSave])

  return { markUserEdit, flushPendingSave, settleSentDraft }
}

export type MobileNativeChatDraftPersistenceOptions = {
  /** Durable copy of user-typed drafts. Absent = memory only (process death loses them). */
  draftStore?: MobileNativeChatDraftStore
  onDraftPersistenceIssue?: (issue: MobileNativeChatDraftPersistenceIssue) => void
}

/** The captured-key composer writes, with user edits persisted and confirmed
 *  sends retiring the durable copy. */
export function usePersistedCapturedDraftWrites(
  args: MobileNativeChatDraftPersistenceOptions & {
    hostId: string
    worktreeId: string
    tabId: string | null
    draftKey: string | null
    drafts: Record<string, string>
    setDrafts: Dispatch<SetStateAction<Record<string, string>>>
  }
): ReturnType<typeof useCapturedDraftWrites> & {
  setComposerText: Dispatch<SetStateAction<string>>
  settleSentDraftKey: (draftKey: string, text: string) => void
  settleSentDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
} {
  const {
    markUserEdit,
    flushPendingSave,
    settleSentDraft: settleSentDraftKey
  } = useMobileNativeChatDraftPersistence({
    ...args,
    store: args.draftStore,
    onIssue: args.onDraftPersistenceIssue
  })
  const { draftKey, setDrafts } = args
  const writes = useCapturedDraftWrites(setDrafts, { markUserEdit, flushPendingSave })
  const settleSentDraft = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string) => settleSentDraftKey(origin.draftKey, text),
    [settleSentDraftKey]
  )
  // The composer's own typing: always the CURRENT tab's draft, and a user edit.
  const setComposerText: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      if (!draftKey) {
        return
      }
      markUserEdit(draftKey)
      setDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = typeof value === 'function' ? value(current) : value
        return next === current ? previous : { ...previous, [draftKey]: next }
      })
    },
    [draftKey, markUserEdit, setDrafts]
  )
  return { ...writes, setComposerText, settleSentDraftKey, settleSentDraft }
}
