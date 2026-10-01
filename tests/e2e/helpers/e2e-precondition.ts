/**
 * Separates "the test could not be set up" from "the behaviour under test failed".
 *
 * Why: the shared Electron fixture seeds a real git repo and real worktrees before any spec runs.
 * When that seeding loses a race it throws a plain Playwright timeout, which is the same shape as
 * an assertion the product failed — so one flaky precondition contaminates the verdict of every
 * spec in the run, and a genuine regression can hide behind the same red. Marking the setup phases
 * at the point they fail is what makes the two readable apart afterwards.
 *
 * A precondition failure is still a failure. It is never converted to a pass. What changes is that
 * the product verdict is reported as unmeasured rather than as failed.
 *
 * Cleanup failures sit at the opposite end of the same run and need their own class. A precondition
 * failure means the behaviour was never observed; a cleanup failure means it was observed, reached a
 * verdict, and then the harness could not tidy up after itself. Windows keeps handles on a
 * just-closed profile, so this is routine here — and an unguarded removal turns it into the run's
 * exit code, reporting a suite that passed as a suite that failed. Both are still failures of the
 * harness's own health contract; neither may rewrite a subject verdict that was already reached.
 */

export const PRECONDITION_FAILURE_MARKER = 'ORCA-E2E-PRECONDITION-FAILED'
/** Thrown by e2e-profile-disposal.ts for real residue. A spec's own finally runs it inside the body,
 *  so origin alone would name leaked residue a product failure. */
export const CLEANUP_FAILURE_MARKER = 'ORCA-E2E-CLEANUP-FAILED'

/** The ordered phases the shared fixture walks before a spec's own assertions begin. */
export type E2ESetupPhase =
  | 'app-launch'
  | 'renderer-store'
  | 'repository-seed'
  | 'worktree-seed'
  | 'session-ready'
  | 'workspace-activation'

export type E2EFailureClass =
  | 'precondition-failed'
  | 'cleanup-failed'
  | 'product-failure'
  | 'harness-error'
  | 'unknown'

export type E2EFailureOrigin = 'setup' | 'test-body' | 'teardown'

/** Minimal structural view of Playwright's TestInfo — enough to record, cheap enough to fake. */
export type AnnotationSink = {
  annotations: { type: string; description?: string }[]
}

// Why: these mean the page or Electron process died under the test rather than the test observing
// a wrong value. Attributing them to Orca's behaviour is how a dead harness becomes a bug report.
const HARNESS_ERROR_PATTERNS = [
  /Target (?:page|closed|crashed)|context or browser has been closed/i,
  /Execution context was destroyed/i,
  /browserContext\.close|electronApplication\.close/i,
  /WebSocket (?:error|is not open)/i
]

/**
 * Classify a failure without guessing. `product-failure` is only ever returned on positive
 * evidence that the failure came from a spec's own body; everything unattributed stays `unknown`,
 * because naming an unattributed failure a product failure is the exact misattribution this model
 * exists to prevent.
 */
export function classifyE2EFailure(input: {
  message?: string | null
  origin?: E2EFailureOrigin | null
}): E2EFailureClass {
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (message.length === 0) {
    return 'unknown'
  }
  if (message.includes(PRECONDITION_FAILURE_MARKER)) {
    return 'precondition-failed'
  }
  // Before the harness patterns, not after: a closed page is teardown's expected end state, so
  // reading it there as harness ill-health would report a sick harness on every healthy run.
  if (input.origin === 'teardown' || message.includes(CLEANUP_FAILURE_MARKER)) {
    return 'cleanup-failed'
  }
  if (HARNESS_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'harness-error'
  }
  if (input.origin === 'setup') {
    return 'precondition-failed'
  }
  if (input.origin === 'test-body') {
    return 'product-failure'
  }
  return 'unknown'
}

/**
 * Run one setup phase, tagging a failure with the phase it stopped in. Success is silent: a
 * healthy annotation on every phase of every spec would bury the one that matters.
 */
export async function runSetupPhase<T>(
  phase: E2ESetupPhase,
  run: () => Promise<T>,
  testInfo?: AnnotationSink
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    testInfo?.annotations.push({ type: 'e2e-precondition', description: `${phase}: FAILED` })
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${PRECONDITION_FAILURE_MARKER} [${phase}] ${message}`, { cause: error })
  }
}

/**
 * Record how many times a polled precondition had to retry before it settled. A run that needed
 * eleven attempts and a run that needed one are both green, and only one of them is healthy.
 */
export function recordPreconditionAttempts(
  phase: E2ESetupPhase,
  attempts: number,
  testInfo?: AnnotationSink
): void {
  if (attempts <= 1) {
    return
  }
  testInfo?.annotations.push({
    type: 'e2e-precondition',
    description: `${phase}: settled after ${attempts} attempts`
  })
}
