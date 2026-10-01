import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { currentWorkspaceDestination } from '@/lib/workspace-destinations'
import { WorkspaceExitButton } from '../conversations/WorkspaceExitButton'
import { WorkspaceNav, workspaceDestinationLabel } from './WorkspaceNav'

/** Below this frame width the right column folds: navigation moves into the header strip. */
export const WORKSPACE_FRAME_COLUMN_MIN_PX = 980

/**
 * The one frame every Workspace destination renders in (workspace-convergence.md §2.4):
 * breadcrumb bar, the page, and ONE right column — Workspace navigation on top, the page's context
 * below. Width is the frame's own (Orca's other columns take theirs first), never the window's.
 */
export function WorkspaceFrame({
  context,
  actions,
  trail,
  children,
  testId
}: {
  /** The page's context cards; null when the page has none. */
  context: ReactNode | null
  /** Header controls on the right of the breadcrumb. */
  actions?: ReactNode
  /** Extra breadcrumb segment after the destination (e.g. the open agent's name). */
  trail?: string | null
  children: ReactNode
  testId?: string
}): React.JSX.Element {
  const activeView = useAppStore((s) => s.activeView)
  const rosterTab = useAppStore((s) => s.workspaceRosterTab)
  const openWorkspaceHome = useAppStore((s) => s.openWorkspaceHome)
  const destination = currentWorkspaceDestination(activeView, rosterTab)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [hasColumn, setHasColumn] = useState(true)
  const [contextOverlayOpen, setContextOverlayOpen] = useState(false)

  useEffect(() => {
    const element = rootRef.current
    if (!element) {
      return
    }
    const apply = (width: number): void => setHasColumn(width >= WORKSPACE_FRAME_COLUMN_MIN_PX)
    apply(element.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) {
        apply(entry.contentRect.width)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const destinationLabel = destination ? workspaceDestinationLabel(destination) : null
  const workspaceLabel = translate('auto.components.sidebar.SidebarNav.workspace', 'Workspace')

  return (
    <div
      ref={rootRef}
      data-workspace-frame=""
      data-workspace-destination={destination ?? ''}
      data-workspace-frame-layout={hasColumn ? 'column' : 'strip'}
      data-testid={testId}
      className="relative flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="flex h-11 min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <WorkspaceExitButton />
        <nav
          aria-label={translate('workspaceFrame.breadcrumb', 'Breadcrumb')}
          className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
        >
          <button
            type="button"
            className="shrink-0 hover:text-foreground"
            onClick={openWorkspaceHome}
            data-workspace-breadcrumb="workspace"
          >
            {workspaceLabel}
          </button>
          {destinationLabel ? (
            <>
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
              <span
                className={cn('truncate', trail ? '' : 'text-foreground')}
                aria-current={trail ? undefined : 'page'}
              >
                {destinationLabel}
              </span>
            </>
          ) : null}
          {trail ? (
            <>
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate text-foreground" aria-current="page">
                {trail}
              </span>
            </>
          ) : null}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {hasColumn ? null : <WorkspaceNav variant="strip" />}
          {actions}
          {!hasColumn && context ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={contextOverlayOpen}
              aria-label={translate('workspaceFrame.details', 'Details')}
              onClick={() => setContextOverlayOpen((open) => !open)}
              data-workspace-frame-context-toggle=""
            >
              <PanelRight className="size-4" aria-hidden />
            </Button>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
        {hasColumn ? (
          <aside
            data-workspace-frame-column=""
            className="flex w-80 shrink-0 flex-col border-l border-border bg-background"
          >
            <div className="shrink-0 border-b border-border p-2">
              <WorkspaceNav variant="list" />
            </div>
            {context ? (
              <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                {context}
              </div>
            ) : null}
          </aside>
        ) : contextOverlayOpen && context ? (
          <aside
            data-workspace-frame-column="overlay"
            className="scrollbar-sleek absolute inset-y-11 right-0 z-20 flex w-80 max-w-full flex-col gap-3 overflow-y-auto border-l border-border bg-background p-3 shadow-lg"
          >
            {context}
          </aside>
        ) : null}
      </div>
    </div>
  )
}
