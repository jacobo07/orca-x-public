import { useAppStore } from '@/store'
import { planAgentHibernationCandidates } from './agent-hibernation-planner'
import {
  confirmAgentHibernationCandidates,
  type AgentHibernationConfirmationState
} from './agent-hibernation-confirmation'
import type { AppState } from '@/store/types'
import {
  buildAgentHibernationPlannerSnapshot,
  getRuntimeLivenessTargetWorktrees,
  type RuntimePtyLivenessSample
} from './agent-hibernation-planner-snapshot'
import { withAgentHibernationOutputSignature } from './agent-hibernation-output-activity'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'

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

function getTypedRuntimePtyId(terminal: RuntimeTerminalSummary): string | null {
  if (terminal.ptyId) {
    return terminal.ptyId
  }
  if (terminal.tabId.startsWith('pty:') && terminal.tabId === terminal.leafId) {
    return terminal.tabId.slice('pty:'.length) || null
  }
  return null
}

async function collectRuntimePtyLiveness(state: AppState): Promise<RuntimePtyLivenessSample> {
  const targets = getRuntimeLivenessTargetWorktrees(state)
  const runtimeLivePtyIdsByWorktreeId: Record<string, string[]> = {}
  const runtimeLivenessRequiredWorktreeIds = [...targets.keys()]
  await Promise.all(
    [...targets].map(async ([worktreeId, runtimeEnvironmentId]) => {
      try {
        const result = await callRuntimeRpc<RuntimeTerminalListResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'terminal.list',
          {
            worktree: toRuntimeWorktreeSelector(worktreeId),
            limit: 10_000,
            requireFreshPtyLiveness: true,
            includeVisualLayouts: false
          },
          { timeoutMs: 10_000 }
        )
        if (result.truncated) {
          return
        }
        const ptyIds = new Set<string>()
        for (const terminal of result.terminals) {
          if (!terminal.connected || terminal.worktreeId !== worktreeId) {
            continue
          }
          const ptyId = getTypedRuntimePtyId(terminal)
          if (ptyId) {
            ptyIds.add(ptyId)
          }
        }
        runtimeLivePtyIdsByWorktreeId[worktreeId] = [...ptyIds].sort()
      } catch {
        // Why: stale runtime liveness is unsafe for all-or-nothing hibernation;
        // omitting the worktree makes the planner fail closed for this pass.
      }
    })
  )
  return { runtimeLivePtyIdsByWorktreeId, runtimeLivenessRequiredWorktreeIds }
}

async function currentCandidates(now: number) {
  const runtimeLiveness = await collectRuntimePtyLiveness(useAppStore.getState())
  const freshState = useAppStore.getState()
  return planAgentHibernationCandidates(
    buildAgentHibernationPlannerSnapshot(freshState, now, runtimeLiveness)
  )
    .filter((candidate) => {
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        freshState,
        candidate.worktreeId
      )
      return !runtimeEnvironmentId || candidate.expectedRuntimePtyIds.length === 1
    })
    .map(withAgentHibernationOutputSignature)
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

export type AgentSleepResult = { candidateId: string; outcome: AgentSleepOutcome }

async function hibernatePaneIfStillEligible(
  authorization: AgentSleepAuthorization
): Promise<AgentSleepOutcome> {
  const id = authorization.candidateId
  if (coordinator.shuttingDownCandidateIds.has(id)) {
    return 'in-progress'
  }
  const current = (await currentCandidates(coordinator.now())).find(
    (candidate) => candidate.id === id
  )
  if (!current) {
    return 'not-eligible'
  }
  // Why: the signature covers pty, runtime pty and provider session, so a match
  // also proves the fresh candidate's shutdown targets are the authorized ones.
  if (current.signature !== authorization.signature) {
    return 'changed'
  }
  coordinator.shuttingDownCandidateIds.add(id)
  try {
    const state = useAppStore.getState()
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, current.worktreeId)
    await state.shutdownCompletedAgentPaneForHibernation(current.worktreeId, {
      paneKey: current.paneKey,
      tabId: current.tabId,
      leafId: current.leafId,
      ptyId: current.targetPtyIds[0],
      ...(runtimeEnvironmentId ? { expectedRuntimePtyId: current.expectedRuntimePtyIds[0] } : {})
    })
    return 'slept'
  } catch (err) {
    console.warn('[agent-hibernation] failed to hibernate agent pane:', id, err)
    return 'failed'
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
      outcome: await hibernatePaneIfStillEligible(authorization)
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
