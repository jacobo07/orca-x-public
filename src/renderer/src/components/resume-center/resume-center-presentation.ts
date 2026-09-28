import { translate } from '@/i18n/i18n'
import type {
  DeskResidency,
  DeskWindowMembership,
  DeskWorkspaceIdentity
} from '../../../../shared/desk-continuity-projection'
import type { DormantResumeContinuity } from '../../../../shared/terminal-tab-types'
import type { PanePreviewResult } from '../../../../shared/desk-continuity-read-types'

/**
 * Words and tones for the Resume Center, from the desk projection's own answers. A process is
 * warm only when a host listed it; everything this surface could not observe says so.
 */
export type ContinuityTone = 'warm' | 'dormant' | 'stopped' | 'unknown'

export function residencyTone(residency: DeskResidency): ContinuityTone {
  switch (residency) {
    case 'warm':
      return 'warm'
    case 'dormant':
      return 'dormant'
    case 'no-process':
      return 'stopped'
    case 'unknown':
      return 'unknown'
  }
}

export function describeResidency(residency: DeskResidency): string {
  switch (residency) {
    case 'warm':
      return translate('resumeCenter.residency.warm', 'Running')
    case 'dormant':
      return translate('resumeCenter.residency.dormant', 'Sleeping')
    case 'no-process':
      return translate('resumeCenter.residency.stopped', 'Not running')
    case 'unknown':
      return translate('resumeCenter.residency.unknown', 'State unknown')
  }
}

/** What resuming may promise. `unconfirmed` is an attempt, never an exact resume. */
export function describeResumeVerdict(verdict: DormantResumeContinuity): string | null {
  switch (verdict) {
    case 'exact':
      return translate('resumeCenter.resume.exact', 'Resumes the same session')
    case 'unconfirmed':
      return translate('resumeCenter.resume.unconfirmed', 'Will try to resume the session')
    case 'claimed-elsewhere':
      return translate('resumeCenter.resume.claimedElsewhere', 'Session is open elsewhere')
    case 'none':
      return null
  }
}

export function describeWorkspaceName(identity: DeskWorkspaceIdentity, key: string): string {
  switch (identity.kind) {
    case 'known':
      return identity.name
    case 'missing':
      return translate('resumeCenter.workspace.missing', 'Workspace no longer exists')
    case 'unknown':
      return key
  }
}

export function describeWindow(membership: DeskWindowMembership, order: number | null): string {
  if (membership.kind === 'bound') {
    return order === null
      ? translate('resumeCenter.window.bound', 'Window')
      : translate('resumeCenter.window.numbered', 'Window {{number}}', { number: order })
  }
  switch (membership.reason) {
    case 'folder-workspace':
    case 'no-window-binding':
      return translate('resumeCenter.window.none', 'No window')
    case 'windows-unrecorded':
      return translate('resumeCenter.window.unrecorded', 'Window not recorded')
  }
}

export function describePreviewAbsence(result: PanePreviewResult): string | null {
  switch (result.status) {
    case 'rendered':
      return null
    case 'none':
      return translate('resumeCenter.preview.none', 'Nothing recorded')
    case 'unreadable':
      return translate('resumeCenter.preview.unreadable', 'Recorded, but could not be read')
    case 'not-found':
      return translate('resumeCenter.preview.notFound', 'No longer on the desk')
    case 'invalid-request':
    case 'unavailable':
      return translate('resumeCenter.preview.unavailable', 'Preview unavailable')
  }
}

/** Morning before 12, afternoon before 20, evening after: from this machine's clock. */
export function describeGreeting(hour: number, name: string | null): string {
  const key =
    hour < 12
      ? 'resumeCenter.greeting.morning'
      : hour < 20
        ? 'resumeCenter.greeting.afternoon'
        : 'resumeCenter.greeting.evening'
  const fallback = hour < 12 ? 'Good morning' : hour < 20 ? 'Good afternoon' : 'Good evening'
  const greeting = translate(key, fallback)
  return name ? `${greeting}, ${name}.` : `${greeting}.`
}
