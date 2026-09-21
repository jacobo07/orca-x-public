import { translate } from '@/i18n/i18n'
import type { ConversationNotice as Notice } from './conversation-live-state'

/**
 * Every refusal gets its OWN sentence naming what to do. "Something went wrong" sends a person to
 * check everything; "Codex is not signed in" sends them to one place.
 *
 * The provider's own words are shown beside the sentence, untranslated, because they are evidence —
 * a friendlier paraphrase would hide what actually happened.
 */
export function ConversationNotice({ notice }: { notice: Notice }): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="conversation-notice"
      data-notice-kind={notice.kind}
      className="mx-4 mb-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <p>{messageFor(notice)}</p>
      {notice.detail !== null ? (
        <p className="mt-1 font-mono text-xs text-muted-foreground">{notice.detail}</p>
      ) : null}
    </div>
  )
}

function messageFor(notice: Notice): string {
  switch (notice.kind) {
    case 'auth-required':
      return translate(
        'conversations.noticeAuthRequired',
        'Codex is not signed in. Sign in, then send again — your message was kept.'
      )
    case 'busy':
      return translate(
        'conversations.noticeBusy',
        'This conversation is still answering. Wait for it to finish before sending again.'
      )
    case 'not-durable':
      return translate(
        'conversations.noticeNotDurable',
        'The answer arrived but could not be saved, so it is not in your history. Send again rather than relying on it.'
      )
    case 'failed':
      return translate(
        'conversations.noticeFailed',
        'The turn failed. Your message was kept.'
      )
    case 'interrupted':
      return translate(
        'conversations.noticeInterrupted',
        'The turn was interrupted before it finished. Your message was kept.'
      )
    case 'absent':
      return translate(
        'conversations.noticeAbsent',
        'This conversation is no longer on disk. Nothing was sent.'
      )
    case 'approval-declined':
      return translate(
        'conversations.noticeApprovalDeclined',
        'The agent asked to run a command and Orca declined it. Approving actions from a conversation is not built yet.'
      )
  }
}
