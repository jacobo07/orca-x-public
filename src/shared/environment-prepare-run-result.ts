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

// Named by the client when the host never answered with a decision of its own.
export type PrepareClientRefusalReason = 'host-predates-prepare' | 'unreachable'

export type PrepareRefusalReasonCode = PrepareHostRefusalReason | PrepareClientRefusalReason

export type PrepareStepRunOutcome =
  | { status: 'started' }
  | { status: 'refused'; reason: PrepareRefusalReasonCode }

export type RunPrepareStepRequest = {
  requirementId: string
  approvedContentHash: string
  approvedHostKey: string
}
