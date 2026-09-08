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

  it('separates a cleanup failure from a precondition failure', () => {
    // Why these must not share a class: they make opposite claims about whether a subject verdict
    // exists. A precondition failure says the behaviour was never observed. A cleanup failure says
    // it was observed, concluded, and then the harness failed to tidy up after itself. Reporting
    // the second as the first discards a verdict that was actually reached.
    const cleanup = classifyE2EFailure({
      message: 'EPERM: operation not permitted, unlink orca-e2e-repo-Tek4aa',
      origin: 'teardown'
    })
    const precondition = classifyE2EFailure({
      message: `${PRECONDITION_FAILURE_MARKER} [repository-seed] ${SEEDING_TIMEOUT_MESSAGE}`,
      origin: 'setup'
    })

    expect(cleanup).toBe('cleanup-failed')
    expect(cleanup).not.toBe(precondition)
    expect(cleanup).not.toBe('product-failure')
  })

  it('does not read a closed page during teardown as harness ill-health', () => {
    // A dead page is the expected end state of teardown, not evidence the harness is sick. The
    // origin outranks the message shape here, which it does not for a test body.
    expect(
      classifyE2EFailure({
        message: 'Target page, context or browser has been closed',
        origin: 'teardown'
      })
    ).toBe('cleanup-failed')
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
