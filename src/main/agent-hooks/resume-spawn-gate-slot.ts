import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { LiveSessionResumeRefusal } from '../../shared/live-agent-session-presence-types'
import type { TuiAgent } from '../../shared/tui-agent'

/** Raw session a runtime ensure resumes; its signed claim alone cannot be matched to hook rows. */
export type AgentSessionResumeSubject = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

/** The window that asked for the spawn; main-initiated spawns have none. */
export type ResumeSpawnSender = {
  id: number
  once: (event: 'destroyed', listener: () => void) => unknown
}

export type ResumeSpawnRequest = {
  sender: ResumeSpawnSender | null
  worktreeId: string
  tabId: string
  leafId: string
  agent: unknown
  providerSession: unknown
  /** Claim key the caller already holds (runtime ensure); a different reading is refused. */
  expectedKey?: string
}

export type ResumeSpawnDecision =
  | { outcome: 'proceed'; operationId: string | null }
  | { outcome: 'refused'; reason: LiveSessionResumeRefusal }

/** The one pre-effect authority every local resume spawn crosses, whatever asked for it. */
export type ResumeSpawnGate = {
  decide: (request: ResumeSpawnRequest) => Promise<ResumeSpawnDecision>
  /** The spawn a granted decision allowed did not happen. */
  release: (operationId: string, sender: ResumeSpawnSender | null) => void
}

let installed: ResumeSpawnGate | null = null

export function installResumeSpawnGate(gate: ResumeSpawnGate | null): void {
  installed = gate
}

export function getResumeSpawnGate(): ResumeSpawnGate | null {
  return installed
}
