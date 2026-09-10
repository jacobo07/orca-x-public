import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { TerminalPreviewCard } from './TerminalPreviewCard'
import { resolveTerminalPreviewSubject } from './terminal-preview-subject'

/**
 * Shows a read-only preview of one terminal when its row is hovered or focused.
 *
 * Hover is not activation. Opening this changes nothing about the terminal: no focus, no input, no
 * resize, no ownership. Click still does what it always did, because the row underneath is
 * untouched — this only wraps it.
 *
 * Nothing is resolved or connected until the card opens, so rows nobody is looking at cost nothing.
 * Radix opens on focus as well as pointer, which is what keeps this reachable from the keyboard
 * rather than being a mouse-only capability.
 */

/** Matches WorktreeCardMeta, the other hover surface heavy enough to be worth waiting for. */
const PREVIEW_OPEN_DELAY_MS = 250
const PREVIEW_CLOSE_DELAY_MS = 120

export function TerminalPreviewHoverTrigger({
  tabId,
  leafId,
  title,
  children
}: {
  tabId: string
  /** Null for a row that names no single pane; such a row gets no preview rather than a guess. */
  leafId: string | null
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const layoutsByTabId = useAppStore((state) => state.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)

  const subject = useMemo(() => {
    if (!open || !leafId) {
      return null
    }
    return resolveTerminalPreviewSubject({
      tabId,
      leafId,
      layoutsByTabId: layoutsByTabId ?? {},
      ptyIdsByTabId: ptyIdsByTabId ?? {}
    })
  }, [open, leafId, tabId, layoutsByTabId, ptyIdsByTabId])

  if (!leafId) {
    return <>{children}</>
  }

  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={PREVIEW_OPEN_DELAY_MS}
      closeDelay={PREVIEW_CLOSE_DELAY_MS}
    >
      {/* A wrapper rather than asChild: the row renders a plain button that does not spread props,
          and silently dropping the trigger handlers onto it would leave a dead affordance. Focus
          bubbles out of the button, so keyboard users still open the card. */}
      <HoverCardTrigger asChild>
        {/* Why the leaf as well as the tab: two panes of one tab are two different terminals, so a
            trigger identified by tab alone names something that is not the subject. */}
        <div
          data-terminal-preview-trigger=""
          data-terminal-preview-tab-id={tabId}
          data-terminal-preview-leaf-id={leafId}
        >
          {children}
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="left" align="start" sideOffset={8} className="w-auto p-2">
        {subject ? <TerminalPreviewCard subject={subject} title={title} /> : null}
      </HoverCardContent>
    </HoverCard>
  )
}
