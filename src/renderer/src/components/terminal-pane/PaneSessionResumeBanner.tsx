import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  readPaneSessionResumeCapability,
  type PaneSessionResumeCapability,
  type PaneSessionResumeTarget
} from '@/lib/pane-session-resume-capability'
import type { PaneSessionResumeResult } from '@/lib/pane-session-resume-intent'

type Phase = { kind: 'idle' } | { kind: 'resuming' } | { kind: 'failed'; message: string }

// Why a string: a fresh capability object per store update would re-render every pane forever.
function capabilityKey(capability: PaneSessionResumeCapability): string {
  return capability.kind === 'disabled' || capability.kind === 'unavailable'
    ? `${capability.kind}:${capability.reason}`
    : capability.kind
}

function unavailableText(reason: string): string {
  switch (reason) {
    case 'legacy-fence':
      return translate(
        'agentSession.paneResume.unavailable.fenced',
        'Orca is recovering this worker.'
      )
    case 'remote':
      return translate(
        'agentSession.paneResume.unavailable.remote',
        "Resume isn't available for remote terminals yet."
      )
    case 'runtime-routed':
      return translate(
        'agentSession.paneResume.unavailable.runtime',
        "Resume isn't available for this host yet."
      )
    case 'worktree-missing':
      return translate('agentSession.paneResume.unavailable.missing', 'This workspace is missing.')
    case 'worktree-deleting':
      return translate(
        'agentSession.paneResume.unavailable.deleting',
        'This workspace is being deleted.'
      )
    default:
      return translate(
        'agentSession.paneResume.unavailable.noPlan',
        "This session can't be resumed here."
      )
  }
}

/** Why a resume attempt did not start, in product words; null when it started or was cancelled. */
export function paneSessionResumeFailureText(result: PaneSessionResumeResult): string | null {
  if (result.outcome === 'spawn-failed') {
    return translate('agentSession.paneResume.failed', "Couldn't resume this session. Try again.")
  }
  if (result.outcome === 'unavailable' && result.capability.kind === 'disabled') {
    if (result.capability.reason === 'shell-busy') {
      return translate(
        'agentSession.paneResume.shellBusy',
        'A command is still running in this shell.'
      )
    }
    if (result.capability.reason === 'shell-unsent-input') {
      return translate(
        'agentSession.paneResume.shellUnsentInput',
        'This shell has something typed at its prompt. Submit or clear it, then resume.'
      )
    }
    if (result.capability.reason === 'host-outdated') {
      return translate(
        'agentSession.paneResume.hostOutdated',
        'Restart terminals to resume here: this terminal service is older than Orca.'
      )
    }
  }
  if (result.outcome !== 'blocked') {
    return null
  }
  if (result.reason === 'materializing') {
    return translate(
      'agentSession.paneResume.blocked.starting',
      'This session is already starting in another pane.'
    )
  }
  if (result.reason === 'unknown') {
    return translate(
      'agentSession.paneResume.blocked.unknown',
      "Orca couldn't confirm this session is free."
    )
  }
  return translate('agentSession.paneResume.blocked.open', 'This session is open in another pane.')
}

/** "Session ended · Resume this session" for a pane whose agent exited to its shell. */
export function PaneSessionResumeBanner({
  target,
  onResume
}: {
  target: PaneSessionResumeTarget
  onResume: () => Promise<PaneSessionResumeResult>
}): React.JSX.Element | null {
  const key = useAppStore((state) => capabilityKey(readPaneSessionResumeCapability(state, target)))
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  // Why: a stale failure line must not outlive the state it described.
  useEffect(() => {
    setPhase((current) => (current.kind === 'failed' ? { kind: 'idle' } : current))
  }, [key])

  if (key === 'hidden') {
    return null
  }
  const [kind, reason] = key.split(':')
  const starting = phase.kind === 'resuming' || reason === 'shell-busy'
  const resume = async (): Promise<void> => {
    setPhase({ kind: 'resuming' })
    const result = await onResume().catch(
      (): PaneSessionResumeResult => ({ outcome: 'spawn-failed' })
    )
    const message = paneSessionResumeFailureText(result)
    setPhase(message ? { kind: 'failed', message } : { kind: 'idle' })
  }

  return (
    <div
      className="absolute right-2 top-1 z-[5] flex max-w-[calc(100%-16px)] items-center gap-2 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-muted-foreground shadow-xs"
      data-testid="pane-session-resume"
      data-pane-key={target.paneKey}
      data-capability={key}
      role="status"
    >
      <span className="shrink-0 text-foreground">
        {translate('agentSession.paneResume.ended', 'Session ended')}
      </span>
      {kind === 'unavailable' ? (
        <span className="truncate">{unavailableText(reason ?? '')}</span>
      ) : (
        <Button
          size="xs"
          variant="outline"
          data-testid="pane-session-resume-button"
          disabled={kind !== 'available' || starting}
          title={
            reason === 'shell-unconfirmed'
              ? translate(
                  'agentSession.paneResume.waitForPrompt',
                  'Available when the shell is back at its prompt.'
                )
              : reason === 'shell-unsupported'
                ? translate(
                    'agentSession.paneResume.shellUnsupported',
                    "This shell doesn't report its prompt, so Orca can't tell it's idle."
                  )
                : undefined
          }
          onClick={() => {
            void resume()
          }}
        >
          {starting
            ? translate('agentSession.paneResume.resuming', 'Resuming…')
            : translate('agentSession.paneResume.resume', 'Resume this session')}
        </Button>
      )}
      {phase.kind === 'failed' ? (
        <span className="truncate text-destructive" data-testid="pane-session-resume-error">
          {phase.message}
        </span>
      ) : null}
    </div>
  )
}
