import type { Agent } from '../../shared/agent-types'

/**
 * The durable agent roster.
 *
 * `list` and nothing else, on purpose. An Agent is a durable product actor whose identity is minted
 * by main and whose project relation participates in Project id succession; a renderer that could
 * write either one would be a second authority over both. Creation arrives as its own operation,
 * and it will still be main that mints and persists.
 *
 * There is no `onChanged` subscription yet. Nothing outside this process mutates the roster, so a
 * live stream would carry events no producer emits — the multi-window case is named debt rather
 * than a channel that looks live and is not.
 */
export type AgentDirectoryApi = {
  agents: {
    /** Post-succession ownership, sorted by display name and tie-broken by id. */
    list: () => Promise<Agent[]>
  }
}
