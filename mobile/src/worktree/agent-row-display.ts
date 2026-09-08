import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus
} from '../../../src/shared/agent-status-types'

// Re-exported so this module stays the mobile import surface for the threshold. The value and the
// freshness rule are the desktop's own: a local mirror had already drifted, missing the
// `restoredUnconfirmed` clause entirely and showing unconfirmed rows as live work.
//
// The previous note here said a runtime-value import from a root .ts breaks mobile's vitest
// transform. That is no longer true -- src/shared/terminal-launch-profiles.ts is imported for value
// by mobile's launch-profile options and its suite passes.
export { AGENT_STATUS_STALE_AFTER_MS }

// Mirrors the desktop AgentStateDot vocabulary. The wire `state` is the agent
// status state; 'blocked'/'waiting' read as attention states, 'done' as
// complete, everything else idle.
export type AgentDotState = 'working' | 'blocked' | 'waiting' | 'done' | 'idle' | 'interrupted'

export function agentDotState(
  row: Pick<
    RuntimeWorktreeAgentRow,
    'state' | 'interrupted' | 'updatedAt' | 'restoredUnconfirmed'
  >,
  now: number
): AgentDotState {
  if (row.interrupted) {
    return 'interrupted'
  }
  switch (row.state) {
    case 'working':
    case 'blocked':
    case 'waiting':
      // Why the shared predicate rather than a timestamp comparison: an agent that exits without a
      // final report would read as active forever, and so would one the host hydrated from disk
      // and never had confirmed -- `restoredUnconfirmed` says the host is not asserting this turn
      // is still running, and no amount of recency makes that assertion true.
      return isFreshNonDoneAgentStatus(row, now) ? row.state : 'idle'
    case 'done':
      return 'done'
  }
  return 'idle'
}

// Mirrors desktop agentStateLabel.
export function agentStateLabel(state: AgentDotState): string {
  switch (state) {
    case 'working':
      return 'Working'
    case 'blocked':
      return 'Blocked'
    case 'waiting':
      return 'Waiting for input'
    case 'interrupted':
      return 'Interrupted'
    case 'done':
      return 'Done'
    case 'idle':
      return 'Idle'
  }
}

// Primary row text: prefer the agent's last message, then the user prompt, then
// a human-readable state label so a row is never blank. Matches the desktop
// DashboardAgentRow displayLabel fallback chain.
export function agentDisplayLabel(row: RuntimeWorktreeAgentRow, now: number): string {
  const message = row.lastAssistantMessage?.trim()
  if (message) {
    return message
  }
  const prompt = row.prompt.trim()
  if (prompt) {
    return prompt
  }
  return agentStateLabel(agentDotState(row, now))
}

// Short agent identity label by type (Claude/Codex/Gemini/…), used when no
// identity icon is available on mobile. Falls back to the first two letters.
export function agentIdentityLabel(agentType: string | null): string {
  if (!agentType) {
    return ''
  }
  const normalized = agentType.toLowerCase()
  const known: Record<string, string> = {
    claude: 'CL',
    codex: 'CX',
    gemini: 'GM',
    cursor: 'CR',
    copilot: 'CP',
    amp: 'AM',
    aider: 'AI',
    opencode: 'OC',
    'mimo-code': 'MC'
  }
  return known[normalized] ?? normalized.slice(0, 2).toUpperCase()
}

// Relative time, matching desktop formatTimeAgo thresholds (just now / Xm / Xh / Xd).
export function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  return `${days}d`
}
