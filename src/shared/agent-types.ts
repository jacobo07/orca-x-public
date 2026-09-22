// ─── Agent: a durable product actor ──────────────────────────────────
// The thing a user names, talks to, and still has next week. Orca had ~400 Agent-named modules
// before this one and not a single durable actor among them: AgentStatusEntry is keyed by paneKey,
// ProviderType says which vendor CLI, AGENT_CATALOG is a hardcoded vendor list, AgentTeam is tmux
// transport, and AI Vault scans provider transcripts. This is the first, and per
// config/durable-actor-catalogs.jsonc it is meant to be the only one.
//
// An Agent is not a conversation, a provider, a provider session, a process, a pane or a host. It
// may reference some of them; it is reducible to none of them.
//
// Plain JSON only — this is persisted and crosses IPC.

export const AGENT_ID_PREFIX = 'agent_'

/** Opaque Orca-minted id. Never parsed for meaning, never derived from anything that can change. */
export type AgentId = string

export type Agent = {
  id: AgentId
  /** Display name — NOT identity. Two agents may share one, and renaming changes nothing. */
  name: string
  /** What this agent is for, in the user's words. */
  role: string
  /**
   * The owning Project (`project-types.ts`), or null for an agent owned by no project.
   *
   * This is a DERIVED REPLACEABLE identity, not a minted one: `getProjectIdentityKey` promotes
   * `repo:` → `git:` → `github:` as a remote probe learns more, mid-session. So agents are
   * remapped inside `rebuildRepoBackedProjectState`, beside `projectHostSetups`, and nowhere else
   * — the succession map is computed per read and discarded, so a dependent that misses that
   * moment can never catch up later.
   */
  projectId: string | null
  createdAt: number
  updatedAt: number
}
