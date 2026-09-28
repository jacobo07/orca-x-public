import { mintAgentId } from '../../../shared/agent-identity'
import type { Agent, AgentCreationInput, AgentCreationResult } from '../../../shared/agent-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'

/**
 * The durable agent roster: the one place an Agent is read from, and the one place one is created.
 *
 * `PersistedState.agents[]` is the single durable actor catalog declared in
 * config/durable-actor-catalogs.jsonc. It is read through here rather than projected into a
 * renderer store because a second roster would mean two answers to "who is this agent" — and
 * because each record's projectId is rewritten by `rebuildRepoBackedProjectState` when a Project id
 * is promoted (repo: -> git: -> github:). Reading through the store means a caller always sees the
 * POST-succession ownership; a cached copy taken before a promotion points at a project that no
 * longer exists under that id, and nothing would tell it.
 */

export type AgentMutationOperations = {
  state: StoreOwnedPersistedState
  scheduleSave: () => void
  /** Drains the debounced writer and resolves only once the state is on disk. */
  flushDurableStateOrThrowAsync: () => Promise<void>
  now?: () => number
}

export class AgentPersistenceOperations {
  constructor(private readonly operations: AgentMutationOperations) {}

  private get state(): PersistedState {
    return this.operations.state
  }

  private now(): number {
    return (this.operations.now ?? Date.now)()
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

  /**
   * The only production caller of `mintAgentId`, enforced by `check:agent-identity-authority`.
   *
   * Three things happen here that could each have been put somewhere more convenient and would
   * have been wrong there:
   *
   * 1. THE PROJECT IS RE-RESOLVED AT EFFECT TIME. A Project id is derived, not minted, and
   *    `getProjectIdentityKey` promotes repo: -> git: -> github: mid-session as a remote probe
   *    learns more. So the id the form displayed may not be the id that exists by the time someone
   *    presses the button. Validating against `state.projects` HERE — not when the dialog opened,
   *    and not in the renderer — is what stops an agent being born owned by a project id that no
   *    longer resolves. Refusing is correct: the alternative is guessing which project they meant.
   *
   * 2. THE WRITE IS FLUSHED BEFORE THIS RESOLVES. `scheduleSave` is debounced 1s trailing / 5s
   *    max, so returning on the schedule would report success for something that exists only in
   *    memory, and a crash inside that window loses an agent the user watched appear. The store
   *    already does exactly this for the pty binding before `pty:spawn` returns (issue #217); this
   *    is the same trade, for the same reason.
   *
   * 3. A FAILED FLUSH IS ROLLED BACK. Leaving the record in memory after the disk refused it is
   *    worse than either outcome on its own: the roster would show an agent that is not persisted,
   *    and the next unrelated save would quietly commit it. Removal is by id, so a concurrent
   *    mutation is untouched.
   */
  async createAgent(input: AgentCreationInput): Promise<AgentCreationResult> {
    const name = input.name.trim()
    if (name.length === 0) {
      return { outcome: 'invalid', reason: 'an agent needs a name' }
    }
    // The role may be empty. It is "what this agent is for, in the user's words", and demanding a
    // sentence before someone may write a name down is a form to fill in, not a product.
    const role = input.role.trim()

    const projectId = input.projectId
    if (projectId !== null && !this.state.projects.some((project) => project.id === projectId)) {
      return { outcome: 'project-not-found', projectId }
    }

    const createdAt = this.now()
    const agent: Agent = {
      id: mintAgentId(),
      name,
      role,
      projectId,
      createdAt,
      updatedAt: createdAt
    }

    this.state.agents = [...(this.state.agents ?? []), agent]
    this.operations.scheduleSave()
    try {
      await this.operations.flushDurableStateOrThrowAsync()
    } catch (error) {
      this.state.agents = (this.state.agents ?? []).filter((entry) => entry.id !== agent.id)
      return {
        outcome: 'not-persisted',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    return { outcome: 'created', agent }
  }
}
