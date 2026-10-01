import { PanelLeft } from 'lucide-react'
import { useRef, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

import { useWorkspaceLayoutMode, type WorkspaceLayoutMode } from './use-workspace-layout'

/**
 * Places roster and chat by the surface's own width; the agent's context lives in WorkspaceFrame's
 * column. The chat is never the column that gives way: in the narrowest mode the roster and the
 * chat take turns rather than share.
 */
export function CognitiveWorkspaceLayout({
  roster,
  chat,
  narrowPane,
  onShowRoster,
  children,
  testAttributes
}: {
  roster: (mode: WorkspaceLayoutMode) => ReactNode
  chat: (mode: WorkspaceLayoutMode) => ReactNode
  narrowPane: 'roster' | 'chat'
  onShowRoster: () => void
  children?: ReactNode
  testAttributes: Record<string, string>
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const mode = useWorkspaceLayoutMode(rootRef)
  const showRoster = mode !== 'narrow' || narrowPane === 'roster'
  const showChat = mode !== 'narrow' || narrowPane === 'chat'

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 w-full bg-background"
      data-workspace-layout={mode}
      {...testAttributes}
    >
      {showRoster ? roster(mode) : null}
      {showChat ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
        </div>
      ) : null}
      {children}
    </div>
  )
}
