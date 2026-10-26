import { translate } from '@/i18n/i18n'
import type { ProductContinueResult } from '@/lib/project-working-set-product-restore'
import type {
  ContinuePane,
  ContinuePaneDisposition,
  ContinuePaneReason,
  HostTranslationRefusal
} from '../../../../shared/project-working-set-host-translation'
import { blockerText, restoreResultText } from './working-set-copy'

/**
 * Every sentence the Continue here result shows, one wording per distinct fact. The presenter only
 * words what the product call and the planner decided; it never derives a disposition or a reason.
 */

/** `neutral` is not-yet or informational; `problem` is an obstacle the user may need to act on. */
export type ContinueTone = 'neutral' | 'problem'

export type ContinuePaneRowView = {
  key: string
  label: string
  disposition: ContinuePaneDisposition
  reason: ContinuePaneReason
  dispositionText: string
  reasonText: string
}

export type ContinueResultView = {
  status: ProductContinueResult['status']
  tone: ContinueTone
  sentence: string
  /** Rows only for a restored result; a refused continue restored nothing to list. */
  panes: ContinuePaneRowView[]
}

function refusalText(reason: HostTranslationRefusal): string {
  switch (reason) {
    case 'source-setup-project-mismatch':
      return translate(
        'workingSet.continue.refusal.sourceSetupProjectMismatch',
        "This workspace's setup doesn't match the project being continued."
      )
    case 'target-setup-project-mismatch':
      return translate(
        'workingSet.continue.refusal.targetSetupProjectMismatch',
        "That host's setup is for a different project."
      )
    case 'target-setup-missing':
      return translate(
        'workingSet.continue.refusal.targetSetupMissing',
        "This project isn't set up on that host yet."
      )
    case 'target-setup-not-ready':
      return translate(
        'workingSet.continue.refusal.targetSetupNotReady',
        "This project's setup on that host isn't ready yet."
      )
    case 'same-host':
      return translate(
        'workingSet.continue.refusal.sameHost',
        'This snapshot already belongs to that host.'
      )
    case 'source-host-mismatch':
      return translate(
        'workingSet.continue.refusal.sourceHostMismatch',
        "This snapshot was saved on a different host than this workspace's setup."
      )
    case 'location-outside-source-setup':
      return translate(
        'workingSet.continue.refusal.locationOutsideSourceSetup',
        "This workspace is outside the project's folder, so it has no matching place on that host."
      )
    case 'location-kind-unsupported':
      return translate(
        'workingSet.continue.refusal.locationKindUnsupported',
        'Only project worktrees can continue on another host, not plain folders.'
      )
    case 'startup-cwd-outside-source-setup':
      return translate(
        'workingSet.continue.refusal.startupCwdOutsideSourceSetup',
        "A terminal in this snapshot started outside the project's folder, so it can't be matched on that host."
      )
    default: {
      const unreachable: never = reason
      return unreachable
    }
  }
}

function dispositionText(disposition: ContinuePaneDisposition): string {
  switch (disposition) {
    case 'resume':
      return translate('workingSet.continue.pane.disposition.resume', 'Resumes the agent session')
    case 'restart':
      return translate(
        'workingSet.continue.pane.disposition.restart',
        'Starts a new terminal in its folder'
      )
    case 'unavailable':
      return translate('workingSet.continue.pane.disposition.unavailable', "Can't be opened there")
    default: {
      const unreachable: never = disposition
      return unreachable
    }
  }
}

function paneReasonText(reason: ContinuePaneReason): string {
  switch (reason) {
    case 'provider-session-present':
      return translate(
        'workingSet.continue.pane.reason.providerSessionPresent',
        'Its agent session is on that host.'
      )
    case 'relaunchable':
      return translate(
        'workingSet.continue.pane.reason.relaunchable',
        'It can be started again from its saved launch.'
      )
    case 'host-unavailable':
      return translate(
        'workingSet.continue.pane.reason.hostUnavailable',
        "That host isn't available."
      )
    case 'host-unverified':
      return translate(
        'workingSet.continue.pane.reason.hostUnverified',
        "That host hasn't been verified yet."
      )
    case 'live-elsewhere':
      return translate('workingSet.continue.pane.reason.liveElsewhere', "It's open somewhere else.")
    case 'not-confirmed':
      return translate(
        'workingSet.continue.pane.reason.notConfirmed',
        "Its session couldn't be confirmed there."
      )
    case 'nothing-runnable':
      return translate('workingSet.continue.pane.reason.nothingRunnable', "There's nothing to run.")
    default: {
      const unreachable: never = reason
      return unreachable
    }
  }
}

function paneRows(panes: readonly ContinuePane[]): ContinuePaneRowView[] {
  return panes.map((entry, index) => ({
    key: `${entry.targetTabId}:${entry.leafId}`,
    label: translate('workingSet.continue.pane.label', 'Terminal {{number}}', {
      number: index + 1
    }),
    disposition: entry.disposition,
    reason: entry.reason,
    dispositionText: dispositionText(entry.disposition),
    reasonText: paneReasonText(entry.reason)
  }))
}

function restoredSentence(panes: readonly ContinuePane[] | undefined): string {
  // Why three: no table (not listed), an empty table (nothing to open) and a table are different facts.
  if (panes === undefined) {
    return translate(
      'workingSet.continue.result.restoredUnlisted',
      "Restored, but what each tab will do couldn't be listed."
    )
  }
  return panes.length === 0
    ? translate(
        'workingSet.continue.result.restoredEmpty',
        'Restored, but this snapshot has no terminals to open.'
      )
    : translate(
        'workingSet.continue.result.restored',
        'Restored on the other host. Nothing has started; each tab starts only when you open it.'
      )
}

type RefusedResult = Extract<ProductContinueResult, { status: 'refused' }>

// Why: an unmeasured host is not a down host; the planner's pane table says which one it saw.
function hostWasUnverified(result: RefusedResult): boolean {
  return (
    result.panes !== undefined &&
    result.panes.length > 0 &&
    result.panes.every((entry) => entry.reason === 'host-unverified')
  )
}

function refusedSentence(result: RefusedResult): string {
  const unverified = hostWasUnverified(result)
  return result.blockers
    .map((blocker) =>
      blocker === 'host-unavailable' && unverified
        ? translate(
            'workingSet.continue.result.hostUnverified',
            "That host hasn't been verified yet, so nothing was restored. Try again once it's connected."
          )
        : blockerText(blocker)
    )
    .join(' ')
}

/** Total over every continue status: a new status fails to compile here. */
export function continueResultView(result: ProductContinueResult): ContinueResultView {
  const view = (tone: ContinueTone, sentence: string, panes: ContinuePaneRowView[] = []) => ({
    status: result.status,
    tone,
    sentence,
    panes
  })
  switch (result.status) {
    case 'restored':
      return view('neutral', restoredSentence(result.panes), paneRows(result.panes ?? []))
    case 'in-flight':
      return view(
        'neutral',
        translate(
          'workingSet.continue.result.inFlight',
          "Another restore into that workspace hasn't finished."
        )
      )
    case 'refused':
      return view(
        hostWasUnverified(result) &&
          result.blockers.every((blocker) => blocker === 'host-unavailable')
          ? 'neutral'
          : 'problem',
        refusedSentence(result)
      )
    case 'unreadable':
    case 'target-changed':
    case 'failed':
      // Why `?? ''`: these three arms always have wording (every arm is asserted non-empty in the test).
      return view('problem', restoreResultText(result) ?? '')
    case 'continue-refused':
      return view(
        result.reason === 'target-setup-missing' || result.reason === 'target-setup-not-ready'
          ? 'neutral'
          : 'problem',
        refusalText(result.reason)
      )
    case 'continue-target-unavailable':
      return result.reason === 'target-workspace-missing'
        ? view(
            'neutral',
            translate(
              'workingSet.continue.unavailable.targetWorkspaceMissing',
              "Not set up there yet: that host's copy of this workspace isn't open in this client. Nothing was changed."
            )
          )
        : view(
            'problem',
            translate(
              'workingSet.continue.unavailable.sourceSetupMissing',
              "This workspace's own setup couldn't be found, so it can't continue elsewhere."
            )
          )
    case 'continue-source-not-clean':
      return result.reason === 'uncommitted-changes'
        ? view(
            'neutral',
            translate(
              'workingSet.continue.source.uncommittedChanges',
              "This workspace has uncommitted changes, and they wouldn't come along. Commit or stash them first. Nothing was changed."
            )
          )
        : view(
            'problem',
            translate(
              'workingSet.continue.source.statusUnknown',
              "Couldn't check this workspace for uncommitted changes, so nothing was continued. Try again."
            )
          )
    default: {
      const unreachable: never = result
      return unreachable
    }
  }
}
