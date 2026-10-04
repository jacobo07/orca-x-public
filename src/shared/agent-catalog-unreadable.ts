/** The agent catalog exists but is not a readable list: a failed read, which is not the same as "no agents". */
export const AGENT_CATALOG_UNREADABLE_CODE = 'agent-catalog-unreadable'

export class AgentCatalogUnreadableError extends Error {
  readonly code = AGENT_CATALOG_UNREADABLE_CODE

  constructor() {
    super('the stored agent catalog is unreadable')
    this.name = 'AgentCatalogUnreadableError'
  }
}

// Why: matched by `code` so the answer survives a second copy of this module in another bundle.
export function isAgentCatalogUnreadableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === AGENT_CATALOG_UNREADABLE_CODE
  )
}
