// Why: the only replies proving no structured side effect began. A refusal, an unknown reply or a
// transport failure must never reach the unguarded legacy launch, so this list stays positive.
const AGENT_SESSION_LEGACY_FALLBACK_ERROR_CODES: ReadonlySet<string> = new Set([
  // The host rejected an execution owner that cannot claim sessions (SSH, older owner).
  'agent_session_legacy_required',
  // An older host has no structured method at all.
  'method_not_found'
])

/** True only for replies that permit retrying the same intent through the legacy launch. */
export function isAgentSessionLegacyFallbackErrorCode(code: unknown): boolean {
  return typeof code === 'string' && AGENT_SESSION_LEGACY_FALLBACK_ERROR_CODES.has(code)
}
