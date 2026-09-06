import { describe, expect, it } from 'vitest'
import {
  classifyE2EFailure,
  PRECONDITION_FAILURE_MARKER,
  runSetupPhase
} from './e2e-precondition'

// The observed message from the intermittent worktree-seeding failure in orca-app.ts. It is a
// plain Playwright poll timeout, so on its own it reads exactly like an assertion the product
// failed — which is how one flaky fixture contaminates every verdict in the run.
const SEEDING_TIMEOUT_MESSAGE = 'seeded e2e worktrees did not load'

describe('classifyE2EFailure', () => {
  it('tells a setup failure apart from a failure of the behaviour under test', () => {
    const setup = classifyE2EFailure({
      message: `${PRECONDITION_FAILURE_MARKER} [worktree-seed] ${SEEDING_TIMEOUT_MESSAGE}`,
      origin: 'setup'
    })
    const product = classifyE2EFailure({
      message: 'expected the rail to show 3 sessions, received 2',
      origin: 'test-body'
    })

    expect(setup).toBe('precondition-failed')
    expect(product).toBe('product-failure')
    expect(setup).not.toBe(product)
  })

  it('refuses to call an unattributed failure a product failure', () => {
    // Why: a message with no origin and no marker could be either. Guessing "product" is the
    // failure this whole model exists to prevent — it attributes a harness problem to Orca.
    expect(classifyE2EFailure({ message: SEEDING_TIMEOUT_MESSAGE })).toBe('unknown')
    expect(classifyE2EFailure({ message: '', origin: 'test-body' })).toBe('unknown')
    expect(classifyE2EFailure({ message: null, origin: 'setup' })).toBe('unknown')
  })

  it('classifies an unmarked setup failure as precondition, never as product', () => {
    // The product verdict is unmeasured whether or not the phase wrapper caught it.
    expect(classifyE2EFailure({ message: 'something broke in a hook', origin: 'setup' })).toBe(
      'precondition-failed'
    )
  })

  it('separates a dead harness from both', () => {
    for (const message of [
      'Target page, context or browser has been closed',
      'Execution context was destroyed, most likely because of a navigation'
    ]) {
      expect(classifyE2EFailure({ message, origin: 'test-body' })).toBe('harness-error')
    }
  })

  it('lets the marker win over the origin it was reported from', () => {
    // A precondition helper called from inside a test body still failed to establish a
    // precondition; the marker is positive evidence and outranks where it surfaced.
    expect(
      classifyE2EFailure({
        message: `${PRECONDITION_FAILURE_MARKER} [session-ready] timed out`,
        origin: 'test-body'
      })
    ).toBe('precondition-failed')
  })
})

describe('runSetupPhase', () => {
  it('passes a healthy phase through untouched', async () => {
    const annotations: { type: string; description?: string }[] = []

    await expect(runSetupPhase('worktree-seed', async () => 'ok', { annotations })).resolves.toBe(
      'ok'
    )
    expect(annotations).toEqual([])
  })

  it('marks a failed phase so the report can name where it stopped', async () => {
    const annotations: { type: string; description?: string }[] = []

    await expect(
      runSetupPhase(
        'worktree-seed',
        async () => {
          throw new Error(SEEDING_TIMEOUT_MESSAGE)
        },
        { annotations }
      )
    ).rejects.toThrow(PRECONDITION_FAILURE_MARKER)

    expect(annotations).toEqual([
      { type: 'e2e-precondition', description: 'worktree-seed: FAILED' }
    ])
  })

  it('keeps the original failure readable and reachable', async () => {
    const original = new Error(SEEDING_TIMEOUT_MESSAGE)

    const thrown = await runSetupPhase('worktree-seed', async () => {
      throw original
    }).catch((error: unknown) => error as Error)

    expect(thrown.message).toContain(SEEDING_TIMEOUT_MESSAGE)
    expect(thrown.message).toContain('worktree-seed')
    expect(thrown.cause).toBe(original)
    expect(classifyE2EFailure({ message: thrown.message, origin: 'setup' })).toBe(
      'precondition-failed'
    )
  })
})
