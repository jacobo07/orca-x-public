import { useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  BACKLOG_DEFAULT_VIEW_FILTERS,
  selectBacklogView,
  type BacklogViewFilters,
  type BacklogViewModel
} from '../../../../shared/backlog-view-selector'
import type { Project } from '../../../../shared/project-types'
import type { BacklogLoadOutcome } from './backlog-snapshot'
import { BacklogCaptureDialog } from './BacklogCaptureDialog'
import { BacklogGroupList } from './BacklogGroupList'
import { BacklogPageStateBlock, type BacklogBlockStatus } from './BacklogPageStateBlock'
import { useBacklogSnapshot } from './use-backlog-snapshot'

type BacklogPageStatus = BacklogBlockStatus | 'ready'

// Why: empty is constructible only from a successful list whose ledger total is 0.
function pageStatus(
  load: BacklogLoadOutcome | null,
  view: BacklogViewModel | null
): BacklogPageStatus {
  if (load === null) {
    return 'loading'
  }
  if (load.status !== 'ready') {
    return load.status
  }
  if (load.rows.length === 0 && load.ledgerTotal === 0) {
    return 'empty'
  }
  return view && view.visibleCount > 0 ? 'ready' : 'filter-empty'
}

export default function BacklogPage(): React.JSX.Element {
  const closeBacklogPage = useAppStore((s) => s.closeBacklogPage)
  const projects = useAppStore((s) => s.projects)
  const { load, refresh } = useBacklogSnapshot()
  // Renderer-local and regenerable (D-05); the filter strip that edits it lands with 02-04.
  const [filters] = useState<BacklogViewFilters>(BACKLOG_DEFAULT_VIEW_FILTERS)
  const projectsById = useMemo(
    () => new Map<string, Project>(projects.map((project) => [project.id, project])),
    [projects]
  )
  const knownProjectIds = useMemo(() => new Set(projectsById.keys()), [projectsById])
  const view = useMemo(
    () =>
      load?.status === 'ready' ? selectBacklogView(load.rows, filters, knownProjectIds) : null,
    [load, filters, knownProjectIds]
  )
  const status = pageStatus(load, view)
  const failure = load?.status === 'storage-failed' ? load : null
  const [captureOpen, setCaptureOpen] = useState(false)
  // Rows appear only from a refetched snapshot: no optimistic insert (D-16).
  const refetch = (): void => void refresh()

  return (
    <div
      data-backlog-page=""
      data-backlog-status={status}
      data-backlog-failure-stage={failure?.stage}
      data-backlog-failure-code={failure?.code ?? undefined}
      className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-2 pb-4 md:px-8 md:pb-8">
        <header className="flex flex-none items-center gap-2 pb-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-full"
                data-backlog-action="close"
                onClick={closeBacklogPage}
                aria-label={translate('backlog.page.close', 'Close backlog')}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('backlog.page.closeTooltip', 'Close')}
            </TooltipContent>
          </Tooltip>
          <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
          <h1 className="min-w-0 flex-1 truncate text-lg font-medium leading-6">
            {translate('backlog.page.title', 'Backlog')}
          </h1>
          <Button size="sm" data-backlog-action="capture" onClick={() => setCaptureOpen(true)}>
            <Plus className="size-4" aria-hidden />
            {translate('backlog.capture.submit', 'Capture item')}
          </Button>
        </header>
        <section
          aria-label={translate('backlog.page.listLabel', 'Backlog items')}
          className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto"
        >
          {status === 'ready' ? (
            <BacklogGroupList groups={view?.groups ?? []} projectsById={projectsById} />
          ) : (
            <BacklogPageStateBlock
              status={status}
              filterEmpty={view?.filterEmpty ?? null}
              onRetry={refetch}
              onCapture={() => setCaptureOpen(true)}
            />
          )}
        </section>
      </div>
      <BacklogCaptureDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
        onConfirmed={refetch}
        onUncertain={refetch}
      />
    </div>
  )
}
