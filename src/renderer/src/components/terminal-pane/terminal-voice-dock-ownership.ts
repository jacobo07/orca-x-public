import type { DictationState } from '../../../../shared/speech-types'
import type { TerminalDictationTarget } from '../../store/slices/dictation'

const JOB_RUNNING_STATES: ReadonlySet<DictationState> = new Set<DictationState>([
  'starting',
  'listening',
  'stopping'
])

/**
 * Whether this pane owns the running dictation job.
 *
 * Why both ids: pane ids are allocated per tab, so pane 2 exists in every tab
 * and the id alone would light up a dock in a tab that started nothing.
 *
 * Why the state matters: the target outlives the job it belonged to, so a
 * finished run would otherwise leave its pane looking like it is still
 * recording. Ownership runs to the end of the job rather than to the end of
 * capture, because the owning pane is where the transcript is going to land.
 *
 * This is for presentation only. Delivery is fenced by the run id and session
 * held inside the dictation controller, and must not be re-derived from here.
 */
export function isTerminalVoiceDockRecordingOwner(args: {
  dictationTarget: TerminalDictationTarget | null
  dictationState: DictationState
  tabId: string
  paneId: number
}): boolean {
  if (!args.dictationTarget || !JOB_RUNNING_STATES.has(args.dictationState)) {
    return false
  }
  return args.dictationTarget.tabId === args.tabId && args.dictationTarget.paneId === args.paneId
}
