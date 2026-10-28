// Why: the renderer cannot import src/main, so the host's refusal vocabulary is mirrored here and
// pinned to the authority's union by environment-prepare-run-result.test.ts.
export const PREPARE_HOST_REFUSAL_REASONS = [
  'contract-unreadable',
  'requirement-not-declared',
  'approval-for-another-host',
  'contract-changed',
  'approval-unreadable',
  'approval-missing',
  'host-identity-unverified',
  'already-satisfied',
  'requirement-not-applicable'
] as const

export type PrepareHostRefusalReason = (typeof PREPARE_HOST_REFUSAL_REASONS)[number]

// Named by the client when the host never answered with a decision of its own, or answered with a
// refusal this client does not describe. All three prove nothing was started on the host.
export type PrepareClientRefusalReason =
  | 'host-predates-prepare'
  | 'unreachable'
  | 'host-refused-unknown'

export type PrepareRefusalReasonCode = PrepareHostRefusalReason | PrepareClientRefusalReason

// `unknown` is a request that was sent and not provably refused: a timeout, a dropped transport or
// an answer this client cannot read. The step may have started; the outcome carries no message.
export type PrepareStepRunOutcome =
  | { status: 'started' }
  | { status: 'refused'; reason: PrepareRefusalReasonCode }
  | { status: 'unknown' }

export function isPrepareHostRefusalReason(value: unknown): value is PrepareHostRefusalReason {
  return (
    typeof value === 'string' && (PREPARE_HOST_REFUSAL_REASONS as readonly string[]).includes(value)
  )
}

export type RunPrepareStepRequest = {
  requirementId: string
  approvedContentHash: string
  approvedHostKey: string
}
