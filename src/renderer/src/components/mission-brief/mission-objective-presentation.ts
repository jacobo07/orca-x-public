import { translate } from '@/i18n/i18n'
import type {
  MissionBrief,
  MissionRecordRole,
  ProjectGoalGap
} from '../../../../shared/mission-brief-types'

/** Words for where the objective came from, and for the planning files behind the brief. */

export type ObjectiveView = {
  text: string
  /** Names the record the text was quoted from, or why PROJECT.md gave none. */
  source: string
  /** The milestone, shown beside a PROJECT.md goal so it is not lost. */
  milestone: string | null
  partial: boolean
}

function describeGap(gap: ProjectGoalGap): string {
  switch (gap) {
    case 'absent':
      return translate('missionBrief.objective.gap.absent', 'no PROJECT.md')
    case 'no-goal-section':
      return translate('missionBrief.objective.gap.noGoal', 'PROJECT.md states no goal')
    case 'unreadable':
      return translate('missionBrief.objective.gap.unreadable', 'PROJECT.md could not be read')
  }
}

export function describeObjective(brief: MissionBrief): ObjectiveView {
  const objective = brief.objective
  if (objective.kind === 'unknown') {
    return {
      text: translate(
        'missionBrief.objective.unknown',
        'No goal recorded: {{gap}}, no milestone named',
        {
          gap: describeGap(objective.projectGap)
        }
      ),
      source: translate('missionBrief.meta.goal', 'Project goal'),
      milestone: null,
      partial: false
    }
  }
  if (objective.source === 'milestone') {
    return {
      text: objective.text,
      source: translate('missionBrief.objective.fromMilestone', 'Milestone · {{gap}}', {
        gap: describeGap(objective.projectGap)
      }),
      milestone: null,
      partial: objective.partial
    }
  }
  return {
    text: objective.text,
    source:
      objective.section === 'what-this-is'
        ? translate('missionBrief.objective.fromWhatThisIs', 'PROJECT.md · What this is')
        : translate('missionBrief.objective.fromCoreValue', 'PROJECT.md · Core value'),
    milestone:
      brief.milestone.kind === 'known'
        ? translate('missionBrief.objective.milestone', 'Milestone: {{name}}', {
            name: brief.milestone.text
          })
        : null,
    partial: false
  }
}

export function describeRecordCount(records: MissionBrief['records']): string {
  if (records.kind === 'unreadable') {
    return translate('missionBrief.records.unreadable', 'Planning files could not be listed')
  }
  const count = records.files.length
  return records.truncated
    ? translate('missionBrief.records.atLeast', 'At least {{count}} files', { count })
    : translate('missionBrief.records.count', '{{count}} files', { count })
}

export function describeRecordRole(role: MissionRecordRole): string {
  switch (role) {
    case 'project':
      return translate('missionBrief.records.role.project', 'Project')
    case 'state':
      return translate('missionBrief.records.role.state', 'State')
    case 'roadmap':
      return translate('missionBrief.records.role.roadmap', 'Roadmap')
    case 'requirements':
      return translate('missionBrief.records.role.requirements', 'Requirements')
    case 'config':
      return translate('missionBrief.records.role.config', 'Config')
    case 'phase':
      return translate('missionBrief.records.role.phase', 'Phase')
    case 'research':
      return translate('missionBrief.records.role.research', 'Research')
    case 'other':
      return translate('missionBrief.records.role.other', 'Other')
  }
}
