import React from 'react'
import { Plus, TerminalSquare, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export type TerminalInstanceColumnItem = {
  /** Terminal tab id — what activate/close act on. */
  id: string
  title: string
  /** Optional user-assigned tab color, mirrored as a leading dot. */
  color?: string | null
}

/**
 * Vertical list of the workspace panel's terminals along its right edge, the arrangement VS Code
 * and Cursor use.
 *
 * Why a column and not more horizontal tabs: terminal titles are paths and commands, which the
 * horizontal strip truncates to a few characters once three or four are open. A column gives each
 * one a full row, so the list stays readable exactly when it starts being worth having.
 *
 * It lists terminals only. Browser and editor tabs live in the panel's horizontal bar and putting
 * them here too would make the same tab appear twice with two different close buttons.
 */
export function TerminalInstanceColumn({
  items,
  activeId,
  onActivate,
  onClose,
  onCreate
}: {
  items: readonly TerminalInstanceColumnItem[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCreate: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex w-[172px] shrink-0 flex-col border-l border-border bg-[var(--bg-titlebar,var(--card))]"
      data-floating-terminal-no-drag
      aria-label={translate(
        'auto.components.floating.terminal.TerminalInstanceColumn.region',
        'Terminals'
      )}
    >
      <div className="flex h-7 shrink-0 items-center justify-between px-2">
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {translate('auto.components.floating.terminal.TerminalInstanceColumn.title', 'Terminals')}
        </span>
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          aria-label={translate(
            'auto.components.floating.terminal.TerminalInstanceColumn.new',
            'New terminal'
          )}
          onClick={onCreate}
        >
          <Plus className="size-3" />
        </button>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto py-0.5">
        {items.map((item) => {
          const isActive = item.id === activeId
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              aria-current={isActive}
              title={item.title}
              className={cn(
                'group/instance mx-1 flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[12px] transition-colors',
                isActive
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
              onClick={() => onActivate(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onActivate(item.id)
                }
              }}
            >
              {item.color ? (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                  aria-hidden
                />
              ) : (
                <TerminalSquare className="size-3 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {/* Close stays mounted but transparent until hover so the row's text width never
                  changes underneath the pointer, which would make the label jump as you scan. */}
              <button
                type="button"
                className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover/instance:opacity-100"
                aria-label={translate(
                  'auto.components.floating.terminal.TerminalInstanceColumn.close',
                  'Close {{title}}',
                  { title: item.title }
                )}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(item.id)
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
