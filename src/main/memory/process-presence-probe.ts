import type { ProcessPresenceProbe } from '../../shared/process-stats-types'
import { enumerateProcesses, type ProcIndex } from './collector'
import { getProcessMemoryMetric } from './process-memory-metric'

/**
 * Post-effect observation for the sleep flow: which of these pids does a sweep
 * that STARTED NOW still list?
 *
 * Deliberately not coalesced with collectMemorySnapshot — a merged caller would
 * receive a sweep that read the process table before the effect. One sweep per
 * call, called once per explicit action, never on a timer.
 */
export async function probeProcessPresence(
  pids: readonly number[],
  enumerate: () => Promise<ProcIndex> = enumerateProcesses
): Promise<ProcessPresenceProbe> {
  const sweepStartedAt = Date.now()
  let index: ProcIndex
  try {
    index = await enumerate()
  } catch (err) {
    console.warn('[memory] presence probe sweep failed', err)
    return { sweep: 'failed', sweepStartedAt }
  }
  // Why: enumerators return [] on failure; an empty table is never a host with nothing running.
  if (index.byPid.size === 0) {
    return { sweep: 'failed', sweepStartedAt }
  }
  return {
    sweep: 'measured',
    sweepStartedAt,
    metric: getProcessMemoryMetric(),
    presentPids: pids.filter((pid) => index.byPid.has(pid))
  }
}
