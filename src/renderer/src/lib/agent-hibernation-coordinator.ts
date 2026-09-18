import { useAppStore } from '@/store'
import {
  candidateIdFor,
  classifyAgentHibernationPanes,
  planAgentHibernationCandidates,
  type AgentHibernationExclusionReason
} from './agent-hibernation-planner'
import {
  confirmAgentHibernationCandidates,
  type AgentHibernationConfirmationState
} from './agent-hibernation-confirmation'
import {
  buildAgentHibernationPlannerSnapshot,
  fenceRuntimePtyLivenessSample
} from './agent-hibernation-planner-snapshot'
import { withAgentHibernationOutputSignature } from './agent-hibernation-output-activity'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { sampleRuntimePtyLiveness } from './runtime-pty-liveness-sample'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

export const AGENT_HIBERNATION_TICK_MS = 60 * 1000

type IntervalHandle = ReturnType<typeof setInterval>

type AgentHibernationCoordinatorOptions = {
  intervalMs?: number
  now?: () => number
}

type AgentHibernationCoordinatorState = {
  interval: IntervalHandle | null
  confirmationState: AgentHibernationConfirmationState
  tickInFlight: boolean
  shuttingDownCandidateIds: Set<string>
  now: () => number
}

const coordinator: AgentHibernationCoordinatorState = {
  interval: null,
  confirmationState: {},
  tickInFlight: false,
  shuttingDownCandidateIds: new Set(),
  now: () => Date.now()
}

/**
 * One snapshot, read two ways: the panes that may sleep, and why each of the others may
 * not. They must come from the same snapshot — asking twice would sample the hosts twice
 * and could answer about two different worlds.
 */
async function currentPlan(now: number) {
  const sample = await sampleRuntimePtyLiveness(useAppStore.getState())
  const freshState = useAppStore.getState()
  const snapshot = buildAgentHibernationPlannerSnapshot(
    freshState,
    now,
    // Why: judged against post-await state, so a worktree re-homed mid-sample is unknown.
    fenceRuntimePtyLivenessSample(freshState, sample)
  )
  const causeByCandidateId = new Map<string, AgentSleepCause>()
  for (const pane of classifyAgentHibernationPanes(snapshot)) {
    if (pane.reason) {
      causeByCandidateId.set(candidateIdFor(pane.worktreeId, pane.paneKey), pane.reason)
    }
  }
  const candidates = planAgentHibernationCandidates(snapshot)
    .filter((candidate) => {
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        freshState,
        candidate.worktreeId
      )
      if (!runtimeEnvironmentId || candidate.expectedRuntimePtyIds.length === 1) {
        return true
      }
      // Why: the planner admitted it, but its handle resolves to no single host PTY, so
      // there is nothing exact to stop. Without a name this reads as an ordinary refusal.
      causeByCandidateId.set(candidate.id, 'runtime-pty-not-exact')
      return false
    })
    .map(withAgentHibernationOutputSignature)
  return { candidates, causeByCandidateId }
}

async function currentCandidates(now: number) {
  return (await currentPlan(now)).candidates
}

/** A pane as it was when someone decided to sleep it: evidence, never authority. */
export type AgentSleepAuthorization = { candidateId: string; signature: string }

export type AgentSleepOutcome =
  /** Re-planned on live state, still the pane that was authorized, and shut down. */
  | 'slept'
  /** Still a candidate, but not the one authorized (new PTY, input, output, state). */
  | 'changed'
  /** No longer a candidate at all: the planner now keeps it awake. */
  | 'not-eligible'
  /** Another sleep of this pane is already running. */
  | 'in-progress'
  /** Authorized and still eligible, but the shutdown itself threw. */
  | 'failed'

/**
 * Why an attempt ended where it did, at the strongest boundary that knew.
 *
 * For a refusal this is the planner's own exclusion reason, so a host that could not be
 * re-sampled (`runtime-liveness-unknown`) stops reading like a user's pin. For a failure it
 * is the token the effect threw — every one of these was already named and then discarded.
 * Internal: diagnosis, tests and logs. The user-facing word stays `AgentSleepOutcome`.
 */
export type AgentSleepCause =
  | AgentHibernationExclusionReason
  /** Admitted by the planner, but its handle resolves to no single host PTY. */
  | 'runtime-pty-not-exact'
  /** The pane was gone entirely — no longer a pane the planner walks. */
  | 'pane-absent'
  | 'pane-binding-mismatch'
  | 'capture-missing'
  | 'runtime-missing'
  | 'stop-targeted-wrong-pty'
  | 'stop-unverified'
  | 'stop-still-live'
  | 'liveness-unavailable'
  | 'effect-threw'
  /** The host still holds a line for a pane this renderer has no input record of. */
  | 'host-unsent-input'

export type AgentSleepResult = {
  candidateId: string
  outcome: AgentSleepOutcome
  /** Absent exactly when the outcome is `slept`. */
  cause?: AgentSleepCause
}

const CAUSE_BY_THROWN_TOKEN: Record<string, AgentSleepCause> = {
  agent_hibernation_pane_binding_mismatch: 'pane-binding-mismatch',
  agent_hibernation_capture_missing: 'capture-missing',
  missing_runtime_for_exact_terminal_stop: 'runtime-missing',
  exact_terminal_stop_mismatch: 'stop-targeted-wrong-pty',
  exact_terminal_stop_unverified: 'stop-unverified',
  terminal_worktree_sleep_still_live: 'stop-still-live',
  terminal_liveness_unavailable: 'liveness-unavailable'
}

function toSleepCause(error: unknown): AgentSleepCause {
  const message = error instanceof Error ? error.message : String(error)
  // Why: a transport re-wraps the token into a longer message, so match the token it ends on.
  for (const [token, cause] of Object.entries(CAUSE_BY_THROWN_TOKEN)) {
    if (message === token || message.endsWith(token)) {
      return cause
    }
  }
  return 'effect-threw'
}

/**
 * A draft this renderer cannot know about.
 *
 * The planner's own input guard is the better instrument and keeps owning every pane it has
 * evidence for: it attributes input to the agent state segment it landed in, so a mid-turn
 * permission answer does not block forever. But that evidence is renderer-only, and the shell
 * outlives the renderer — after a reload the map is empty and a pane with a line waiting reads
 * as untouched. So this asks the pty's own owner, and ONLY for panes the renderer has no record
 * of, which leaves normal operation entirely to the planner.
 *
 * Ordering: this sits after the signature check, so it widens the gap between that check and the
 * shutdown by one inspect. That is the deliberate trade — a stale signature still shuts down the
 * explicit pty ids it authorized, while a missed draft is gone for good.
 */
async function hostHoldsLineThisRendererNeverSaw(current: {
  paneKey: string
  targetPtyIds: readonly string[]
}): Promise<boolean> {
  const state = useAppStore.getState()
  const recorded = state.lastTerminalInputAtByPaneKey?.[current.paneKey]
  if (typeof recorded === 'number' && Number.isFinite(recorded)) {
    return false
  }
  const ptyId = current.targetPtyIds[0]
  if (!ptyId) {
    return false
  }
  try {
    const inspection = await inspectRuntimeTerminalProcess(state.settings, ptyId)
    // Why only a positive 'typed': an authority that cannot see the line is not evidence of one,
    // and refusing on silence would stop every older host from ever sleeping a pane.
    return inspection.inputSincePrompt === 'typed' && inspection.unavailable !== true
  } catch {
    // A probe that failed says nothing about a draft; the planner's verdict stands.
    return false
  }
}

async function hibernatePaneIfStillEligible(
  authorization: AgentSleepAuthorization
): Promise<{ outcome: AgentSleepOutcome; cause?: AgentSleepCause }> {
  const id = authorization.candidateId
  if (coordinator.shuttingDownCandidateIds.has(id)) {
    return { outcome: 'in-progress' }
  }
  const plan = await currentPlan(coordinator.now())
  const current = plan.candidates.find((candidate) => candidate.id === id)
  if (!current) {
    return { outcome: 'not-eligible', cause: plan.causeByCandidateId.get(id) ?? 'pane-absent' }
  }
  // Why: the signature covers pty, runtime pty and provider session, so a match
  // also proves the fresh candidate's shutdown targets are the authorized ones.
  if (current.signature !== authorization.signature) {
    return { outcome: 'changed' }
  }
  coordinator.shuttingDownCandidateIds.add(id)
  try {
    // Why inside the single-flight guard: this await must not let a second tick past the
    // eligibility checks for the same candidate, and immediately before the shutdown is
    // where an effect-time question belongs anyway.
    if (await hostHoldsLineThisRendererNeverSaw(current)) {
      return { outcome: 'not-eligible', cause: 'host-unsent-input' }
    }
    const state = useAppStore.getState()
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, current.worktreeId)
    await state.shutdownCompletedAgentPaneForHibernation(current.worktreeId, {
      paneKey: current.paneKey,
      tabId: current.tabId,
      leafId: current.leafId,
      ptyId: current.targetPtyIds[0],
      ...(runtimeEnvironmentId ? { expectedRuntimePtyId: current.expectedRuntimePtyIds[0] } : {})
    })
    return { outcome: 'slept' }
  } catch (err) {
    const cause = toSleepCause(err)
    console.warn('[agent-hibernation] failed to hibernate agent pane:', id, cause, err)
    return { outcome: 'failed', cause }
  } finally {
    coordinator.shuttingDownCandidateIds.delete(id)
  }
}

/**
 * A user's explicit "sleep these now". The click replaces the two-tick wait and
 * nothing else: each pane is re-planned on live state immediately before its own
 * shutdown — setting, idle threshold and every exclusion included — and slept
 * only if it is still exactly the pane that was shown.
 */
export async function sleepAuthorizedAgentPanes(
  authorizations: readonly AgentSleepAuthorization[]
): Promise<AgentSleepResult[]> {
  const results: AgentSleepResult[] = []
  // Why: sequential, so a later pane is judged after the earlier shutdown, not before it.
  for (const authorization of authorizations) {
    results.push({
      candidateId: authorization.candidateId,
      ...(await hibernatePaneIfStillEligible(authorization))
    })
  }
  return results
}

export async function runAgentHibernationTick(): Promise<void> {
  if (coordinator.tickInFlight) {
    return
  }
  coordinator.tickInFlight = true
  try {
    const plan = confirmAgentHibernationCandidates(
      coordinator.confirmationState,
      await currentCandidates(coordinator.now())
    )
    coordinator.confirmationState = plan.confirmationState
    for (const candidate of plan.candidates) {
      void hibernatePaneIfStillEligible({
        candidateId: candidate.id,
        signature: candidate.signature
      })
    }
  } finally {
    coordinator.tickInFlight = false
  }
}

export function startAgentHibernationCoordinator(
  options: AgentHibernationCoordinatorOptions = {}
): () => void {
  if (coordinator.interval !== null) {
    return stopAgentHibernationCoordinator
  }
  coordinator.now = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? AGENT_HIBERNATION_TICK_MS
  coordinator.interval = setInterval(() => void runAgentHibernationTick(), intervalMs)
  return stopAgentHibernationCoordinator
}

export function stopAgentHibernationCoordinator(): void {
  if (coordinator.interval !== null) {
    clearInterval(coordinator.interval)
    coordinator.interval = null
  }
  coordinator.confirmationState = {}
}

export function resetAgentHibernationCoordinatorForTests(): void {
  stopAgentHibernationCoordinator()
  coordinator.shuttingDownCandidateIds.clear()
  coordinator.tickInFlight = false
  coordinator.now = () => Date.now()
}
