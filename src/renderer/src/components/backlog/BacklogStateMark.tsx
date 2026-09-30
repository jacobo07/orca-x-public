import { cn } from '@/lib/utils'
import type { BacklogTone } from './backlog-presentation'

// The Backlog surface's only status-colour map. Filled for a reading that needs attention; unknown
// and idle are hollow; plain states carry no dot. The dot always sits beside a text label.
const TONE_MARK: Record<BacklogTone, string> = {
  critical: 'border-transparent bg-[var(--status-error)]',
  pressured: 'border-transparent bg-[var(--status-warning)]',
  unknown: 'bg-transparent border-[var(--status-unknown)]',
  idle: 'bg-transparent border-muted-foreground',
  plain: ''
}

export function BacklogStateMark({ tone }: { tone: BacklogTone }): React.JSX.Element | null {
  if (tone === 'plain') {
    return null
  }
  const filled = tone === 'critical' || tone === 'pressured'
  return (
    <span
      aria-hidden
      data-backlog-tone-mark={tone}
      data-mark={filled ? 'filled' : 'hollow'}
      className={cn('inline-block size-2 shrink-0 rounded-full border', TONE_MARK[tone])}
    />
  )
}
