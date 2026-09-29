import { useState } from 'react'
import { Maximize2, RefreshCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceRowModel } from '../resume-center/resume-center-model'
import { describeUnavailable } from './mission-brief-presentation'
import { MissionBriefActions } from './MissionBriefActions'
import { MissionBriefFullPathDialog } from './MissionBriefFullPathDialog'
import { MissionBriefHeader } from './MissionBriefHeader'
import { MissionBriefRows } from './MissionBriefRows'
import { useMissionBrief } from './use-mission-brief'

/**
 * The Mission Brief for one workspace: a projection of its own mission records. `compact` is the
 * Resume Center side panel; `full` is the reference layout.
 */
export function MissionBriefPanel({
  hostId,
  workspaceKey,
  projectName,
  row,
  variant,
  onOpenFull
}: {
  hostId: ExecutionHostId
  workspaceKey: string
  projectName: string
  row: WorkspaceRowModel | null
  variant: 'full' | 'compact'
  onOpenFull?: () => void
}): React.JSX.Element {
  const { entry, refresh, chooseWorkstream } = useMissionBrief(hostId, workspaceKey)
  const [pathOpen, setPathOpen] = useState(false)
  const compact = variant === 'compact'
  const result =
    entry?.status === 'loaded' ? entry.result : entry?.status === 'loading' ? entry.previous : null
  const reading = entry === undefined || entry.status === 'loading'

  const toolbar = (
    <div className="flex items-center justify-end gap-2">
      {compact && onOpenFull && result?.status === 'read' ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="mission-brief-open-full"
          onClick={onOpenFull}
        >
          <Maximize2 className="size-3.5" aria-hidden />
          {translate('missionBrief.openFull', 'Open full brief')}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        data-testid="mission-brief-refresh"
        disabled={reading}
        onClick={refresh}
        aria-label={translate('missionBrief.refresh', 'Re-read mission records')}
      >
        <RefreshCw className={cn('size-3.5', reading && 'motion-safe:animate-spin')} aria-hidden />
      </Button>
    </div>
  )

  let body: React.ReactNode
  if (!result) {
    body = (
      <p className="text-sm text-muted-foreground" role="status">
        {entry?.status === 'failed'
          ? translate('missionBrief.state.failed', 'The mission records could not be read.')
          : translate('missionBrief.state.reading', 'Reading mission records…')}
      </p>
    )
  } else if (result.status === 'choose-workstream') {
    body = (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">
          {translate(
            'missionBrief.state.chooseWorkstream',
            'This workspace runs several missions. Which one?'
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {result.workstreams.map((workstream) => (
            <Button
              key={workstream}
              size="sm"
              variant="outline"
              onClick={() => chooseWorkstream(workstream)}
            >
              {workstream}
            </Button>
          ))}
        </div>
      </div>
    )
  } else if (result.status === 'read') {
    const { brief } = result
    body = (
      <>
        <MissionBriefHeader brief={brief} projectName={projectName} compact={compact} />
        <MissionBriefRows brief={brief} compact={compact} />
        <MissionBriefActions
          brief={brief}
          row={row}
          hostId={hostId}
          workspaceKey={workspaceKey}
          onViewPath={() => setPathOpen(true)}
          compact={compact}
        />
        <MissionBriefFullPathDialog brief={brief} open={pathOpen} onOpenChange={setPathOpen} />
      </>
    )
  } else {
    body = <p className="text-sm text-muted-foreground">{describeUnavailable(result)}</p>
  }

  return (
    <section
      data-testid={compact ? 'mission-brief-compact' : 'mission-brief-full'}
      data-workspace-key={workspaceKey}
      aria-label={translate('missionBrief.title', 'Mission Brief')}
      aria-busy={reading}
      className={cn(
        'flex flex-col gap-4 rounded-xl border border-border bg-card',
        compact ? 'p-4' : 'p-7'
      )}
    >
      {toolbar}
      {body}
    </section>
  )
}
