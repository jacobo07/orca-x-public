import { useId, useState } from 'react'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { BACKLOG_NORMALIZED_INTENT_MAX } from '../../../../shared/backlog-rpc-limits'
import {
  BACKLOG_ITEM_KINDS,
  BACKLOG_PRIORITIES,
  type BacklogItem,
  type BacklogProjectRef
} from '../../../../shared/backlog-types'
import {
  updateBacklogItem,
  type BacklogEditablePatch,
  type BacklogMutationOutcome
} from './backlog-mutation-client'
import { backlogKindLabel, backlogPriorityLabel } from './backlog-presentation'
import { BacklogProjectPicker } from './BacklogProjectPicker'

/** Ctrl+Enter on Windows/Linux, Cmd+Enter on Mac; the other modifier does nothing. */
export function isBacklogSubmitChord(event: React.KeyboardEvent): boolean {
  const isMac = navigator.userAgent.includes('Mac')
  return event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)
}

export function backlogCharactersLeft(left: number): string {
  return `${new Intl.NumberFormat(getIntlLocale()).format(left)} ${translate(
    'backlog.capture.charactersLeft',
    'characters left'
  )}`
}

export function BacklogChoiceSelect<T extends string>({
  handle,
  value,
  label,
  options,
  onValueChange,
  disabled = false
}: {
  handle: Record<`data-${string}`, string>
  value: T
  label: string
  options: readonly { value: T; label: string }[]
  onValueChange: (value: T) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const chosen = options.find((option) => option.value === next)
        if (chosen) {
          onValueChange(chosen.value)
        }
      }}
    >
      <SelectTrigger
        size="sm"
        className="h-8 w-full text-[12px]"
        data-value={value}
        aria-label={label}
        {...handle}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} data-backlog-option={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export const KIND_OPTIONS = (): { value: BacklogItem['kind']; label: string }[] =>
  BACKLOG_ITEM_KINDS.map((kind) => ({ value: kind, label: backlogKindLabel(kind) }))

export const PRIORITY_OPTIONS = (): { value: BacklogItem['priority']; label: string }[] =>
  BACKLOG_PRIORITIES.map((priority) => ({ value: priority, label: backlogPriorityLabel(priority) }))

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}

// Kept refs keep their mapping and evidence: an inferred ref is never rewritten as explicit.
function nextRefs(item: BacklogItem, ids: readonly string[]): BacklogProjectRef[] {
  return ids.map(
    (projectId) =>
      item.projectRefs.find((ref) => ref.projectId === projectId) ?? {
        projectId,
        mapping: 'explicit',
        evidence: ''
      }
  )
}

function refusedCopy(outcome: BacklogMutationOutcome): string {
  if (outcome.status === 'refused' && outcome.code === 'kind-change-while-done') {
    return translate('backlog.edit.kindWhileDone', 'The kind cannot change while the item is done.')
  }
  if (outcome.status === 'refused' && outcome.code === 'item-capacity-exceeded') {
    return translate('backlog.edit.capacity', 'This item has reached its size limit.')
  }
  return translate(
    'backlog.detail.mutationFailed',
    'Not changed. The ledger could not write this change. Try again.'
  )
}

export type BacklogEditEnd =
  | { kind: 'confirmed'; item: BacklogItem }
  | { kind: 'reload'; reason: 'stale' | 'unknown' }
  | { kind: 'discarded' }

/** Inline edit of what may change after capture. originalText is shown, never editable (R-03). */
export function BacklogRowEditForm({
  item,
  onEnd
}: {
  item: BacklogItem
  onEnd: (end: BacklogEditEnd) => void
}): React.JSX.Element {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const summaryId = useId()
  const [summary, setSummary] = useState(item.normalizedIntent)
  const [kind, setKind] = useState(item.kind)
  const [priority, setPriority] = useState(item.priority)
  const [projectIds, setProjectIds] = useState(() => item.projectRefs.map((ref) => ref.projectId))
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const trimmed = summary.trim()
  const summaryChanged = trimmed !== item.normalizedIntent.trim()
  const summaryInvalid =
    summary.length > BACKLOG_NORMALIZED_INTENT_MAX || (summaryChanged && trimmed === '')
  const patch: BacklogEditablePatch = {}
  if (summaryChanged) {
    patch.normalizedIntent = trimmed
  }
  if (kind !== item.kind) {
    patch.kind = kind
  }
  if (priority !== item.priority) {
    patch.priority = priority
  }
  const originalIds = item.projectRefs.map((ref) => ref.projectId)
  if (!sameIds(projectIds, originalIds)) {
    patch.projectRefs = nextRefs(item, projectIds)
  }
  const canSave = Object.keys(patch).length > 0 && !summaryInvalid && !pending
  const left = BACKLOG_NORMALIZED_INTENT_MAX - summary.length

  const save = async (): Promise<void> => {
    if (!canSave) {
      return
    }
    setPending(true)
    setFailure(null)
    const outcome = await updateBacklogItem(
      { activeRuntimeEnvironmentId: environmentId },
      item.id,
      patch
    )
    setPending(false)
    if (outcome.status === 'confirmed') {
      onEnd({ kind: 'confirmed', item: outcome.item })
    } else if (outcome.status === 'stale' || outcome.status === 'unknown') {
      onEnd({ kind: 'reload', reason: outcome.status })
    } else {
      setFailure(refusedCopy(outcome))
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Events from portalled menus bubble through React; an open layer already handled its Esc.
    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onEnd({ kind: 'discarded' })
    } else if (isBacklogSubmitChord(event)) {
      event.preventDefault()
      void save()
    }
  }

  return (
    <div data-backlog-edit-form="" onKeyDown={onKeyDown} className="space-y-4">
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {translate('backlog.edit.original', 'Original text')}
        </p>
        <div
          data-backlog-edit-original=""
          className="scrollbar-sleek max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 px-3 py-2 text-muted-foreground"
        >
          {item.originalText}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={summaryId} className="text-xs">
          {translate('backlog.detail.summary', 'Summary')}
        </Label>
        <Textarea
          id={summaryId}
          autoFocus
          value={summary}
          disabled={pending}
          onChange={(event) => setSummary(event.target.value)}
          aria-label={translate('backlog.detail.summary', 'Summary')}
          aria-invalid={summaryInvalid}
          data-backlog-edit-field="summary"
          className="max-h-48 min-h-20 text-sm"
        />
        {left < 0 ? (
          <p className="text-right text-xs text-destructive">
            {translate('backlog.edit.overLimit', 'Summary is over the 2,000-character limit')}
          </p>
        ) : left <= BACKLOG_NORMALIZED_INTENT_MAX / 10 ? (
          <p data-backlog-edit-counter="" className="text-right text-xs text-muted-foreground">
            {backlogCharactersLeft(left)}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <p className="text-xs font-medium">{translate('backlog.detail.kind', 'Kind')}</p>
          <BacklogChoiceSelect
            handle={{ 'data-backlog-edit-field': 'kind' }}
            value={kind}
            label={translate('backlog.detail.kind', 'Kind')}
            options={KIND_OPTIONS()}
            onValueChange={setKind}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium">{translate('backlog.detail.priority', 'Priority')}</p>
          <BacklogChoiceSelect
            handle={{ 'data-backlog-edit-field': 'priority' }}
            value={priority}
            label={translate('backlog.detail.priority', 'Priority')}
            options={PRIORITY_OPTIONS()}
            onValueChange={setPriority}
            disabled={pending}
          />
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">{translate('backlog.detail.projects', 'Projects')}</p>
        <BacklogProjectPicker
          selected={projectIds}
          onChange={setProjectIds}
          handle={{ 'data-backlog-edit-field': 'project' }}
          disabled={pending}
        />
      </div>
      {failure ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-destructive"
        >
          {failure}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canSave}
          data-backlog-action="save-edit"
          onClick={() => void save()}
        >
          {translate('backlog.edit.save', 'Save changes')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-backlog-action="discard-edit"
          onClick={() => onEnd({ kind: 'discarded' })}
        >
          {translate('backlog.edit.discard', 'Discard changes')}
        </Button>
      </div>
    </div>
  )
}
