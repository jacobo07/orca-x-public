import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleHelp } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { backlogSourceLabel } from '@/lib/backlog-source-labels'
import { useAppStore } from '@/store'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import type {
  BacklogItem,
  BacklogItemEventType,
  BacklogItemState
} from '../../../../shared/backlog-types'
import type { Project } from '../../../../shared/project-types'
import { getBacklogItem, type BacklogGetOutcome } from './backlog-client'
import type { BacklogMutationOutcome } from './backlog-mutation-client'
import { backlogKindLabel, backlogPriorityLabel, backlogStateLabel } from './backlog-presentation'
import { BacklogStateMenu } from './BacklogStateMenu'

/** A confirmed (or unconfirmable) ledger write the page must refetch for. */
export type BacklogLedgerChange = {
  itemId: string
  groupKey: string
  movedTo: BacklogItemState | null
}

type DetailState = { status: 'loading' } | BacklogGetOutcome
type DetailNotice = { alert: boolean; text: string }

function relative(at: number): string {
  return formatUiRelativeTime(at - Date.now())
}

function eventLabel(type: BacklogItemEventType): string {
  switch (type) {
    case 'created':
      return translate('backlog.history.created', 'Created')
    case 'updated':
      return translate('backlog.history.updated', 'Updated')
    case 'transitioned':
      return translate('backlog.history.transitioned', 'State changed')
    case 'source-linked':
      return translate('backlog.history.sourceLinked', 'Source linked')
    case 'merged-in':
      return translate('backlog.history.mergedIn', 'Merged in')
    case 'merged-into':
      return translate('backlog.history.mergedInto', 'Merged into')
  }
}

function failureCopy(state: Exclude<DetailState, { status: 'loading' | 'loaded' }>): string {
  switch (state.status) {
    case 'absent':
      return translate('backlog.detail.absent', 'This item is no longer in the backlog.')
    case 'unreadable':
      return translate('backlog.detail.unreadable', 'This item cannot be read right now.')
    case 'schema-too-new':
      return translate(
        'backlog.detail.schemaTooNew',
        'This item was saved by a newer version of Orca.'
      )
    case 'storage-failed':
    case 'capability-unsupported':
    case 'forbidden':
    case 'unreachable':
      return translate(
        'backlog.detail.loadFailed',
        'This item could not be loaded. Collapse and expand the row to try again.'
      )
  }
}

function Section({
  heading,
  children
}: {
  heading: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">{heading}</h3>
      {children}
    </div>
  )
}

function ProjectRefs({
  item,
  projectsById
}: {
  item: BacklogItem
  projectsById: ReadonlyMap<string, Project>
}): React.JSX.Element {
  if (item.projectRefs.length === 0) {
    return <p>{translate('backlog.group.unassigned', 'Unassigned')}</p>
  }
  return (
    <ul className="space-y-1">
      {item.projectRefs.map((ref) => {
        const project = projectsById.get(ref.projectId)
        return (
          <li
            key={ref.projectId}
            data-backlog-detail-project={ref.projectId}
            className="flex items-center gap-2"
          >
            {project ? (
              <RepoBadgeMark color={project.badgeColor} className="size-2 rounded-full" />
            ) : (
              <CircleHelp className="size-3.5 text-[var(--status-unknown)]" aria-hidden />
            )}
            <span>
              {project
                ? project.displayName
                : translate('backlog.group.unknown', 'Unknown project')}
            </span>
            {project ? null : (
              <span className="font-mono text-muted-foreground">{ref.projectId}</span>
            )}
            <span className="text-muted-foreground">
              {ref.mapping === 'explicit'
                ? translate('backlog.detail.explicit', 'Explicit')
                : translate('backlog.detail.inferred', 'Inferred')}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function LoadedDetail({
  item,
  actions
}: {
  item: BacklogItem
  actions: React.ReactNode
}): React.JSX.Element {
  const projects = useAppStore((s) => s.projects)
  const projectsById = useMemo(
    () => new Map<string, Project>(projects.map((project) => [project.id, project])),
    [projects]
  )
  const intent = item.normalizedIntent.trim()
  const events = [...item.events].sort((a, b) => b.at - a.at)
  const fields: [string, string][] = [
    [translate('backlog.detail.kind', 'Kind'), backlogKindLabel(item.kind)],
    [translate('backlog.detail.priority', 'Priority'), backlogPriorityLabel(item.priority)],
    [translate('backlog.detail.state', 'State'), backlogStateLabel(item.state)],
    [translate('backlog.detail.created', 'Created'), relative(item.createdAt)],
    [translate('backlog.detail.updated', 'Updated'), relative(item.updatedAt)]
  ]
  const none = translate('backlog.detail.none', 'None')
  return (
    <>
      <div
        data-backlog-detail-text=""
        tabIndex={0}
        aria-label={translate('backlog.capture.textLabel', 'Item text')}
        className="scrollbar-sleek max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {item.originalText}
      </div>
      {intent !== '' && intent !== item.originalText.trim() ? (
        <Section heading={translate('backlog.detail.summary', 'Summary')}>
          <p data-backlog-detail-summary="">{intent}</p>
        </Section>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {fields.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Section heading={translate('backlog.detail.projects', 'Projects')}>
        <ProjectRefs item={item} projectsById={projectsById} />
      </Section>
      <Section heading={translate('backlog.detail.sources', 'Sources')}>
        {item.sourceLinks.length === 0 ? (
          <p>{none}</p>
        ) : (
          <ul className="space-y-1">
            {item.sourceLinks.map((link) => (
              <li key={`${link.kind}:${link.ref}`} data-backlog-detail-source={link.kind}>
                {backlogSourceLabel(link.kind)}{' '}
                <span className="text-muted-foreground">{relative(link.capturedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section heading={translate('backlog.detail.history', 'History')}>
        <ol className="space-y-1">
          {events.map((event) => (
            <li key={event.id} data-backlog-event={event.type}>
              {eventLabel(event.type)}{' '}
              <span className="text-muted-foreground">{relative(event.at)}</span>
            </li>
          ))}
        </ol>
      </Section>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </>
  )
}

/** Expanded row: the full record read with backlog.get on mount, never inferred from a summary row. */
export function BacklogRowDetail({
  id,
  itemId,
  title,
  groupKey,
  onLedgerChanged
}: {
  id: string
  itemId: string
  title: string
  groupKey: string
  onLedgerChanged: (change: BacklogLedgerChange) => void
}): React.JSX.Element {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [notice, setNotice] = useState<DetailNotice | null>(null)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    generation.current += 1
    const mine = generation.current
    const outcome = await getBacklogItem({ activeRuntimeEnvironmentId: environmentId }, itemId)
    if (mine === generation.current) {
      setState(outcome)
    }
  }, [environmentId, itemId])

  useEffect(() => {
    void reload()
    return () => {
      generation.current += 1
    }
  }, [reload])

  const onTransition = (outcome: BacklogMutationOutcome, to: BacklogItemState): void => {
    switch (outcome.status) {
      case 'confirmed':
        generation.current += 1
        setState({ status: 'loaded', item: outcome.item })
        setNotice(null)
        onLedgerChanged({ itemId, groupKey, movedTo: to })
        return
      case 'stale':
        setNotice({
          alert: false,
          text: translate(
            'backlog.detail.stale',
            'This item changed since it was loaded. It has been reloaded; try again.'
          )
        })
        void reload()
        return
      case 'unknown':
        setNotice({
          alert: false,
          text: translate(
            'backlog.detail.transitionUnknown',
            'We could not confirm this change. The item has been reloaded.'
          )
        })
        void reload()
        onLedgerChanged({ itemId, groupKey, movedTo: null })
        return
      default:
        setNotice({
          alert: true,
          text: translate(
            'backlog.detail.mutationFailed',
            'Not changed. The ledger could not write this change. Try again.'
          )
        })
    }
  }

  return (
    <div
      id={id}
      role="region"
      aria-label={title}
      data-backlog-item-detail=""
      data-backlog-detail-status={state.status}
      className="space-y-4 px-4 pt-2 pb-4 text-[12px]"
    >
      {state.status === 'loading' ? (
        <p className="text-muted-foreground">
          {translate('backlog.detail.loading', 'Loading item…')}
        </p>
      ) : state.status === 'loaded' ? (
        <LoadedDetail
          item={state.item}
          actions={<BacklogStateMenu item={state.item} onOutcome={onTransition} />}
        />
      ) : (
        <p className="text-muted-foreground">{failureCopy(state)}</p>
      )}
      {notice ? (
        <p
          role={notice.alert ? 'alert' : 'status'}
          className={
            notice.alert
              ? 'rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-destructive'
              : 'text-muted-foreground'
          }
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  )
}
