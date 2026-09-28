// Who, in this process, can run an agent's turn. Only the desktop host registers one; headless
// `orca serve` has no conversation service, so an agent-assigned task there waits, stated, rather
// than falling through to a terminal.
import type { AgentTaskRunner } from './agent-task-contract'

let registered: AgentTaskRunner | null = null

export function registerAgentTaskRunner(runner: AgentTaskRunner | null): void {
  registered = runner
}

export function getRegisteredAgentTaskRunner(): AgentTaskRunner | null {
  return registered
}
