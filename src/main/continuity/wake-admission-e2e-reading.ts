import type { HostMemory } from '../../shared/process-stats-types'

/**
 * E2E only: replaces the available-memory figure with a scripted sequence, so a real app can be shown
 * a refusal without putting the host under real pressure. Inert unless both variables are set; the
 * last value repeats. Everything else in the reading is the real host's.
 */
export function withE2EWakeReading(
  collect: () => Promise<HostMemory>,
  env: NodeJS.ProcessEnv = process.env
): () => Promise<HostMemory> {
  const raw = env.ORCA_E2E_USER_DATA_DIR ? env.ORCA_E2E_WAKE_AVAILABLE_BYTES : undefined
  // Why drop blanks before Number(): Number('') is 0, so an unset variable would read as an empty host.
  const sequence = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
  if (sequence.length === 0) {
    return collect
  }
  let next = 0
  return async () => {
    const reading = await collect()
    const availableMemory = sequence[Math.min(next, sequence.length - 1)]!
    next += 1
    return { ...reading, availableMemory }
  }
}
