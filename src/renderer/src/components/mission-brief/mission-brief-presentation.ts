import { translate } from '@/i18n/i18n'
import type {
  HumanAttentionItem,
  MissionBrief,
  MissionBriefResult,
  MissionContradiction,
  MissionSignal,
  MissionStageState
} from '../../../../shared/mission-brief-types'

/**
 * Words and tones for the Mission Brief, from the projection's own answers. Every "we could not
 * tell" stays visible as such: unknown is information, never an empty row.
 */
export type MissionTone = 'needs-you' | 'autonomous' | 'next' | 'unknown' | 'stale'

export function signalTone(signal: MissionSignal): MissionTone {
  return signal
}

export function describeSignal(signal: MissionSignal): string {
  switch (signal) {
    case 'needs-you':
      return translate('missionBrief.signal.needsYou', 'Needs your attention')
    case 'autonomous':
      return translate('missionBrief.signal.autonomous', 'Progressing on its own')
    case 'next':
      return translate('missionBrief.signal.next', 'Next step ready')
    case 'unknown':
      return translate('missionBrief.signal.unknown', 'Next step unknown')
  }
}

export function describeSignalShort(signal: MissionSignal): string {
  switch (signal) {
    case 'needs-you':
      return translate('missionBrief.signalShort.needsYou', 'Need you')
    case 'autonomous':
      return translate('missionBrief.signalShort.autonomous', 'Autonomous')
    case 'next':
      return translate('missionBrief.signalShort.next', 'Next')
    case 'unknown':
      return translate('missionBrief.signalShort.unknown', 'Unknown')
  }
}

export function describeStageState(state: MissionStageState): string {
  switch (state) {
    case 'proven':
      return translate('missionBrief.stage.proven', 'Verified')
    case 'claimed':
      return translate('missionBrief.stage.claimed', 'Marked done, not verified')
    case 'current':
      return translate('missionBrief.stage.current', 'Current')
    case 'future':
      return translate('missionBrief.stage.future', 'Not started')
  }
}

export function describePhase(stageId: string, name: string | null): string {
  return name
    ? translate('missionBrief.phase.named', 'Phase {{id}} · {{name}}', { id: stageId, name })
    : translate('missionBrief.phase.bare', 'Phase {{id}}', { id: stageId })
}

export function describeLastVerified(brief: MissionBrief): string {
  const last = brief.lastVerified
  if (last.kind === 'verified') {
    return describePhase(last.stageId, last.name)
  }
  return last.nearest
    ? translate('missionBrief.lastVerified.noneWithNearest', 'No phase verified yet. Phase {{id}} verification: {{status}}', {
        id: last.nearest.stageId,
        status: last.nearest.verification
      })
    : translate('missionBrief.lastVerified.none', 'No phase verified yet')
}

export function describeAttention(item: HumanAttentionItem): string {
  switch (item.source) {
    case 'ralph-mission':
      return translate('missionBrief.attention.mission', 'Autonomous run is blocked: {{reason}}', {
        reason: item.reason
      })
    case 'state-md':
      return item.text
    case 'gsd-verification':
      return translate('missionBrief.attention.verification', 'Phase {{id}}: {{action}}', {
        id: item.stageId,
        action: item.nextAction
      })
  }
}

export function describeContradiction(item: MissionContradiction): string {
  switch (item.kind) {
    case 'frontier-disagrees':
      return translate(
        'missionBrief.contradiction.frontier',
        'STATE.md says phase {{recorded}}, planning says phase {{active}}',
        { recorded: item.recorded, active: item.active }
      )
    case 'claimed-without-verification':
      return translate(
        'missionBrief.contradiction.claimed',
        'Phase {{id}} is marked done without a passed verification',
        { id: item.stageId }
      )
    case 'claimed-with-open-dependency':
      return translate(
        'missionBrief.contradiction.openDependency',
        'Phase {{id}} is marked done while phase {{dependency}} is open',
        { id: item.stageId, dependency: item.dependencyId }
      )
  }
}

export function describeFreshness(brief: MissionBrief): { text: string; tone: MissionTone } {
  const freshness = brief.freshness
  switch (freshness.kind) {
    case 'current':
      return {
        text: translate('missionBrief.freshness.current', 'Planning state matches the current commit'),
        tone: 'next'
      }
    case 'stale':
      return {
        text:
          freshness.commitsSince === null
            ? translate('missionBrief.freshness.staleUncounted', 'Recorded at an older commit')
            : translate('missionBrief.freshness.stale', '{{count}} commits since the planning state was recorded', {
                count: freshness.commitsSince
              }),
        tone: 'stale'
      }
    case 'unknown':
      return {
        text:
          freshness.reason === 'no-recorded-head'
            ? translate('missionBrief.freshness.noRecordedHead', 'Planning state records no commit')
            : translate('missionBrief.freshness.gitUnreadable', 'Current commit could not be read'),
        tone: 'unknown'
      }
  }
}

export function describeUnavailable(result: MissionBriefResult): string | null {
  switch (result.status) {
    case 'read':
    case 'choose-workstream':
      return null
    case 'no-mission':
      return translate('missionBrief.state.noMission', 'This workspace keeps no mission records (.planning).')
    case 'failed':
      return translate('missionBrief.state.failed', 'The mission records could not be read.')
    case 'unavailable':
      switch (result.reason) {
        case 'remote-host':
          return translate('missionBrief.state.remote', 'Mission records on another host are not read yet.')
        case 'gsd-tools-absent':
          return translate('missionBrief.state.noGsd', 'GSD is not installed on this machine, so mission records cannot be read.')
        case 'client-unsupported':
          return translate('missionBrief.state.client', 'This client cannot read mission records.')
        case 'workspace-unknown':
        case 'invalid-request':
          return translate('missionBrief.state.unknownWorkspace', 'This workspace could not be located.')
      }
  }
}
