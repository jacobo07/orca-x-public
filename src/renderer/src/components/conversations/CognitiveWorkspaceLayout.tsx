import { PanelLeft } from 'lucide-react'
import { useRef, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

import { useWorkspaceLayoutMode, type WorkspaceLayoutMode } from './use-workspace-layout'

/**
 * Places roster, chat and context by the workspace's own width. The chat is never the column that
 * gives way: the context rail leaves the flow first (it opens over the chat instead), and in the
 * narrowest mode the roster and the chat take turns rather than share.
 */
export function CognitiveWorkspaceLayout({
  roster,
  chat,
  rail,
  railOpen,
  narrowPane,
  onShowRoster,
  children,
  testAttributes
}: {
  roster: (mode: WorkspaceLayoutMode) => ReactNode
  chat: (mode: WorkspaceLayoutMode) => ReactNode
  rail: ReactNode | null
  /** null = the mode's default: inline when wide, closed otherwise. */
  railOpen: boolean | null
  narrowPane: 'roster' | 'chat'
  onShowRoster: () => void
  children?: ReactNode
  testAttributes: Record<string, string>
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const mode = useWorkspaceLayoutMode(rootRef)
  const showRail = rail !== null && (railOpen ?? mode === 'wide')
  const railInline = mode === 'wide'
  const showRoster = mode !== 'narrow' || narrowPane === 'roster'
  const showChat = mode !== 'narrow' || narrowPane === 'chat'

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 w-full bg-background"
      data-workspace-layout={mode}
      data-rail={showRail ? (railInline ? 'inline' : 'overlay') : 'closed'}
      {...testAttributes}
    >
      {showRoster ? roster(mode) : null}
      {showChat ? (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {mode === 'narrow' ? (
            <div className="flex items-center border-b border-border px-2 py-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onShowRoster}
                data-testid="workspace-show-roster"
              >
                <PanelLeft className="size-4" aria-hidden />
                {translate('workspace.roster.show', 'Agents and threads')}
              </Button>
            </div>
          ) : null}
          {chat(mode)}
        </main>
      ) : null}
      {showRail ? (
        <div
          className={cn(
            'flex min-h-0',
            railInline ? '' : 'absolute inset-y-0 right-0 z-20 shadow-lg'
          )}
        >
          {rail}
        </div>
      ) : null}
      {children}
    </div>
  )
}
