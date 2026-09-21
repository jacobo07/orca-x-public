/** Why a park keeps a workspace running. See docs/reference/durable-park-and-exit.md. */
export type ParkKeepReason =
  | 'agent-working'
  | 'agent-subagents'
  | 'agent-not-resumable'
  | 'unsent-input'
  | 'mobile-held'
  | 'shell-busy'
  | 'process-unknown'
  | 'pinned'

export type ParkRequest = {
  /** `plan` reports what a park would do and changes nothing. */
  mode: 'plan' | 'park'
  /** Pinned tabs are kept unless the caller explicitly includes them. */
  includePinned: boolean
}

export type ParkWorkspaceOutcome =
  | { worktreeId: string; outcome: 'would-sleep'; livePtyCount: number }
  | { worktreeId: string; outcome: 'kept'; reasons: ParkKeepReason[]; livePtyCount: number }
  | { worktreeId: string; outcome: 'slept'; livePtyCount: number }
  /** The workspace gained a keep reason after the plan; it was left running. */
  | { worktreeId: string; outcome: 'changed'; reasons: ParkKeepReason[] }
  | { worktreeId: string; outcome: 'failed'; detail: string }

export type ParkStatus =
  /** Plan only: what a park would do now. */
  | 'planned'
  /** Every live terminal was released and the session was saved; the app is exiting. */
  | 'parked'
  /** Nothing had a live terminal; the app is exiting. */
  | 'nothing-to-park'
  /** Something must keep running; nothing was released and the app keeps running. */
  | 'refused'
  /** Saving the session failed before anything was released; the app keeps running. */
  | 'seal-failed'
  /** Some workspaces were released and at least one was not; the app keeps running. */
  | 'incomplete'
  /** No window could run the park (none open, or it did not answer). */
  | 'unavailable'

/** What the window did; main adds the operation id and decides whether to exit. */
export type ParkPhaseResult = Omit<ParkResult, 'operationId' | 'exiting'> & {
  /** Tabs that must be dormant in the saved session before the app may exit. */
  sleptTabIds: string[]
}

export type ParkPhaseRequest = ParkRequest & { id: string }

export type ParkPhaseResponse =
  | { id: string; ok: true; result: ParkPhaseResult }
  | { id: string; ok: false; error: string }

export type ParkResult = {
  operationId: string
  status: ParkStatus
  workspaces: ParkWorkspaceOutcome[]
  /** Workspaces already without a live terminal; they are left as they are. */
  alreadyAsleepCount: number
  /** Whether the app will quit because of this result. */
  exiting: boolean
  detail?: string
}
