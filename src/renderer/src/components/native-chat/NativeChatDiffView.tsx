import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DiffLine } from './native-chat-diff'

/** Inline coloured diff, used for Edit/Write tool calls and diff-style tool
 *  results. Adds/dels use the git-decoration tokens with a faint tinted ground,
 *  matching the terminal's diff palette (no invented colors). */
export function NativeChatDiffView({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <div
      // Why: shared/native-chat-diff.ts already caps a diff at 120 lines, but that is still
      // ~2000px — and this was the only detail branch in NativeChatToolRun without a viewport
      // bound, while its result-body and input siblings have scrolled inside max-h-64 all along.
      // Bounding is a viewport decision: every line the producer sent is still here, one scroll
      // away. tabIndex makes that scroll reachable without a wheel, and the label names the
      // region for a screen reader now that it is one.
      className="max-h-64 overflow-auto rounded bg-accent py-1 font-mono text-[11px] leading-relaxed scrollbar-sleek"
      tabIndex={0}
      role="region"
      aria-label={translate('components.native-chat.diff.region', 'File diff')}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap break-words px-2',
            line.kind === 'add' && 'bg-emerald-500/10 text-[var(--git-decoration-added)]',
            line.kind === 'del' && 'bg-rose-500/10 text-[var(--git-decoration-deleted)]',
            line.kind === 'meta' && 'text-muted-foreground',
            line.kind === 'context' && 'text-foreground/70'
          )}
        >
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          {line.text}
        </div>
      ))}
    </div>
  )
}
