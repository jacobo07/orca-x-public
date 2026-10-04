// Journals an unsaved markdown doc edit so it survives the process, and offers it back as a
// dirty draft when the same file is reopened against the same host content. The journal
// mechanics are the file preview's; only the surface and the doc-state adapter differ.
import {
  useMobileFilePreviewDraftJournal,
  type FilePreviewDraftIssue
} from '../files/use-mobile-file-preview-draft-journal'
import type { MarkdownDocState } from './mobile-session-route-types'

export type MarkdownDocDraftJournal = {
  /** The user chose to lose this doc's phone edit (any tab, not only the active one). */
  discardDraft: (tab: { readonly relativePath: string }) => void
}

export function useMobileMarkdownDocDraftJournal(args: {
  hostId: string
  worktreeId: string
  /** Null when no markdown tab is active. */
  tab: { readonly id: string; readonly relativePath: string } | null
  doc: MarkdownDocState | undefined
  onRestore: (tabId: string, text: string) => void
  onIssue?: (issue: FilePreviewDraftIssue) => void
}): MarkdownDocDraftJournal {
  const { hostId, worktreeId, tab, doc, onRestore, onIssue } = args
  const journaled = tab && doc?.status === 'ready' && doc.editable ? doc : null
  const journal = useMobileFilePreviewDraftJournal({
    surface: 'markdown-editor',
    // The relative path survives a relaunch; the tab id is minted per launch.
    scope: journaled && tab ? { hostId, worktreeId, subjectId: tab.relativePath } : null,
    draftContent: journaled?.localContent ?? '',
    savedContent: journaled?.content ?? '',
    onRestore: (text) => tab && onRestore(tab.id, text),
    onIssue
  })
  return {
    discardDraft: (target) =>
      journal.discardDraft({ hostId, worktreeId, subjectId: target.relativePath })
  }
}
