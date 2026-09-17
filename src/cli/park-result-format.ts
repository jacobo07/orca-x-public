import type { ParkResult } from '../shared/durable-exit-types'

/** 0: quitting with everything asleep or a clean plan · 2: stayed open on purpose · 1: could not park. */
export function parkExitCode(result: ParkResult): number {
  if (result.exiting || result.status === 'planned') {
    return 0
  }
  return result.status === 'refused' || result.status === 'incomplete' ? 2 : 1
}

export function formatParkResult(result: ParkResult): string {
  const lines = [`park: ${result.status}${result.detail ? ` (${result.detail})` : ''}`]
  for (const workspace of result.workspaces) {
    const why =
      workspace.outcome === 'kept' || workspace.outcome === 'changed'
        ? `: ${workspace.reasons.join(', ') || 'started while parking'}`
        : workspace.outcome === 'failed'
          ? `: ${workspace.detail}`
          : ''
    lines.push(`  ${workspace.outcome.padEnd(11)} ${workspace.worktreeId}${why}`)
  }
  if (result.alreadyAsleepCount > 0) {
    lines.push(`  already asleep: ${result.alreadyAsleepCount} workspace(s)`)
  }
  lines.push(result.exiting ? 'Orca is quitting.' : 'Orca stays open.')
  return lines.join('\n')
}
