import type {
  DirtyMarkdownDraft,
  MarkdownDocState,
  MobileSessionTab
} from './mobile-session-route-types'

/** Every ready, dirty markdown doc, whether or not its tab is still open. */
export function collectDirtyMarkdownDrafts(
  docs: ReadonlyMap<string, MarkdownDocState>,
  tabs: readonly MobileSessionTab[]
): DirtyMarkdownDraft[] {
  const drafts: DirtyMarkdownDraft[] = []
  for (const [tabId, doc] of docs) {
    if (doc.status === 'ready' && doc.isDirty) {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      drafts.push({
        tabId,
        title: tab?.title || 'Markdown',
        content: doc.localContent,
        relativePath: doc.relativePath
      })
    }
  }
  return drafts
}

/** Discard & Leave: retire the journal entry of every listed draft, by the key its doc carries. */
export function discardDirtyMarkdownDrafts(
  drafts: readonly DirtyMarkdownDraft[],
  discardDraft: (draft: { readonly relativePath: string }) => void
): void {
  for (const draft of drafts) {
    discardDraft({ relativePath: draft.relativePath })
  }
}
