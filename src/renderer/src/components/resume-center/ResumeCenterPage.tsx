import { useEffect, useMemo, useState } from 'react'
import { LayoutPanelLeft, RefreshCw, Search } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { WorkspaceFrame } from '../workspace-frame/WorkspaceFrame'
import { MissionBriefDialog } from '../mission-brief/MissionBriefDialog'
import { MissionBriefPanel } from '../mission-brief/MissionBriefPanel'
import { probeMissionRecordsInto } from '../mission-brief/use-mission-records-presence'
import { buildResumeCenterModel, type ResumeCenterSort } from './resume-center-model'
import {
  describeGreeting,
  describeWindowsWith,
  describeWorkspaceName
} from './resume-center-presentation'
import { restoreWorkspaceLayoutOnly } from './resume-center-restore'
import { greetingWindowCount } from './resume-center-workspace-facts'
import { useDeskContinuity } from './use-desk-continuity'
import { clearPanePreviewCache } from './use-pane-preview'
import { ClaimValue } from './ClaimValue'
import { ResumeCenterResumeAll } from './ResumeCenterResumeAll'
import { ResumeCenterSummaryPanel } from './ResumeCenterSummaryPanel'
import { ResumeCenterWorkspaceSection } from './ResumeCenterWorkspaceSection'

function firstName(displayName: string | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0]
  return first ? first : null
}

const SORT_LABEL: Record<ResumeCenterSort, () => string> = {
  window: () => translate('resumeCenter.sort.window', 'By window'),
  recent: () => translate('resumeCenter.sort.recent', 'Most recent')
}

export default function ResumeCenterPage(): React.JSX.Element {
  const displayName = useAppStore((s) => s.orcaProfileAuthStatus?.cloud?.displayName)
  const { state, refresh } = useDeskContinuity()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ResumeCenterSort>('window')
  const model = useMemo(
    () =>
      state.status === 'loaded' ? buildResumeCenterModel(state.projection, { query, sort }) : null,
    [state, query, sort]
  )
  // Why unfiltered: a search narrows what is shown, never what Resume all covers.
  const deskRows = useMemo(
    () =>
      state.status === 'loaded'
        ? buildResumeCenterModel(state.projection, { query: '', sort: 'window' }).workspaces
        : [],
    [state]
  )
  // Why per desk read: one batched stat probe marks every row that has a brief, before any click.
  useEffect(() => {
    if (deskRows.length > 0) {
      void probeMissionRecordsInto(deskRows)
    }
  }, [deskRows])
  // Why identity by host + key: two hosts can hold a workspace with the same key.
  // undefined = follow the most recent workspace, so the brief is on screen on arrival; null = the
  // person deselected, which is respected rather than re-filled.
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined)
  const [fullBriefOpen, setFullBriefOpen] = useState(false)
  const rowId = (row: { hostId: string; key: string }): string => `${row.hostId}\u0000${row.key}`
  const mostRecentId = useMemo(() => {
    if (state.status !== 'loaded') {
      return null
    }
    const first = buildResumeCenterModel(state.projection, { query: '', sort: 'recent' })
      .workspaces[0]
    return first ? rowId(first) : null
  }, [state])
  const effectiveSelectedId = selectedId === undefined ? mostRecentId : selectedId
  // Why the unfiltered rows: a search that hides the selected row does not close its brief.
  const selectedRow = deskRows.find((row) => rowId(row) === effectiveSelectedId) ?? null
  const selectedName = selectedRow
    ? describeWorkspaceName(selectedRow.identity, selectedRow.key)
    : ''
  const windows = model ? greetingWindowCount(model) : null

  const context = model ? (
    <div data-testid="resume-center-aside" className="flex flex-col gap-3">
      {selectedRow ? (
        <MissionBriefPanel
          hostId={selectedRow.hostId}
          workspaceKey={selectedRow.key}
          projectName={selectedName}
          row={selectedRow}
          variant="compact"
          onOpenFull={() => setFullBriefOpen(true)}
        />
      ) : null}
      <ResumeCenterSummaryPanel model={model} className="w-full" />
    </div>
  ) : null

  return (
    <WorkspaceFrame context={context} testId="resume-center-page">
      <header className="flex flex-wrap items-start justify-between gap-4 px-6 pb-4 pt-5">
        <div>
          <h1 className="text-2xl font-semibold">
            {describeGreeting(new Date().getHours(), firstName(displayName))}
          </h1>
          {model ? (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="resume-center-greeting">
              {windows !== null ? (
                <>
                  <ClaimValue testId="resume-center-greeting-windows">{windows}</ClaimValue>{' '}
                  {describeWindowsWith(windows)}{' '}
                </>
              ) : null}
              <ClaimValue testId="resume-center-greeting-sessions">{model.totals.tabs}</ClaimValue>{' '}
              {translate('resumeCenter.greeting.sessions', 'sessions on your desk')}
              {' · '}
              <ClaimValue testId="resume-center-greeting-running">
                {model.totals.byResidency.warm}
              </ClaimValue>{' '}
              {translate('resumeCenter.greeting.running', 'running')}
            </p>
          ) : null}
        </div>
        <div className="flex items-start gap-2">
          {deskRows.length > 0 ? <ResumeCenterResumeAll rows={deskRows} /> : null}
          {/* Why the selected workspace only: a desk-wide layout restore has no owner yet. */}
          <Button
            variant="outline"
            data-testid="resume-center-restore-layout"
            disabled={!selectedRow || selectedRow.identity.kind === 'missing'}
            onClick={() => {
              if (selectedRow) {
                void restoreWorkspaceLayoutOnly(selectedRow)
              }
            }}
            className="h-auto max-w-64 items-start gap-2.5 px-4 py-2 text-left"
          >
            <LayoutPanelLeft className="mt-0.5 size-4" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium">
                {translate('resumeCenter.restoreLayout.title', 'Restore layout only')}
              </span>
              <span className="truncate text-[11px] font-normal text-muted-foreground">
                {selectedRow
                  ? translate('resumeCenter.restoreLayout.hint', '{{name}}, starts nothing', {
                      name: selectedName
                    })
                  : translate('resumeCenter.restoreLayout.none', 'Select a workspace')}
              </span>
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="resume-center-refresh"
            aria-label={translate('resumeCenter.refresh', 'Refresh')}
            title={translate('resumeCenter.refresh', 'Refresh')}
            onClick={() => {
              clearPanePreviewCache()
              refresh()
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </Button>
        </div>
      </header>

      <div className="flex items-center gap-2 px-6 pb-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={translate('resumeCenter.search', 'Search workspaces and sessions')}
            className="h-8 pl-7 text-[13px]"
          />
        </div>
        <Select value={sort} onValueChange={(value) => setSort(value as ResumeCenterSort)}>
          <SelectTrigger
            size="sm"
            data-testid="resume-center-sort"
            aria-label={translate('resumeCenter.sort.label', 'Sort')}
            className="w-44 text-[13px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['window', 'recent'] as const).map((option) => (
              <SelectItem key={option} value={option}>
                {SORT_LABEL[option]()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="scrollbar-sleek flex min-h-0 flex-1 gap-4 overflow-y-auto px-6 pb-6">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {state.status === 'loading' ? (
            <p className="text-sm text-muted-foreground">
              {translate('resumeCenter.state.loading', 'Reading your desk…')}
            </p>
          ) : state.status === 'unavailable' ? (
            <p className="text-sm text-muted-foreground">
              {translate('resumeCenter.state.unavailable', 'This client does not hold a desk.')}
            </p>
          ) : state.status === 'failed' ? (
            <p className="text-sm text-muted-foreground">
              {translate('resumeCenter.state.failed', 'The desk could not be read.')}
            </p>
          ) : model && model.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {query
                ? translate('resumeCenter.state.noMatch', 'Nothing matches that search.')
                : translate(
                    'resumeCenter.state.empty',
                    'No workspaces with sessions on this desk.'
                  )}
            </p>
          ) : (
            model?.workspaces.map((row) => (
              <ResumeCenterWorkspaceSection
                key={rowId(row)}
                row={row}
                selected={rowId(row) === effectiveSelectedId}
                onSelect={() =>
                  setSelectedId(effectiveSelectedId === rowId(row) ? null : rowId(row))
                }
                onShowBrief={() => setSelectedId(rowId(row))}
              />
            ))
          )}
        </div>
      </div>
      {selectedRow ? (
        <MissionBriefDialog
          row={selectedRow}
          projectName={selectedName}
          open={fullBriefOpen}
          onOpenChange={setFullBriefOpen}
        />
      ) : null}
    </WorkspaceFrame>
  )
}
