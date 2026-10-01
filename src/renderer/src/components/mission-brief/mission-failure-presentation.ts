import { translate } from '@/i18n/i18n'
import type { MissionBriefResult } from '../../../../shared/mission-brief-types'

type Failed = Extract<MissionBriefResult, { status: 'failed' }>

/** What a failed read means for the person; `detail` is the raw cause for a disclosure only. */
export function describeFailure(result: Failed): {
  sentence: string
  action: string
  detail: string
} {
  const { detail } = result
  switch (result.reason) {
    case 'install-incomplete':
      return {
        sentence: translate(
          'missionBrief.failure.installIncomplete',
          "GSD's installation on this machine is incomplete."
        ),
        action: translate(
          'missionBrief.failure.installIncompleteAction',
          'Reinstall or update GSD, then re-read.'
        ),
        detail
      }
    case 'timed-out':
      return {
        sentence: translate(
          'missionBrief.failure.timedOut',
          'GSD took too long to read the mission records.'
        ),
        action: translate(
          'missionBrief.failure.timedOutAction',
          'Re-read when the machine is less busy.'
        ),
        detail
      }
    case 'bad-output':
      return {
        sentence: translate(
          'missionBrief.failure.badOutput',
          'GSD answered in a form Orca cannot read.'
        ),
        action: translate(
          'missionBrief.failure.badOutputAction',
          'Update GSD so its version matches, then re-read.'
        ),
        detail
      }
    case 'failed':
      return {
        sentence:
          result.stage === 'gsd'
            ? translate(
                'missionBrief.failure.gsd',
                "GSD could not read this workspace's mission records."
              )
            : translate('missionBrief.failure.read', 'Orca could not read the mission records.'),
        action: translate(
          'missionBrief.failure.action',
          'The technical detail says why. Re-read after fixing it.'
        ),
        detail
      }
  }
}
