/** Whether a pane's provider session is the one being materialized. `undetermined`
 *  means the canonical identity could not be computed for that pane (no execution
 *  namespace) while its raw session id still matches. */
export type LiveAgentSessionIdentityMatch = 'same' | 'different' | 'undetermined'

/** `unbound`: no PTY is bound to the pane key in this process. */
export type LiveAgentSessionPtyLiveness = 'live' | 'absent' | 'unknown' | 'unbound'

export type LiveAgentSessionPresenceCandidate = {
  paneKey: string
  identity: LiveAgentSessionIdentityMatch
  /** The hook row was produced by an event in this runtime, not hydrated from disk. */
  observedInCurrentRuntime: boolean
  ptyLiveness: LiveAgentSessionPtyLiveness
}

export type LiveAgentSessionPresenceKind =
  | 'no-live-owner'
  | 'live-here'
  | 'live-elsewhere'
  | 'multiple-live-owners'
  | 'unknown'

export type LiveAgentSessionPresence = {
  kind: LiveAgentSessionPresenceKind
  liveHere: boolean
  liveElsewhere: string[]
  /** Owners proven gone; the lifecycle owner should reconcile them. Never a collision. */
  stale: string[]
  /** Panes that may own the session but cannot be proven either way. */
  unknown: string[]
}

type CandidateVerdict = 'live' | 'stale' | 'unknown' | 'dormant' | 'unrelated'

function judgeCandidate(candidate: LiveAgentSessionPresenceCandidate): CandidateVerdict {
  if (candidate.identity === 'different') {
    return 'unrelated'
  }
  const { ptyLiveness } = candidate
  if (candidate.identity === 'undetermined') {
    return ptyLiveness === 'live' ||
      (candidate.observedInCurrentRuntime && ptyLiveness !== 'absent')
      ? 'unknown'
      : 'unrelated'
  }
  if (!candidate.observedInCurrentRuntime) {
    // Why: a hydrated row is continuity from a previous run; a surviving process proves the shell, not the agent.
    return ptyLiveness === 'live' || ptyLiveness === 'unknown' ? 'unknown' : 'dormant'
  }
  if (ptyLiveness === 'live') {
    return 'live'
  }
  return ptyLiveness === 'absent' ? 'stale' : 'unknown'
}

/** Projects current runtime evidence into where one provider session is live.
 *  Pure: callers supply identity matches and liveness; nothing here is persisted. */
export function projectLiveAgentSessionPresence(args: {
  requestingPaneKey: string
  candidates: readonly LiveAgentSessionPresenceCandidate[]
}): LiveAgentSessionPresence {
  const liveElsewhere = new Set<string>()
  const stale = new Set<string>()
  const unknown = new Set<string>()
  let liveHere = false
  for (const candidate of args.candidates) {
    const verdict = judgeCandidate(candidate)
    const isRequester = candidate.paneKey === args.requestingPaneKey
    if (verdict === 'live') {
      if (isRequester) {
        liveHere = true
      } else {
        liveElsewhere.add(candidate.paneKey)
      }
    } else if (isRequester) {
      // Why: the requesting pane's own prior state is what is being replaced, not a rival owner.
      continue
    } else if (verdict === 'stale') {
      stale.add(candidate.paneKey)
    } else if (verdict === 'unknown') {
      unknown.add(candidate.paneKey)
    }
  }
  const kind: LiveAgentSessionPresenceKind =
    liveElsewhere.size > 1
      ? 'multiple-live-owners'
      : liveElsewhere.size === 1
        ? 'live-elsewhere'
        : unknown.size > 0
          ? 'unknown'
          : liveHere
            ? 'live-here'
            : 'no-live-owner'
  return {
    kind,
    liveHere,
    liveElsewhere: [...liveElsewhere],
    stale: [...stale],
    unknown: [...unknown]
  }
}
