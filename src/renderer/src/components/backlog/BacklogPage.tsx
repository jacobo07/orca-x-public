import { useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  BACKLOG_DEFAULT_VIEW_FILTERS,
  selectBacklogView,
  type BacklogViewFilters,
  type BacklogViewModel
} from '../../../../shared/backlog-view-selector'
import type { Project } from '../../../../shared/project-types'
import type { BacklogLoadOutcome } from './backlog-snapshot'
import { BacklogCaptureDialog } from './BacklogCaptureDialog'
import { BacklogFilterStrip } from './BacklogFilterStrip'
import { BacklogGroupList } from './BacklogGroupList'
import { BacklogHeader } from './BacklogHeader'
import { BacklogNotices } from './BacklogNotices'
import { BacklogPageStateBlock, type BacklogBlockStatus } from './BacklogPageStateBlock'
import { useBacklogSnapshot } from './use-backlog-snapshot'

type BacklogPageStatus = BacklogBlockStatus | 'ready'

const LIVE_REGION_DELAY_MS = 300

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

function shownLabel(count: number): string {
  return count === 1
    ? translate('backlog.filters.shown_one', '{{count}} item shown', { count })
    : translate('backlog.filters.shown_other', '{{count}} items shown', { count })
}

/** Announces the visible count once filters settle; one timeout per change, never re-armed by itself. */
function useShownAnnouncement(filters: BacklogViewFilters, visibleCount: number | null): string {
  const [announcement, setAnnouncement] = useState('')
  const initial = useRef(filters)
  useEffect(() => {
    if (filters === initial.current || visibleCount === null) {
      return undefined
    }
    const timer = window.setTimeout(() => setAnnouncement(shownLabel(visibleCount)), LIVE_REGION_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [filters, visibleCount])
  return announcement
}

export default function BacklogPage(): React.JSX.Element {
  const closeBacklogPage = useAppStore((s) => s.closeBacklogPage)
  const projects = useAppStore((s) => s.projects)
  const { load, health, refreshFailed, refresh } = useBacklogSnapshot()
  // Renderer-local and regenerable (D-05): nothing here is persisted.
  const [filters, setFilters] = useState<BacklogViewFilters>(BACKLOG_DEFAULT_VIEW_FILTERS)
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
  const listed = (status === 'ready' || status === 'filter-empty') && view !== null
  const announcement = useShownAnnouncement(filters, view?.visibleCount ?? null)
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
        <BacklogHeader
          counts={listed ? view : null}
          onClose={closeBacklogPage}
          onCapture={() => setCaptureOpen(true)}
        />
        {listed && load?.status === 'ready' ? (
          <BacklogFilterStrip
            filters={filters}
            onChange={setFilters}
            scopeCounts={view.scopeCounts}
            projectsById={projectsById}
            rows={load.rows}
          />
        ) : null}
        {load !== null ? (
          <BacklogNotices
            load={load.status === 'ready' ? load : null}
            health={health}
            refreshFailed={refreshFailed}
            onRetry={refetch}
          />
        ) : null}
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
              onClearFilters={() =>
                setFilters((current) => ({ ...BACKLOG_DEFAULT_VIEW_FILTERS, sort: current.sort }))
              }
              onShowAllStates={() => setFilters((current) => ({ ...current, state: 'all' }))}
            />
          )}
        </section>
        <div data-backlog-live-region="" aria-live="polite" className="sr-only">
          {announcement}
        </div>
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
