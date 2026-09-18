import { toast } from 'sonner'
import { runSleepWorktrees } from '@/components/sidebar/sleep-worktree-flow'
import { translate } from '@/i18n/i18n'
import type { ParkResult } from '../../../../shared/durable-exit-types'
import { createParkPhaseDeps, runParkPhase } from './run-park-request'

/** Runs the window's half of a park whenever main asks for it. */
export function attachParkPhaseBridge(): () => void {
  const api = window.api.durableExit
  if (typeof api?.onParkPhaseRequest !== 'function') {
    return () => {}
  }
  const deps = createParkPhaseDeps((worktreeId) => runSleepWorktrees([worktreeId]))
  const detachRequests = api.onParkPhaseRequest((request) => {
    const { id, ...parkRequest } = request
    runParkPhase(parkRequest, deps).then(
      (result) => api.respondParkPhase({ id, ok: true, result }),
      (error: unknown) =>
        api.respondParkPhase({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
    )
  })
  const detachMenu = api.onParkFromMenu(() => {
    void parkFromUserRequest()
  })
  return () => {
    detachRequests()
    detachMenu()
  }
}

/** The desktop entry: ask main to park, and say why when the app stays open. */
export async function parkFromUserRequest(): Promise<ParkResult> {
  const result = await window.api.durableExit.park({ mode: 'park', includePinned: false })
  if (result.exiting) {
    toast.info(
      translate('durableExit.toast.parked', 'Everything is asleep and saved. Orca is closing.')
    )
    return result
  }
  toast.error(translate('durableExit.toast.stayedOpen', 'Orca stayed open'), {
    description: describeStayedOpen(result)
  })
  return result
}

function describeStayedOpen(result: ParkResult): string {
  const running = result.workspaces.filter(
    (workspace) =>
      workspace.outcome === 'kept' ||
      workspace.outcome === 'changed' ||
      workspace.outcome === 'failed'
  ).length
  switch (result.status) {
    case 'refused':
      return translate(
        'durableExit.toast.refused',
        '{{count}} workspace(s) have running work, so nothing was put to sleep.',
        { count: running }
      )
    case 'incomplete':
      return translate(
        'durableExit.toast.incomplete',
        'Some workspaces are asleep; {{count}} could not be put to sleep and are still running.',
        { count: running }
      )
    case 'seal-failed':
      return translate(
        'durableExit.toast.sealFailed',
        'The session could not be saved, so Orca stays open.'
      )
    default:
      return translate(
        'durableExit.toast.unavailable',
        'Park and exit is not available in this window right now.'
      )
  }
}
