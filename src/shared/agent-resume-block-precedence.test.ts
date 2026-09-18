import { describe, expect, it } from 'vitest'
import {
  afterAgentStarted,
  isAgentExitedResumeBlock,
  isLegacyWorkerResumeBlock,
  LEGACY_WORKER_EXITED_RESUME_BLOCK,
  withAgentExited,
  withLegacyWorkerFence,
  withoutLegacyWorkerFence,
  type AutomaticResumeBlock
} from './agent-resume-block-precedence'

const ALL: (AutomaticResumeBlock | undefined)[] = [
  undefined,
  'legacy-orchestration-worker',
  'agent-exited',
  LEGACY_WORKER_EXITED_RESUME_BLOCK
]

describe('automatic resume block precedence', () => {
  it('keeps the exit and the fence independent across every transition', () => {
    for (const block of ALL) {
      const exited = isAgentExitedResumeBlock(block)
      const fenced = isLegacyWorkerResumeBlock(block)

      expect(isAgentExitedResumeBlock(withLegacyWorkerFence(block))).toBe(exited)
      expect(isLegacyWorkerResumeBlock(withLegacyWorkerFence(block))).toBe(true)
      expect(isAgentExitedResumeBlock(withoutLegacyWorkerFence(block))).toBe(exited)
      expect(isLegacyWorkerResumeBlock(withoutLegacyWorkerFence(block))).toBe(false)
      expect(isLegacyWorkerResumeBlock(withAgentExited(block))).toBe(fenced)
      expect(isAgentExitedResumeBlock(withAgentExited(block))).toBe(true)
      expect(isLegacyWorkerResumeBlock(afterAgentStarted(block))).toBe(fenced)
      expect(isAgentExitedResumeBlock(afterAgentStarted(block))).toBe(false)
    }
  })

  it('releasing the fence on an unblocked record leaves no block', () => {
    expect(withoutLegacyWorkerFence('legacy-orchestration-worker')).toBeUndefined()
    expect(afterAgentStarted('agent-exited')).toBeUndefined()
  })
})
