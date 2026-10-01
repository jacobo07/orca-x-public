import { useMemo, useState } from 'react'
import { ChevronRight, RefreshCw, Search } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MissionBriefDialog } from '../mission-brief/MissionBriefDialog'
import { MissionBriefPanel } from '../mission-brief/MissionBriefPanel'
import { buildResumeCenterModel, type ResumeCenterSort } from './resume-center-model'
import { describeGreeting, describeWorkspaceName } from './resume-center-presentation'
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

export default function ResumeCenterPage(): React.JSX.Element {
  const openConversationsPage = useAppStore((s) => s.openConversationsPage)
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
  // Why identity by host + key: two hosts can hold a workspace with the same key.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fullBriefOpen, setFullBriefOpen] = useState(false)
  const rowId = (row: { hostId: string; key: string }): string => `${row.hostId}\u0000${row.key}`
  // Why the unfiltered rows: a search that hides the selected row does not close its brief.
  const selectedRow = deskRows.find((row) => rowId(row) === selectedId) ?? null
  const selectedName = selectedRow
    ? describeWorkspaceName(selectedRow.identity, selectedRow.key)
    : ''

  return (
    <div data-testid="resume-center-page" className="flex h-full min-h-0 flex-col overflow-hidden">
      <nav className="flex items-center gap-1 px-6 pt-4 text-[12px] text-muted-foreground">
        <button type="button" onClick={openConversationsPage} className="hover:text-foreground">
          {translate('resumeCenter.breadcrumb.workspace', 'Workspace')}
        </button>
        <ChevronRight className="size-3" aria-hidden />
        <span className="text-foreground">{translate('resumeCenter.title', 'Resume Center')}</span>
      </nav>

      <header className="flex flex-wrap items-end justify-between gap-4 px-6 pb-4 pt-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {describeGreeting(new Date().getHours(), firstName(displayName))}
          </h1>
          {model ? (
            <p className="mt-1 text-sm text-muted-foreground">
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
          <Button
            variant="outline"
            size="sm"
            data-testid="resume-center-refresh"
            onClick={() => {
              clearPanePreviewCache()
              refresh()
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {translate('resumeCenter.refresh', 'Refresh')}
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
        <div role="group" className="flex rounded-md border border-border text-[12px]">
          {(['window', 'recent'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={sort === option}
              onClick={() => setSort(option)}
              className="px-2.5 py-1 aria-pressed:bg-accent"
            >
              {option === 'window'
                ? translate('resumeCenter.sort.window', 'By window')
                : translate('resumeCenter.sort.recent', 'Most recent')}
            </button>
          ))}
        </div>
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
                selected={rowId(row) === selectedId}
                onSelect={() =>
                  setSelectedId((current) => (current === rowId(row) ? null : rowId(row)))
                }
              />
            ))
          )}
        </div>
        {model ? (
          <div
            data-testid="resume-center-aside"
            className={
              selectedRow ? 'flex w-[26rem] shrink-0 flex-col gap-3' : 'flex shrink-0 flex-col'
            }
          >
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
            <ResumeCenterSummaryPanel
              model={model}
              className={selectedRow ? 'w-full' : undefined}
            />
          </div>
        ) : null}
      </div>
      {selectedRow ? (
        <MissionBriefDialog
          row={selectedRow}
          projectName={selectedName}
          open={fullBriefOpen}
          onOpenChange={setFullBriefOpen}
        />
      ) : null}
    </div>
  )
}
