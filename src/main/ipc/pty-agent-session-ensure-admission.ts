import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import { agentSessionResumeRefusalErrorCode } from '../../shared/agent-session-resume-refusal'
import { agentSessionClaimKey } from '../../shared/claimed-agent-pty-owner-snapshot'
import {
  getResumeSpawnGate,
  type AgentSessionResumeSubject
} from '../agent-hooks/resume-spawn-gate-slot'

/** Runtime ensure (web, runtime-hosted panes) starts a new runtime only after the same presence
 *  check and claim-keyed reservation every desktop resume crosses. Throws a refusal code; returns
 *  the release for a granted hold, which PTY teardown and live handoff otherwise end. */
export async function admitAgentSessionEnsureSpawn(args: {
  connectionId?: string | null
  ensure: { claim: AgentSessionExecutionClaim; surface: AgentSessionSurfaceBinding }
  subject: AgentSessionResumeSubject | undefined
}): Promise<(() => void) | null> {
  const gate = getResumeSpawnGate()
  if (!gate || args.connectionId) {
    // Why: SSH has no claim namespace here, matching the desktop gate.
    return null
  }
  if (!args.subject) {
    // Why: without the raw session, presence cannot be read; a guarded host never guesses.
    throw new Error(agentSessionResumeRefusalErrorCode('unknown'))
  }
  const { surface } = args.ensure
  const decision = await gate.decide({
    sender: null,
    worktreeId: surface.worktreeId,
    tabId: surface.tabId,
    leafId: surface.leafId,
    agent: args.subject.agent,
    providerSession: args.subject.providerSession,
    expectedKey: agentSessionClaimKey(args.ensure.claim)
  })
  if (decision.outcome === 'refused') {
    throw new Error(agentSessionResumeRefusalErrorCode(decision.reason))
  }
  const operationId = decision.operationId
  return operationId ? () => gate.release(operationId, null) : null
}

/** A host-side terminal.create that resumes a recorded session (a client that fell back to the
 *  legacy create, a host wake) crosses the same gate the renderer's pty:spawn does. */
export async function admitRecordedResumeSpawn(args: {
  connectionId?: string | null
  worktreeId?: string
  tabId?: string
  leafId?: string
  agent: unknown
  providerSession: unknown
}): Promise<(() => void) | null> {
  const gate = getResumeSpawnGate()
  if (
    !gate ||
    args.connectionId ||
    args.providerSession === undefined ||
    !args.worktreeId ||
    !args.tabId ||
    !args.leafId
  ) {
    // Why: the same preconditions the renderer spawn gate applies.
    return null
  }
  const decision = await gate.decide({
    sender: null,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    agent: args.agent,
    providerSession: args.providerSession
  })
  if (decision.outcome === 'refused') {
    throw new Error(agentSessionResumeRefusalErrorCode(decision.reason))
  }
  const operationId = decision.operationId
  return operationId ? () => gate.release(operationId, null) : null
}
