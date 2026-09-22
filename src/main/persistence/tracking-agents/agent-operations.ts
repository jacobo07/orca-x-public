import type { Agent } from '../../../shared/agent-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'

/**
 * The durable agent roster, read through the one owner that holds it.
 *
 * `PersistedState.agents[]` is the single durable actor catalog declared in
 * config/durable-actor-catalogs.jsonc. It is read here rather than projected into a renderer store
 * of its own because a second roster would mean two answers to "who is this agent" — and because
 * the projectId on each record is rewritten by `rebuildRepoBackedProjectState` when a Project id is
 * promoted (repo: -> git: -> github:). Reading through the store means a caller always sees the
 * POST-succession ownership; a cached copy taken before a promotion would point at a project that
 * no longer exists under that id, and nothing would tell it.
 */

export type AgentMutationOperations = {
  state: StoreOwnedPersistedState
}

export class AgentPersistenceOperations {
  constructor(private readonly operations: AgentMutationOperations) {}

  private get state(): PersistedState {
    return this.operations.state
  }

  /**
   * Sorted by display name, tie-broken by id.
   *
   * The tie-break is not decoration: two agents may legitimately share a name — the name is not
   * identity and renaming changes nothing — so a comparator that only looks at the name leaves
   * their relative order to whatever the sort happens to do, and a list that reshuffles between
   * reads looks like the roster changed when it did not.
   */
  getAgents(): Agent[] {
    return [...(this.state.agents ?? [])].sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    )
  }
}
