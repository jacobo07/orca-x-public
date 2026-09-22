// What an Agent contributes to a provider turn: the one place its durable configuration becomes
// instructions. A second compiler would mean two answers to "what did this agent receive".
//
// The output is DEVELOPER-layer data, sent as `developerInstructions`, which the provider layers
// above its own base instructions. It is never `baseInstructions`: that REPLACES the provider's
// own, and a role written by a user must not be able to override the layer that governs it.
//
// Only name and role reach the turn. The agent's project is ownership, not context: nothing here
// attaches project files, repository knowledge or memory, and claiming otherwise would be a lie
// about what the model was told.

import type { Agent } from '../../shared/agent-types'

export function compileAgentTurnInstructions(agent: Pick<Agent, 'name' | 'role'>): string {
  const lines = [`You are the Orca agent named "${agent.name}".`]
  const role = agent.role.trim()
  if (role.length > 0) {
    // Framed as the creator's description so it reads as configuration, not as a user turn.
    lines.push('', 'The person who created you described your role like this:', role)
  }
  return lines.join('\n')
}
