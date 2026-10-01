import type React from 'react'
import { cn } from '@/lib/utils'

/** One labeled row of the global navigation; the icon-only form is the rail cell. */
export function GlobalNavRow({
  icon,
  label,
  accessibleLabel,
  active,
  disabled = false,
  onSelect,
  onPrefetch,
  trailing,
  dataAttributes
}: {
  icon: React.ReactNode
  label: string
  accessibleLabel?: string
  active: boolean
  disabled?: boolean
  onSelect: () => void
  onPrefetch?: () => void
  trailing?: React.ReactNode
  dataAttributes: Record<string, string>
}): React.JSX.Element {
  return (
    <button
      type="button"
      {...dataAttributes}
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      aria-label={accessibleLabel ?? label}
      className={cn(
        'flex h-9 w-full shrink-0 items-center gap-3 rounded-md px-3 text-left text-[13px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
      )}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      onClick={() => {
        if (!disabled) {
          onSelect()
        }
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}
