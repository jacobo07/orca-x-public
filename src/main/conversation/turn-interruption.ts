// A turn that started and was cut off by something other than the provider's own answer: its
// deadline lapsed, or the host it ran on went away. Each has its own sentence and its own fix, so a
// driver names the cause without the runner learning any provider's or transport's vocabulary.

export type TurnInterruptionCause = 'timed-out' | 'host-lost'

export class TurnInterruptedError extends Error {
  readonly cause: TurnInterruptionCause

  constructor(cause: TurnInterruptionCause, message: string) {
    super(message)
    this.name = 'TurnInterruptedError'
    this.cause = cause
  }
}
