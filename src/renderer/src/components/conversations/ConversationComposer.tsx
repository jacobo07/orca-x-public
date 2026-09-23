import { ArrowUp } from 'lucide-react'
import type { RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'

/**
 * The hint is visible text bound by aria-describedby: an in-field hint vanishes the moment someone
 * types and several screen readers skip it. No Stop control: `turn/interrupt` has no call site.
 */
export function ConversationComposer({
  composerRef,
  value,
  onChange,
  onSend,
  working,
  recipient
}: {
  composerRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onSend: () => void
  working: boolean
  recipient: string | null
}): React.JSX.Element {
  return (
    <form
      className="px-4 pb-4 pt-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSend()
      }}
    >
      <div className="rounded-xl border border-border bg-card p-2 focus-within:ring-1 focus-within:ring-ring">
        <label className="sr-only" htmlFor="conversation-composer">
          {recipient
            ? translate('workspace.composer.labelTo', 'Message {{name}}', { name: recipient })
            : translate('conversations.composerLabel', 'Message')}
        </label>
        <Textarea
          id="conversation-composer"
          ref={composerRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby="conversation-composer-hint"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSend()
            }
          }}
          rows={2}
          className="min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          data-testid="conversation-composer"
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          <p id="conversation-composer-hint" className="text-xs text-muted-foreground">
            {translate('conversations.composerHint', 'Enter sends. Shift+Enter starts a new line.')}
          </p>
          <Button
            type="submit"
            size="sm"
            disabled={working || value.trim().length === 0}
            data-testid="conversation-send"
          >
            {working ? (
              translate('conversations.sending', 'Working…')
            ) : (
              <>
                <ArrowUp className="size-4" aria-hidden />
                {translate('conversations.send', 'Send')}
              </>
            )}
          </Button>
        </div>
      </div>
    </form>
  )
}
