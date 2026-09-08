import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { AGENT_RESUME_PROVENANCE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'

/**
 * Whether this host reports resume provenance at all.
 *
 * The reason the row alone is not enough: an older host omits the fact from every row, which is
 * byte-identical to a newer host saying every resume succeeded. Only the advertisement tells the
 * two apart, and mixing them up would have mobile promise continuity on exactly the hosts that
 * cannot check it.
 */
export function hostReportsResumeProvenance(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(AGENT_RESUME_PROVENANCE_RUNTIME_CAPABILITY) === true
}

/**
 * Whether this session's earlier turns survived, as far as mobile is entitled to say.
 *
 * Three states, and the third is the one that matters. 'unknown' is not a softer 'confirmed': it
 * means the host never told us, so mobile may not imply the history is intact. Collapsing the two
 * would make an older host look like one reporting universal success.
 */
export type AgentResumeProvenance = 'confirmed' | 'unavailable' | 'unknown'

export function agentResumeProvenance(
  row: Pick<RuntimeWorktreeAgentRow, 'resumeUnavailable'>,
  hostReportsResumeProvenance: boolean
): AgentResumeProvenance {
  // The fact, when present, is an observation the host made -- worth believing even from a host
  // that did not advertise the capability, because it can only ever move us to the careful answer.
  if (row.resumeUnavailable) {
    return 'unavailable'
  }
  return hostReportsResumeProvenance ? 'confirmed' : 'unknown'
}

/**
 * Row annotation, or null when there is nothing to tell the user.
 *
 * 'confirmed' and 'unknown' both annotate nothing, which is deliberate: stamping "history unknown"
 * on every row of every older host is noise, and noise on every row is not information. The two are
 * kept apart by what mobile may CLAIM, below, not by a caption.
 */
export function resumeProvenanceLabel(provenance: AgentResumeProvenance): string | null {
  return provenance === 'unavailable' ? 'Started fresh — earlier turns unavailable' : null
}

/**
 * Whether a surface may state that this session continues its earlier work.
 *
 * The guard for any affordance that would assert continuity -- a "restored" badge, a resume action,
 * copy promising the agent remembers the previous turns. Only a host that reports provenance and
 * reported none for this row has actually said so.
 */
export function canClaimHistoryPreserved(provenance: AgentResumeProvenance): boolean {
  return provenance === 'confirmed'
}
