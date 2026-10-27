import { useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import {
  readWakeState,
  subscribeWakeState,
  type ResumeAllState,
  type WakePhase
} from './resume-center-wake-state'

export function useWakeState(): ReturnType<typeof readWakeState> {
  return useSyncExternalStore(subscribeWakeState, readWakeState)
}

/** A wake is in flight while admission or the runtime has not answered yet. */
export function isWakeInFlight(phase: WakePhase | undefined): boolean {
  return phase?.phase === 'admission-pending' || phase?.phase === 'materializing'
}

function describeRefusal(reason: string): string {
  if (reason === 'insufficient-available-memory') {
    return translate(
      'resumeCenter.wake.refusedMemory',
      'Not enough free memory to start it now. Nothing was started.'
    )
  }
  if (reason === 'executor-unobservable') {
    return translate(
      'resumeCenter.wake.refusedUnmeasured',
      'Its host cannot be measured, so Resume all left it asleep. Resume it on its own.'
    )
  }
  return translate(
    'resumeCenter.wake.refusedUnchecked',
    'Free resources could not be checked, so nothing was started.'
  )
}

/** One sentence per state; asked-for and started never share one. */
export function describeWakePhase(phase: WakePhase): string {
  switch (phase.phase) {
    case 'admission-pending':
      return translate('resumeCenter.wake.checking', 'Checking free resources…')
    case 'materializing':
      return phase.notMeasured
        ? translate(
            'resumeCenter.wake.startingUnmeasured',
            'Starting, on a host that is not measured…'
          )
        : translate('resumeCenter.wake.starting', 'Starting…')
    case 'running':
      return translate('resumeCenter.wake.running', 'Running')
    case 'refused':
      return describeRefusal(phase.reason)
    case 'unavailable':
      return translate('resumeCenter.wake.unavailable', 'This client cannot start sessions.')
    case 'failed':
      return phase.reason === 'not-found'
        ? translate('resumeCenter.wake.gone', 'This row is no longer on the desk.')
        : phase.reason === 'not-launched'
          ? translate('resumeCenter.wake.notLaunched', 'This agent session could not be resumed.')
          : translate(
              'resumeCenter.wake.notStarted',
              'It was asked to start and has not started yet. It stays asleep until it does.'
            )
  }
}

/** The reason line under a stopped Resume all; the counts beside it are claims of their own. */
export function describeResumeAllStop(
  state: Extract<ResumeAllState, { status: 'stopped' }>
): string {
  return state.reason === 'unavailable'
    ? translate('resumeCenter.wake.unavailable', 'This client cannot start sessions.')
    : describeRefusal(state.reason)
}
