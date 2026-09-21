import { translate } from '@/i18n/i18n'
import type { WorkingSetRestoreCapability } from '../../../../shared/project-working-set-types'
import { blockerText, capabilityText, readProblemText } from './working-set-copy'
import type { WorkingSetPreview } from './use-working-set-preview'

const CAPABILITY_ORDER: readonly WorkingSetRestoreCapability[] = [
  'exact-resume',
  'restartable',
  'recreate-context',
  'history-only',
  'not-restorable',
  'unknown'
]

/** Text only: what the canonical planner says restoring the selection would do. */
export function WorkingSetPreviewPanel({
  preview,
  profilesUnresolved
}: {
  preview: WorkingSetPreview
  profilesUnresolved: boolean
}): React.JSX.Element | null {
  if (preview.kind === 'idle') {
    return null
  }
  if (preview.kind === 'waiting-for-profiles') {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="working-set-preview">
        {translate('workingSet.history.checkingProfiles', 'Checking launch options…')}
      </p>
    )
  }
  if (preview.kind === 'loading') {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="working-set-preview">
        {translate(
          'workingSet.history.previewLoading',
          'Checking what this snapshot can bring back…'
        )}
      </p>
    )
  }
  if (preview.kind === 'unreadable') {
    return (
      <p className="text-[11px] text-destructive" data-testid="working-set-preview">
        {readProblemText(preview.read)}
      </p>
    )
  }
  const { summary, blockers } = preview.plan
  return (
    <div
      className="flex flex-col gap-1 text-[11px] text-muted-foreground"
      data-testid="working-set-preview"
      data-working-set-preview-ready=""
    >
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
        {CAPABILITY_ORDER.filter((capability) => summary.byCapability[capability] > 0).map(
          (capability) => (
            <li key={capability} data-working-set-capability={capability}>
              {capabilityText(capability, summary.byCapability[capability])}
            </li>
          )
        )}
      </ul>
      {summary.liveElsewhere > 0 ? (
        <p>
          {translate(
            'workingSet.history.liveElsewhere',
            "Open elsewhere, won't resume here: {{count}}",
            { count: summary.liveElsewhere }
          )}
        </p>
      ) : null}
      {profilesUnresolved ? (
        <p>
          {translate(
            'workingSet.history.profilesUnresolved',
            "Launch options couldn't be checked, so some tabs may show as unknown."
          )}
        </p>
      ) : null}
      {blockers.map((blocker) => (
        <p key={blocker} className="text-destructive" data-working-set-blocker={blocker}>
          {blockerText(blocker)}
        </p>
      ))}
    </div>
  )
}
