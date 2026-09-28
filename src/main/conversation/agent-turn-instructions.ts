// What an Agent contributes to a provider turn: the one place its durable configuration becomes
// instructions. A second compiler would mean two answers to "what did this agent receive".
//
// The output is DEVELOPER-layer data, sent as `developerInstructions`, which the provider layers
// above its own base instructions. It is never `baseInstructions`: that REPLACES the provider's
// own, and a role written by a user must not be able to override the layer that governs it.
//
// WHAT REACHES THE MODEL, AND WHAT DOES NOT.
//
// Name, role, and — since the agent's project became the turn's working directory — a bounded
// statement of WHERE it is working and WHICH project that is. No file contents, no repository
// listing, no memory, no summary. That is deliberate rather than unfinished: the provider reads the
// project's own AGENTS.md and files from its working directory on demand, so the useful context is
// retrieved by the model when it needs it instead of being pasted into every turn. This envelope is
// constant-size and does not grow with the project.
//
// The envelope says only what Orca can attribute. A path is stated because Orca resolved it from
// the agent's project this turn; nothing here claims the directory's contents, its branch or its
// freshness, because this module reads none of those and asserting them would be invention.

import type { Agent } from '../../shared/agent-types'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { AgentProjectLocation } from './agent-project-location'

/** The location the turn actually runs in, as resolved for THIS turn. `no-project` is a real state
 *  and is said out loud; the refusing states never reach here, because a turn that cannot reach its
 *  project does not run. */
type CompilableLocation = Extract<
  AgentProjectLocation,
  { outcome: 'resolved' | 'resolved-remote' | 'no-project' }
>

export function compileAgentTurnInstructions(
  agent: Pick<Agent, 'name' | 'role'>,
  location: CompilableLocation
): string {
  const lines = [`You are the Orca agent named "${agent.name}".`]

  const role = agent.role.trim()
  if (role.length > 0) {
    // Framed as the creator's description so it reads as configuration, not as a user turn.
    lines.push('', 'The person who created you described your role like this:', role)
  }

  if (location.outcome === 'resolved') {
    lines.push(
      '',
      `You belong to the Orca project "${location.displayName}", and this conversation runs in its working directory on this computer: ${location.path}`,
      'Read that directory when you need to know something about the project. It is the project as it stands right now, including any uncommitted changes, so prefer reading it over recalling anything about a project with a similar name.'
    )
  } else if (location.outcome === 'resolved-remote') {
    // The host is named from its id, never from anything the directory might claim about itself.
    const host = parseExecutionHostId(location.hostId)
    const hostName = host?.kind === 'ssh' ? host.targetId : location.hostId
    lines.push(
      '',
      `You belong to the Orca project "${location.displayName}", and this conversation runs in its working directory on the remote host "${hostName}": ${location.path}`,
      'Read that directory when you need to know something about the project. It is the project as it stands right now on that host, including any uncommitted changes, so prefer reading it over recalling anything about a project with a similar name.'
    )
  } else {
    // Said explicitly. An agent left to infer its situation from silence will assume whatever
    // directory it finds itself in is "the project", which is the failure this whole wave removed.
    lines.push(
      '',
      'You do not belong to any Orca project. This conversation does not run in a project working directory, so do not treat the directory you are in as one.'
    )
  }

  return lines.join('\n')
}
