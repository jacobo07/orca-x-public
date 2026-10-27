/**
 * What the Resume Center has asked for and what the runtime has shown since. `running` is set only
 * from the runtime's own evidence (a PTY bound to the row), never from the request having been made.
 */
export type WakePhase =
  | { phase: 'admission-pending' }
  | { phase: 'materializing'; notMeasured: boolean }
  | { phase: 'running' }
  | { phase: 'refused'; reason: string; detail: string }
  | { phase: 'unavailable' }
  | { phase: 'failed'; reason: 'not-found' | 'not-started' | 'not-launched' }

export type ResumeAllState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number }
  | { status: 'stopped'; started: number; remaining: number; reason: string; detail: string }
  | { status: 'finished'; started: number; leftAsleep: number }

type Snapshot = { phases: ReadonlyMap<string, WakePhase>; resumeAll: ResumeAllState }

let snapshot: Snapshot = { phases: new Map(), resumeAll: { status: 'idle' } }
const listeners = new Set<() => void>()

function publish(next: Snapshot): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeWakeState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readWakeState(): Snapshot {
  return snapshot
}

export function setWakePhase(targetKey: string, phase: WakePhase): void {
  const phases = new Map(snapshot.phases)
  phases.set(targetKey, phase)
  publish({ ...snapshot, phases })
}

export function setResumeAllState(resumeAll: ResumeAllState): void {
  publish({ ...snapshot, resumeAll })
}

/** Tests only: forget everything this window asked for. */
export function resetWakeStateForTests(): void {
  publish({ phases: new Map(), resumeAll: { status: 'idle' } })
}
