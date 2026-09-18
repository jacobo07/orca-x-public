import type { SleepingAgentSessionRecord } from './agent-session-resume'

export type AutomaticResumeBlock = NonNullable<
  SleepingAgentSessionRecord['automaticResumeBlockedBy']
>

// Why one combined value, not a second field: an older build silently strips an unknown
// field (leaving the record unblocked) but drops a record with an unknown enum value.
export const LEGACY_WORKER_EXITED_RESUME_BLOCK = 'legacy-orchestration-worker-exited'

export function isLegacyWorkerResumeBlock(block: AutomaticResumeBlock | undefined): boolean {
  return block === 'legacy-orchestration-worker' || block === LEGACY_WORKER_EXITED_RESUME_BLOCK
}

export function isAgentExitedResumeBlock(block: AutomaticResumeBlock | undefined): boolean {
  return block === 'agent-exited' || block === LEGACY_WORKER_EXITED_RESUME_BLOCK
}

export function withLegacyWorkerFence(
  block: AutomaticResumeBlock | undefined
): AutomaticResumeBlock {
  return isAgentExitedResumeBlock(block)
    ? LEGACY_WORKER_EXITED_RESUME_BLOCK
    : 'legacy-orchestration-worker'
}

export function withoutLegacyWorkerFence(
  block: AutomaticResumeBlock | undefined
): AutomaticResumeBlock | undefined {
  return isAgentExitedResumeBlock(block) ? 'agent-exited' : undefined
}

export function withAgentExited(block: AutomaticResumeBlock | undefined): AutomaticResumeBlock {
  return isLegacyWorkerResumeBlock(block) ? LEGACY_WORKER_EXITED_RESUME_BLOCK : 'agent-exited'
}

/** A live start of the same session proves the agent is running again; only the fence survives. */
export function afterAgentStarted(
  block: AutomaticResumeBlock | undefined
): AutomaticResumeBlock | undefined {
  return isLegacyWorkerResumeBlock(block) ? 'legacy-orchestration-worker' : undefined
}
