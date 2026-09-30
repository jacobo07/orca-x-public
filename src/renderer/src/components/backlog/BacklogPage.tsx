import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  BACKLOG_DEFAULT_VIEW_FILTERS,
  selectBacklogView,
  type BacklogViewFilters,
  type BacklogViewModel
} from '../../../../shared/backlog-view-selector'
import type { Project } from '../../../../shared/project-types'
import { backlogStateLabel } from './backlog-presentation'
import type { BacklogLoadOutcome } from './backlog-snapshot'
import { BacklogCaptureDialog } from './BacklogCaptureDialog'
import { BacklogFilterStrip } from './BacklogFilterStrip'
import { BacklogGroupList } from './BacklogGroupList'
import { BacklogHeader } from './BacklogHeader'
import { BacklogNotices } from './BacklogNotices'
import { BacklogPageStateBlock, type BacklogBlockStatus } from './BacklogPageStateBlock'
import type { BacklogLedgerChange } from './BacklogRowDetail'
import { BacklogSummaryPanel } from './BacklogSummaryPanel'
import { useBacklogPageKeys } from './use-backlog-page-keys'
import { useBacklogSnapshot } from './use-backlog-snapshot'

type BacklogPageStatus = BacklogBlockStatus | 'ready'
type FocusRequest = { itemId: string; groupKey: string; order: readonly string[] }

function byAttribute(scope: ParentNode | null, name: string, value: string): Element | null {
  for (const element of scope?.querySelectorAll(`[${name}]`) ?? []) {
    if (element.getAttribute(name) === value) {
      return element
    }
  }
  return null
}

function rowIdsIn(group: Element | null): string[] {
  return Array.from(group?.querySelectorAll('[data-backlog-item-id]') ?? []).map(
    (row) => row.getAttribute('data-backlog-item-id') ?? ''
  )
}

/** After the refetch: a row that left the view hands focus to the next row, else the group toggle. */
function useFocusAfterMove(
  page: React.RefObject<HTMLDivElement | null>
): (r: FocusRequest) => void {
  const [request, setRequest] = useState<FocusRequest | null>(null)
  useEffect(() => {
    if (!request) {
      return
    }
    const group = byAttribute(page.current, 'data-backlog-group', request.groupKey)
    const toggleOf = (id: string): HTMLElement | null =>
      byAttribute(group, 'data-backlog-item-id', id)?.querySelector<HTMLElement>(
        '[data-backlog-row-toggle]'
      ) ?? null
    if (toggleOf(request.itemId)) {
      return
    }
    const after = request.order.slice(request.order.indexOf(request.itemId) + 1)
    const next = after.map(toggleOf).find((toggle) => toggle !== null)
    ;(next ?? group?.querySelector<HTMLElement>('[data-backlog-group-toggle]'))?.focus()
  }, [page, request])
  return setRequest
}

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
    const timer = window.setTimeout(
      () => setAnnouncement(shownLabel(visibleCount)),
      LIVE_REGION_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [filters, visibleCount])
  return announcement
}

export default function BacklogPage(): React.JSX.Element {
  const closeBacklogPage = useAppStore((s) => s.closeBacklogPage)
  const projects = useAppStore((s) => s.projects)
  const { load, health, refreshFailed, refresh, refreshHealth } = useBacklogSnapshot()
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
  const pageRef = useRef<HTMLDivElement>(null)
  const [moved, setMoved] = useState('')
  const requestFocus = useFocusAfterMove(pageRef)

  // Confirmed by the ledger; the row itself moves only when the refetch answers.
  const onLedgerChanged = (change: BacklogLedgerChange): void => {
    const movedTo = change.movedTo
    if (movedTo === null) {
      refetch()
      return
    }
    const text = translate('backlog.row.moved', 'Moved to {{state}}', {
      state: backlogStateLabel(movedTo)
    })
    toast(text)
    setMoved(text)
    const order = rowIdsIn(byAttribute(pageRef.current, 'data-backlog-group', change.groupKey))
    void refresh().then(() => requestFocus({ ...change, order }))
  }

  const captureButtonRef = useRef<HTMLButtonElement>(null)
  // Focus returns to what opened capture; opened by N from the body, that is the Capture button.
  const openerRef = useRef<HTMLElement | null>(null)
  const openCapture = useCallback((): void => {
    const active = document.activeElement
    openerRef.current =
      active instanceof HTMLElement && pageRef.current?.contains(active)
        ? active
        : captureButtonRef.current
    setCaptureOpen(true)
  }, [])
  const onCaptureOpenChange = (next: boolean): void => {
    if (!next && !openerRef.current?.isConnected) {
      openerRef.current = captureButtonRef.current
    }
    setCaptureOpen(next)
  }
  useBacklogPageKeys({ onCapture: openCapture, onClose: closeBacklogPage, captureOpen })

  return (
    <div
      ref={pageRef}
      data-backlog-page=""
      data-backlog-status={status}
      data-backlog-failure-stage={failure?.stage}
      data-backlog-failure-code={failure?.code ?? undefined}
      className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground"
    >
      {/* Layout ownership: the aside owns its width (lg:w-72); the main column takes the rest. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 px-4 pt-2 pb-4 md:px-8 md:pb-8 lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <BacklogHeader
            counts={listed ? view : null}
            onClose={closeBacklogPage}
            onCapture={openCapture}
            captureRef={captureButtonRef}
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
              <BacklogGroupList
                groups={view?.groups ?? []}
                projectsById={projectsById}
                onLedgerChanged={onLedgerChanged}
              />
            ) : (
              <BacklogPageStateBlock
                status={status}
                filterEmpty={view?.filterEmpty ?? null}
                onRetry={refetch}
                onCapture={openCapture}
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
          <div data-backlog-moved-region="" aria-live="polite" className="sr-only">
            {moved}
          </div>
        </div>
        {status === 'loading' || status === 'empty' || listed ? (
          <BacklogSummaryPanel health={health} onRetry={() => void refreshHealth()} />
        ) : null}
      </div>
      <BacklogCaptureDialog
        open={captureOpen}
        onOpenChange={onCaptureOpenChange}
        onConfirmed={refetch}
        onUncertain={refetch}
        returnFocusTo={openerRef}
      />
    </div>
  )
}
