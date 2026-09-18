import { useMemo } from 'react'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { useTerminalPreviewTerminal } from './use-terminal-preview-terminal'
import type { TerminalPreviewSubject } from './terminal-preview-subject'

/**
 * A compact, read-only look at one terminal without switching into it.
 *
 * The card says what it is showing and how true that is. An unresolved subject is reported as a
 * reason, never as an empty frame: "not started" and "closed" want opposite sentences, and a blank
 * box that could mean either is the false-live failure this surface exists to avoid.
 */
export function TerminalPreviewCard({
  subject,
  title,
  className
}: {
  subject: TerminalPreviewSubject
  title: string
  className?: string
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const { terminalTheme, terminalMode } = useMemo(() => {
    if (!settings) {
      return { terminalTheme: null, terminalMode: 'dark' as const }
    }
    const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    return {
      terminalTheme: composeActiveTerminalTheme(
        appearance.theme ?? getBuiltinTheme(appearance.themeName),
        settings
      ),
      terminalMode: appearance.mode
    }
  }, [settings, systemPrefersDark])

  const { containerRef, status, transcript } = useTerminalPreviewTerminal({
    ptyId: subject.status === 'available' ? subject.ptyId : null,
    settings,
    theme: terminalTheme,
    themeMode: terminalMode
  })

  const notice =
    subject.status === 'unavailable'
      ? subject.reason === 'no-pty'
        ? translate('terminalPreview.notStarted', 'This terminal has not started yet.')
        : translate('terminalPreview.closed', 'This terminal has closed.')
      : status === 'unavailable'
        ? translate('terminalPreview.gone', 'No live terminal — nothing is running here now.')
        : status === 'connecting'
          ? translate('terminalPreview.connecting', 'Reading the current screen…')
          : null

  return (
    <div
      data-terminal-preview-card=""
      data-terminal-preview-status={subject.status === 'available' ? status : subject.reason}
      className={cn('flex w-[420px] flex-col gap-1.5', className)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          {title}
        </span>
        {/* Why labelled rather than a bare dot: a preview that only signals liveness by colour has
            removed that information for anyone not looking at it. */}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {subject.status === 'available' && status === 'live'
            ? translate('terminalPreview.live', 'Live')
            : translate('terminalPreview.unavailableShort', 'Unavailable')}
        </span>
      </div>

      <div
        className="relative flex h-[200px] w-full items-start overflow-hidden rounded-[6px] border border-border bg-background p-1.5"
        style={
          terminalTheme?.background ? { backgroundColor: terminalTheme.background } : undefined
        }
      >
        {notice ? (
          <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
            {notice}
          </div>
        ) : null}
        {/* aria-hidden with a text sibling below: xterm's DOM is a grid of styled spans that reads
            as noise, so the accessible copy is the transcript, not the canvas. */}
        <div
          ref={containerRef}
          aria-hidden="true"
          className={cn('origin-top-left', notice && 'invisible')}
        />
      </div>

      {transcript.length > 0 ? (
        <p className="sr-only" data-terminal-preview-transcript="">
          {translate('terminalPreview.transcriptLabel', 'Current screen of {{value0}}', {
            value0: title
          })}
          {`: ${transcript}`}
        </p>
      ) : null}
    </div>
  )
}
