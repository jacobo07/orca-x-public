import { useSyncExternalStore } from 'react'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  decodeTabSessionResumeTarget,
  resolveTabSessionResumeTargetKey
} from '@/lib/tab-session-resume-target'
import {
  hasPaneSessionResumeHandler,
  isPaneSessionResumeInFlight,
  requestPaneSessionResume,
  subscribePaneSessionResumeDispatch
} from '@/lib/pane-session-resume-dispatch'
import { paneSessionResumeFailureText } from '../terminal-pane/PaneSessionResumeBanner'

function waitingText(reason: string | undefined): string {
  if (reason === 'shell-busy') {
    return translate(
      'agentSession.paneResume.shellBusy',
      'A command is still running in this shell.'
    )
  }
  if (reason === 'shell-unsupported') {
    return translate(
      'agentSession.paneResume.shellUnsupported',
      "This shell doesn't report its prompt, so Orca can't tell it's idle."
    )
  }
  return translate(
    'agentSession.paneResume.waitForPrompt',
    'Available when the shell is back at its prompt.'
  )
}

/**
 * Beside the agent logo: resume the exact session this tab's agent exited from. A projection of
 * the pane capability; the click goes through the pane's own resume, which re-checks everything.
 */
export function TerminalTabSessionResumeButton({
  tab,
  isActive,
  onActivate
}: {
  tab: { id: string; worktreeId: string }
  isActive: boolean
  onActivate: (tabId: string) => void
}): React.JSX.Element | null {
  const target = decodeTabSessionResumeTarget(
    useAppStore((state) => resolveTabSessionResumeTargetKey(state, tab))
  )
  const paneKey = target.kind === 'one' ? target.paneKey : null
  const readDispatch = (): string =>
    paneKey === null
      ? 'none'
      : isPaneSessionResumeInFlight(paneKey)
        ? 'resuming'
        : hasPaneSessionResumeHandler(paneKey)
          ? 'mounted'
          : 'unmounted'
  const dispatch = useSyncExternalStore(
    subscribePaneSessionResumeDispatch,
    readDispatch,
    readDispatch
  )
  if (target.kind === 'none') {
    return null
  }

  const resuming = dispatch === 'resuming'
  const waiting = target.kind === 'one' && target.state === 'disabled'
  const resumeLabel = translate('agentSession.tabResume.resume', 'Resume session')
  const label = resuming
    ? translate('agentSession.paneResume.resuming', 'Resuming…')
    : target.kind === 'several'
      ? translate(
          'agentSession.tabResume.several',
          'Several sessions ended in this tab. Choose one in its pane.'
        )
      : waiting
        ? `${resumeLabel}: ${waitingText(target.reason)}`
        : resumeLabel

  const onClick = async (): Promise<void> => {
    // Why: several panes, or a pane not mounted yet, are answered by the pane's own strip.
    if (target.kind !== 'one' || dispatch === 'unmounted') {
      onActivate(tab.id)
      return
    }
    if (waiting || resuming) {
      return
    }
    const result = await requestPaneSessionResume(target.paneKey)
    const failure = paneSessionResumeFailureText(result)
    if (failure) {
      toast.error(failure)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="tab-session-resume-button"
          data-pane-key={paneKey ?? undefined}
          data-resume-state={resuming ? 'resuming' : waiting ? 'waiting' : target.kind}
          aria-label={label}
          aria-disabled={waiting || resuming}
          aria-busy={resuming}
          className={cn(
            // Why the ::after: a 16px glyph in a 24px hit target, without widening the tab.
            'relative mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm after:absolute after:-inset-1 after:content-[""]',
            'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            !isActive && 'opacity-70',
            (waiting || resuming) && 'cursor-default hover:bg-transparent'
          )}
          onPointerDown={(event) => {
            if (event.button === 0) {
              event.stopPropagation()
            }
          }}
          onMouseDown={(event) => {
            if (event.button === 0) {
              event.stopPropagation()
            }
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void onClick()
          }}
        >
          <RotateCcw className={cn('size-3', resuming && 'animate-spin')} aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
