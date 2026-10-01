import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { ResumeCenterModel } from './resume-center-model'
import { ClaimValue } from './ClaimValue'

function Stat({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  )
}

export function ResumeCenterSummaryPanel({
  model,
  className
}: {
  model: ResumeCenterModel
  className?: string
}): React.JSX.Element {
  const [tipDismissed, setTipDismissed] = useState(false)
  const { totals } = model
  return (
    <aside
      data-testid="resume-center-summary"
      className={cn('flex w-72 shrink-0 flex-col gap-3', className)}
      aria-label={translate('resumeCenter.summary.title', 'Desk summary')}
    >
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('resumeCenter.summary.title', 'Desk summary')}
        </h3>
        <Stat label={translate('resumeCenter.summary.windows', 'Windows')}>
          {model.windowsRecorded ? (
            <ClaimValue testId="resume-center-window-count">{model.windowCount}</ClaimValue>
          ) : (
            translate('resumeCenter.summary.windowsUnrecorded', 'Not recorded')
          )}
        </Stat>
        <Stat label={translate('resumeCenter.summary.workspaces', 'Workspaces')}>
          <ClaimValue testId="resume-center-workspace-count">{totals.workspaces}</ClaimValue>
        </Stat>
        <Stat label={translate('resumeCenter.summary.sessions', 'Sessions')}>
          <ClaimValue testId="resume-center-session-count">{totals.tabs}</ClaimValue>
        </Stat>
        <Stat label={translate('resumeCenter.summary.panes', 'Terminal panes')}>
          <ClaimValue testId="resume-center-pane-count">{totals.panes}</ClaimValue>
        </Stat>
        <Stat label={translate('resumeCenter.residency.warm', 'Running')}>
          <ClaimValue testId="resume-center-warm-count">{totals.byResidency.warm}</ClaimValue>
        </Stat>
        <Stat label={translate('resumeCenter.residency.dormant', 'Sleeping')}>
          <ClaimValue testId="resume-center-dormant-count">{totals.byResidency.dormant}</ClaimValue>
        </Stat>
        <Stat label={translate('resumeCenter.residency.unknown', 'State unknown')}>
          <ClaimValue testId="resume-center-unknown-count">{totals.byResidency.unknown}</ClaimValue>
        </Stat>
      </div>

      {model.unreadableHosts.length > 0 || model.unprojectable.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-card/40 p-4 text-[12px]">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate('resumeCenter.summary.unreadable', 'Could not be read')}
          </h3>
          {model.unreadableHosts.map((host) => (
            <p key={host.hostId} className="text-muted-foreground">
              {getExecutionHostLabel(host.hostId)}
            </p>
          ))}
          {model.unprojectable.map((workspace) => (
            <p key={workspace.key} className="truncate font-mono text-[11px] text-muted-foreground">
              {workspace.key}
            </p>
          ))}
        </div>
      ) : null}

      {tipDismissed ? null : (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-4 text-[12px] text-muted-foreground">
          <p>
            {translate(
              'resumeCenter.tip.body',
              'Expand a workspace and a session to see the last recorded screen of each terminal. Previews come from saved history and never start a process.'
            )}
          </p>
          <button
            type="button"
            onClick={() => setTipDismissed(true)}
            className="self-start text-[11px] underline-offset-2 hover:underline"
          >
            {translate('resumeCenter.tip.dismiss', 'Dismiss')}
          </button>
        </div>
      )}
    </aside>
  )
}
