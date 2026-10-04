// Mirrors an unsaved file-preview edit into the durable draft journal so it survives
// the process, and offers it back as a dirty draft when the same file is reopened
// against the same host content. Nothing here saves to the host: a restored draft only
// lands in the editor's existing dirty state, where Save stays the user's act.
import { useEffect, useRef } from 'react'
import { sha256 } from '@noble/hashes/sha256'
import {
  loadDraft,
  saveDraft,
  type DraftIdentity,
  type DraftLoadOutcome
} from '../storage/draft-journal'

export const FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS = 300

export type EditorDraftSurface = 'file-preview' | 'markdown-editor'

export type FilePreviewDraftScope = {
  readonly hostId: string
  readonly worktreeId: string
  /** The host file path: it survives a relaunch, unlike a grant, terminal handle or tab id. */
  readonly subjectId: string
}

export type FilePreviewDraftIssue =
  | { readonly kind: 'restore-stale-base' | 'restore-unreadable' }
  | { readonly kind: 'restore-failed' | 'save-failed'; readonly error: Error }

export type FilePreviewDraftRestoreDecision =
  | { readonly kind: 'restore'; readonly text: string }
  | { readonly kind: 'no-draft' | 'stale-base' | 'unreadable' }
  | { readonly kind: 'failed'; readonly error: Error }

// Why a content hash: a host file read carries no revision, so the loaded text is the base.
export function filePreviewDraftBaseVersion(content: string): string {
  return Array.from(sha256(content), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Empty journal text removes the entry: a clean editor never offers a restore. */
function journalTextFor(draft: string, saved: string): string {
  return draft === saved ? '' : draft
}

export function decideFilePreviewDraftRestore(
  outcome: DraftLoadOutcome,
  loadedContent: string
): FilePreviewDraftRestoreDecision {
  if (outcome.kind === 'unreadable') {
    return { kind: 'unreadable' }
  }
  if (outcome.kind === 'failed') {
    return { kind: 'failed', error: outcome.error }
  }
  if (outcome.kind === 'none') {
    return { kind: 'no-draft' }
  }
  if (outcome.draft.baseVersion !== filePreviewDraftBaseVersion(loadedContent)) {
    return { kind: 'stale-base' }
  }
  return outcome.draft.text === loadedContent
    ? { kind: 'no-draft' }
    : { kind: 'restore', text: outcome.draft.text }
}

// Why a surface argument: the markdown doc editor journals through this same mechanism under its own surface.
function identityFor(scope: FilePreviewDraftScope, surface: EditorDraftSurface): DraftIdentity {
  return { surface, ...scope }
}

function scopeKey(scope: FilePreviewDraftScope): string {
  return JSON.stringify([scope.hostId, scope.worktreeId, scope.subjectId])
}

export function useMobileFilePreviewDraftJournal(args: {
  /** Null until the editable file's content has loaded. */
  scope: FilePreviewDraftScope | null
  surface?: EditorDraftSurface
  draftContent: string
  savedContent: string
  onRestore: (text: string) => void
  onIssue?: (issue: FilePreviewDraftIssue) => void
}): void {
  const { scope, surface = 'file-preview', draftContent, savedContent, onRestore, onIssue } = args
  const key = scope ? scopeKey(scope) : null
  const latestRef = useRef({ key, draftContent, savedContent, onRestore, onIssue })
  latestRef.current = { key, draftContent, savedContent, onRestore, onIssue }
  const restoredKeyRef = useRef<string | null>(null)
  // Removal is owed only for an entry this mount wrote or restored; a stale one is not ours.
  const ownsEntryRef = useRef(false)
  const pendingRef = useRef<{
    timer: ReturnType<typeof setTimeout>
    identity: DraftIdentity
    text: string
    baseVersion: string
  } | null>(null)

  const write = (identity: DraftIdentity, text: string, baseVersion: string) => {
    void saveDraft(identity, text, { baseVersion }).then((outcome) => {
      if (outcome.kind === 'failed') {
        latestRef.current.onIssue?.({ kind: 'save-failed', error: outcome.error })
      }
    })
  }

  const cancelPending = () => {
    if (pendingRef.current) {
      clearTimeout(pendingRef.current.timer)
      pendingRef.current = null
    }
  }

  // Unmount (or leaving the file) is not process death: write what is pending, do not drop it.
  useEffect(() => {
    ownsEntryRef.current = false
    return () => {
      const pending = pendingRef.current
      cancelPending()
      if (pending) {
        write(pending.identity, pending.text, pending.baseVersion)
      }
    }
  }, [key])

  useEffect(() => {
    if (!scope) {
      return
    }
    const identity = identityFor(scope, surface)
    const text = journalTextFor(draftContent, savedContent)
    cancelPending()
    if (text === '') {
      if (ownsEntryRef.current) {
        write(identity, '', filePreviewDraftBaseVersion(savedContent))
      }
      return
    }
    ownsEntryRef.current = true
    const baseVersion = filePreviewDraftBaseVersion(savedContent)
    const timer = setTimeout(() => {
      pendingRef.current = null
      write(identity, text, baseVersion)
    }, FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS)
    pendingRef.current = { timer, identity, text, baseVersion }
  }, [key, draftContent, savedContent])

  // Once per file per mount: the loaded content is the base the stored edit is judged against.
  useEffect(() => {
    if (!scope || restoredKeyRef.current === key) {
      return
    }
    restoredKeyRef.current = key
    const requestedKey = key
    const loadedContent = latestRef.current.savedContent
    void loadDraft(identityFor(scope, surface)).then((outcome) => {
      const current = latestRef.current
      // Why: the hook is mounted once per screen and the subject changes in place; a read for another subject
      // must not land in whatever editor is showing now. A null scope retries when the subject returns.
      if (current.key !== requestedKey) {
        if (restoredKeyRef.current === requestedKey) {
          restoredKeyRef.current = null
        }
        return
      }
      const decision = decideFilePreviewDraftRestore(outcome, loadedContent)
      if (decision.kind === 'restore') {
        // Why: anything the user already typed, or a newer load, wins over the stored copy.
        if (current.draftContent === loadedContent && current.savedContent === loadedContent) {
          ownsEntryRef.current = true
          current.onRestore(decision.text)
        }
        return
      }
      if (decision.kind === 'stale-base') {
        current.onIssue?.({ kind: 'restore-stale-base' })
      } else if (decision.kind === 'unreadable') {
        current.onIssue?.({ kind: 'restore-unreadable' })
      } else if (decision.kind === 'failed') {
        current.onIssue?.({ kind: 'restore-failed', error: decision.error })
      }
    })
  }, [key])
}
