// A provider that cannot run at all on the host the turn runs on: not installed there, or too old to
// hold a conversation. A product state with its own fix, never "the turn failed". Provider-agnostic,
// so a driver can say it without the runner learning any provider's vocabulary.

export type ProviderUnavailableReason = 'not-installed' | 'protocol-unsupported'

export class ProviderUnavailableError extends Error {
  readonly reason: ProviderUnavailableReason

  constructor(reason: ProviderUnavailableReason, message: string) {
    super(message)
    this.name = 'ProviderUnavailableError'
    this.reason = reason
  }
}
