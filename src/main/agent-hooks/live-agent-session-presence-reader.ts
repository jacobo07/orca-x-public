import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  projectLiveAgentSessionPresence,
  type LiveAgentSessionIdentityMatch,
  type LiveAgentSessionPresence,
  type LiveAgentSessionPresenceCandidate,
  type LiveAgentSessionPtyLiveness
} from './live-agent-session-presence'

export type LiveAgentSessionPresenceSubject = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
  /** Worktree the session is about to be materialized in. */
  worktreeId: string
}

export type LiveAgentSessionPresenceReaderDeps = {
  listHookRows: () => readonly AgentStatusIpcPayload[]
  isObservedInCurrentRuntime: (paneKey: string) => boolean
  /** Canonical claim key, or null when this host cannot place the identity. */
  resolveIdentityKey: (args: {
    worktreeId: string
    agent: TuiAgent
    providerSession: AgentProviderSessionMetadata
  }) => Promise<string | null>
  getBoundPtyIdForPaneKey: (paneKey: string) => string | undefined
  /** PTY a pane was bound to when the session was persisted; covers panes not yet reattached. */
  getPersistedPtyIdForPaneKey: (paneKey: string) => string | undefined
  /** True / false when the provider can prove it; null when it cannot. */
  probePtyLiveness: (ptyId: string) => Promise<boolean | null>
}

function sameRawIdentity(
  row: AgentStatusIpcPayload,
  subject: LiveAgentSessionPresenceSubject
): boolean {
  return (
    row.agentType === subject.agent &&
    row.providerSession?.key === subject.providerSession.key &&
    row.providerSession.id === subject.providerSession.id
  )
}

export type LiveAgentSessionPresenceReading = LiveAgentSessionPresence & {
  /** PTY behind each live owner, so a replaced runtime in the same pane reads as a new owner. */
  incarnationByPane: Record<string, string>
}

async function probePaneLiveness(
  deps: LiveAgentSessionPresenceReaderDeps,
  paneKey: string
): Promise<{ liveness: LiveAgentSessionPtyLiveness; ptyId?: string }> {
  const boundPtyId = deps.getBoundPtyIdForPaneKey(paneKey)
  const ptyId = boundPtyId ?? deps.getPersistedPtyIdForPaneKey(paneKey)
  if (!ptyId) {
    return { liveness: 'unbound' }
  }
  let live: boolean | null
  try {
    live = await deps.probePtyLiveness(ptyId)
  } catch {
    // Why: an unreachable provider says nothing about the process; absence needs proof.
    return { liveness: 'unknown', ptyId }
  }
  if (deps.getBoundPtyIdForPaneKey(paneKey) !== boundPtyId) {
    // Why: a cold restore can rebind the pane while the probe is in flight.
    return { liveness: 'unknown', ptyId }
  }
  return { liveness: live === true ? 'live' : live === false ? 'absent' : 'unknown', ptyId }
}

/** Reads where one provider session is live right now, across every window this
 *  process serves. Raw ids narrow the candidates; the canonical claim key decides. */
export async function readLiveAgentSessionPresence(
  deps: LiveAgentSessionPresenceReaderDeps,
  args: { subject: LiveAgentSessionPresenceSubject; requestingPaneKey: string }
): Promise<LiveAgentSessionPresenceReading> {
  const { subject } = args
  const rows = deps.listHookRows().filter((row) => sameRawIdentity(row, subject))
  if (rows.length === 0) {
    return {
      ...projectLiveAgentSessionPresence({
        requestingPaneKey: args.requestingPaneKey,
        candidates: []
      }),
      incarnationByPane: {}
    }
  }
  const ptyIdByPane = new Map<string, string>()
  const keyCache = new Map<string, Promise<string | null>>()
  const keyFor = (
    worktreeId: string,
    providerSession: AgentProviderSessionMetadata
  ): Promise<string | null> => {
    // Why: transcript-scoped agents (pi) hash the row's own transcript path.
    const cacheKey = `${worktreeId}\0${providerSession.transcriptPath ?? ''}`
    let key = keyCache.get(cacheKey)
    if (!key) {
      key = deps
        .resolveIdentityKey({ worktreeId, agent: subject.agent, providerSession })
        .catch(() => null)
      keyCache.set(cacheKey, key)
    }
    return key
  }
  const subjectKey = await keyFor(subject.worktreeId, subject.providerSession)
  const candidates = await Promise.all(
    rows.map(async (row): Promise<LiveAgentSessionPresenceCandidate> => {
      const rowKey =
        row.worktreeId && row.providerSession
          ? await keyFor(row.worktreeId, row.providerSession)
          : null
      const identity: LiveAgentSessionIdentityMatch =
        subjectKey === null || rowKey === null
          ? 'undetermined'
          : rowKey === subjectKey
            ? 'same'
            : 'different'
      const probe = await probePaneLiveness(deps, row.paneKey)
      if (probe.ptyId) {
        ptyIdByPane.set(row.paneKey, probe.ptyId)
      }
      return {
        paneKey: row.paneKey,
        identity,
        observedInCurrentRuntime: deps.isObservedInCurrentRuntime(row.paneKey),
        ptyLiveness: probe.liveness
      }
    })
  )
  const presence = projectLiveAgentSessionPresence({
    requestingPaneKey: args.requestingPaneKey,
    candidates
  })
  const incarnationByPane: Record<string, string> = {}
  for (const paneKey of presence.liveElsewhere) {
    const ptyId = ptyIdByPane.get(paneKey)
    if (ptyId) {
      incarnationByPane[paneKey] = ptyId
    }
  }
  return { ...presence, incarnationByPane }
}
