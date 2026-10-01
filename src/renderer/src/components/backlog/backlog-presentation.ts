// Tone and translated labels for Backlog states, kinds and priorities. No class strings here: the
// tone-to-mark map lives in a component file so status colour has exactly one owner.
import { translate } from '@/i18n/i18n'
import type {
  BacklogItemKind,
  BacklogItemState,
  BacklogPriority
} from '../../../../shared/backlog-types'

export type BacklogTone = 'critical' | 'pressured' | 'unknown' | 'idle' | 'plain'

export function backlogStateTone(state: BacklogItemState): BacklogTone {
  switch (state) {
    case 'blocked':
      return 'critical'
    case 'needs-triage':
    case 'review':
      return 'pressured'
    case 'unknown':
    case 'stale':
      return 'unknown'
    case 'done':
    case 'dismissed':
    case 'superseded':
      return 'idle'
    case 'ready':
    case 'waiting-for-executor':
    case 'preparing':
    case 'running':
      return 'plain'
  }
}

export function backlogStateLabel(state: BacklogItemState): string {
  switch (state) {
    case 'needs-triage':
      return translate('backlog.state.needsTriage', 'Needs triage')
    case 'ready':
      return translate('backlog.state.ready', 'Ready')
    case 'waiting-for-executor':
      return translate('backlog.state.waitingForExecutor', 'Waiting for executor')
    case 'preparing':
      return translate('backlog.state.preparing', 'Preparing')
    case 'running':
      return translate('backlog.state.running', 'Running')
    case 'review':
      return translate('backlog.state.review', 'In review')
    case 'done':
      return translate('backlog.state.done', 'Done')
    case 'blocked':
      return translate('backlog.state.blocked', 'Blocked')
    case 'stale':
      return translate('backlog.state.stale', 'Stale')
    case 'superseded':
      return translate('backlog.state.superseded', 'Superseded')
    case 'dismissed':
      return translate('backlog.state.dismissed', 'Dismissed')
    case 'unknown':
      return translate('backlog.state.unknown', 'Unknown')
  }
}

export function backlogKindLabel(kind: BacklogItemKind): string {
  switch (kind) {
    case 'engineering':
      return translate('backlog.kind.engineering', 'Engineering')
    case 'research':
      return translate('backlog.kind.research', 'Research')
    case 'decision':
      return translate('backlog.kind.decision', 'Decision')
    case 'manual':
      return translate('backlog.kind.manual', 'Manual task')
    case 'idea':
      return translate('backlog.kind.idea', 'Idea')
  }
}

export function backlogPriorityLabel(priority: BacklogPriority): string {
  switch (priority) {
    case 'urgent':
      return translate('backlog.priority.urgent', 'Urgent')
    case 'high':
      return translate('backlog.priority.high', 'High')
    case 'normal':
      return translate('backlog.priority.normal', 'Normal')
    case 'low':
      return translate('backlog.priority.low', 'Low')
  }
}
