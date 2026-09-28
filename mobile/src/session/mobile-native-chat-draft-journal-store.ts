// The production chat draft store: the durable user-draft journal. Kept out of the
// drafts hook so the hook stays importable without AsyncStorage.
import { clearDraftAfterConfirmed, loadDraft, saveDraft } from '../storage/draft-journal'
import type { MobileNativeChatDraftStore } from './use-mobile-native-chat-draft-persistence'

export const journalChatDraftStore: MobileNativeChatDraftStore = {
  load: loadDraft,
  save: (identity, text) => saveDraft(identity, text),
  // Why trimmed: the send-time clear matches on trimmed text too, and a sent prompt
  // that differs only by a trailing newline is the same prompt.
  clearAfterConfirmed: (identity, text) =>
    clearDraftAfterConfirmed(identity, text, { ignoreSurroundingWhitespace: true })
}
