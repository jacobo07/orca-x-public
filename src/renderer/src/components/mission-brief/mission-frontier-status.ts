import { translate } from '@/i18n/i18n'

// STATE.md `Status:` is a lifecycle label written by GSD's workflows or by hand, so spellings vary.
const LABELS: Record<string, () => string> = {
  planning: () => translate('missionBrief.frontierStatus.planning', 'Planning'),
  'ready-to-plan': () => translate('missionBrief.frontierStatus.readyToPlan', 'Ready to plan'),
  'ready-to-execute': () =>
    translate('missionBrief.frontierStatus.readyToExecute', 'Ready to execute'),
  executing: () => translate('missionBrief.frontierStatus.executing', 'Executing'),
  'in-progress': () => translate('missionBrief.frontierStatus.inProgress', 'In progress'),
  verifying: () => translate('missionBrief.frontierStatus.verifying', 'Verifying'),
  'ready-for-verification': () =>
    translate('missionBrief.frontierStatus.readyForVerification', 'Ready for verification'),
  'phase-complete': () => translate('missionBrief.frontierStatus.phaseComplete', 'Phase complete'),
  complete: () => translate('missionBrief.frontierStatus.complete', 'Complete'),
  completed: () => translate('missionBrief.frontierStatus.complete', 'Complete'),
  'defining-requirements': () =>
    translate('missionBrief.frontierStatus.definingRequirements', 'Defining requirements'),
  'awaiting-next-milestone': () =>
    translate('missionBrief.frontierStatus.awaitingNextMilestone', 'Awaiting next milestone'),
  blocked: () => translate('missionBrief.frontierStatus.blocked', 'Blocked'),
  paused: () => translate('missionBrief.frontierStatus.paused', 'Paused')
}

/** The frontier's recorded status in the UI language; an unknown label is quoted, never dropped. */
export function describeFrontierStatus(status: string | null): string | null {
  const value = status?.trim()
  if (!value) {
    return null
  }
  const label = LABELS[value.toLowerCase().replace(/[\s_]+/g, '-')]
  return label
    ? label()
    : translate('missionBrief.frontierStatus.recorded', 'Recorded as “{{value}}”', { value })
}
