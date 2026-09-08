import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { agentDotState } from './agent-row-display'
import { AGENT_RESUME_PROVENANCE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  agentResumeProvenance,
  canClaimHistoryPreserved,
  hostReportsResumeProvenance,
  resumeProvenanceLabel
} from './agent-row-resume-provenance'

/**
 * What mobile may claim about a session's history.
 *
 * The host knows when a pane asked to resume a provider session, could not verify the resume, and
 * launched a fresh one instead. The desktop says so; mobile could not, and the failure mode is a
 * lie in the safe-looking direction -- a session presented as continuous when its transcript is
 * gone. The user then asks the agent about work it has no memory of.
 *
 * The rows below are typed as the host's own wire shape on purpose. If the fact does not cross the
 * boundary this file cannot compile, which is the only version of this test worth having: mobile
 * asserting against its own local invention would pass no matter what the host sends.
 */
function row(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'tab-1:leaf-1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: 'refactor the parser',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  }
}

describe('resume provenance on a mobile agent row', () => {
  it('reports a session the host could not resume', () => {
    expect(agentResumeProvenance(row({ resumeUnavailable: true }), true)).toBe('unavailable')
  })

  it('reports a session the host did resume, when the host reports provenance at all', () => {
    expect(agentResumeProvenance(row(), true)).toBe('confirmed')
  })

  /**
   * The whole point of pairing the row with a host capability. An older host sends no provenance
   * for any row, so every row looks exactly like a confirmed one -- and "the field is missing"
   * would silently become "the history is fine" on the client that can least afford to guess.
   */
  it('does not read an old host\'s silence as a confirmed resume', () => {
    expect(agentResumeProvenance(row(), false)).toBe('unknown')
  })

  it('believes the fact when it arrives, even from a host that did not advertise it', () => {
    // Evidence outranks negotiation in the conservative direction only: a host that sends the flag
    // has observed the failed resume, and refusing to believe it would be the unsafe way round.
    expect(agentResumeProvenance(row({ resumeUnavailable: true }), false)).toBe('unavailable')
  })

  /**
   * Provenance and liveness are different questions and must not be folded together. An agent whose
   * resume failed is running a real, fresh session: the work happening now is genuine, and only its
   * memory of earlier turns is gone. Marking the row idle would replace one lie with another.
   */
  it('does not change what the row says about live work', () => {
    const now = 1_000
    expect(agentDotState(row({ resumeUnavailable: true }), now)).toBe('working')
    expect(agentDotState(row(), now)).toBe('working')
  })

  it('keeps unconfirmed activity and unresumable history as separate facts', () => {
    const now = 1_000
    const hydrated = row({ resumeUnavailable: true, restoredUnconfirmed: true })
    // Unconfirmed activity still suppresses the working dot ...
    expect(agentDotState(hydrated, now)).toBe('idle')
    // ... and the history claim is untouched by that.
    expect(agentResumeProvenance(hydrated, true)).toBe('unavailable')
  })

  it('annotates only the row it has something to say about', () => {
    expect(resumeProvenanceLabel('unavailable')).toBeTruthy()
    // Nothing to tell the user in either of the other two: stamping "history unknown" on every row
    // of every older host would be noise, and noise on every row carries no information.
    expect(resumeProvenanceLabel('confirmed')).toBeNull()
    expect(resumeProvenanceLabel('unknown')).toBeNull()
  })

  /**
   * Where 'unknown' and 'confirmed' actually part company. They share a caption, so if they also
   * shared this they would be one state wearing two names -- and the one that must never be assumed
   * is precisely the claim that the agent still remembers the earlier turns.
   */
  it('lets only a confirmed resume claim the earlier work continues', () => {
    expect(canClaimHistoryPreserved('confirmed')).toBe(true)
    expect(canClaimHistoryPreserved('unknown')).toBe(false)
    expect(canClaimHistoryPreserved('unavailable')).toBe(false)
  })

  /**
   * Clients and hosts update independently, so every pairing below is a state some user is in.
   * The rule the matrix enforces is one-directional: a version gap may cost the client the
   * capability, and may never let it make a claim the host did not back.
   */
  describe('across host versions', () => {
    it('reads a host that reports provenance', () => {
      const capabilities = [AGENT_RESUME_PROVENANCE_RUNTIME_CAPABILITY]
      expect(hostReportsResumeProvenance(capabilities)).toBe(true)
      expect(agentResumeProvenance(row(), hostReportsResumeProvenance(capabilities))).toBe(
        'confirmed'
      )
    })

    it('claims nothing against an older host, rather than claiming success', () => {
      // New mobile, old host: the capability is absent, so every row is provenance-unknown and the
      // continuity claim is refused. Degraded capability, never a downgraded guarantee.
      const older = ['terminal.quick-commands.v1']
      expect(hostReportsResumeProvenance(older)).toBe(false)
      const provenance = agentResumeProvenance(row(), hostReportsResumeProvenance(older))
      expect(provenance).toBe('unknown')
      expect(canClaimHistoryPreserved(provenance)).toBe(false)
    })

    it('claims nothing when the host sent no capability list at all', () => {
      expect(hostReportsResumeProvenance(undefined)).toBe(false)
      expect(agentResumeProvenance(row(), hostReportsResumeProvenance(undefined))).toBe('unknown')
    })
  })
})
