import { ipcMain } from 'electron'

import type { Agent } from '../../shared/agent-types'

/**
 * The durable agent roster, exposed to the renderer as product operations rather than as state.
 *
 * Deliberately narrow, for the same reason the conversation API is: the renderer may ASK for the
 * roster, and everything that decides what is in it — minting identity, validating the project
 * relation, making the write durable — stays in the process that owns PersistedState. A renderer
 * that could hand over an id would have become a second identity authority, which is exactly what
 * `check:agent-identity-authority` refuses.
 *
 * The store is resolved per call, not captured at registration, so a profile switch takes effect
 * immediately instead of serving the previous profile's roster until restart. Reading through the
 * store on every call is also what keeps a Project id promotion visible: `agents[].projectId` is
 * rewritten by `rebuildRepoBackedProjectState`, and a roster cached in the renderer at load time
 * would still be pointing at the pre-promotion id with nothing to tell it.
 */

export type AgentIpcHandlers = {
  'agents:list': () => Promise<Agent[]>
}

export type AgentIpcDeps = {
  readAgents: () => Agent[]
}

export function createAgentIpcHandlers(deps: AgentIpcDeps): AgentIpcHandlers {
  // `async` so a throw is a rejected promise rather than a synchronous one — ipcMain.handle papers
  // over the difference, but the declared type says Promise and every caller may reasonably
  // `.catch()` instead of wrapping the call.
  return {
    'agents:list': async () => deps.readAgents()
  }
}

export function registerAgentHandlers(deps: AgentIpcDeps): void {
  const handlers = createAgentIpcHandlers(deps)
  for (const [channel, handler] of Object.entries(handlers)) {
    // removeHandler first: macOS re-creates the main window after every window is closed, which
    // re-runs registration, and ipcMain.handle throws on a duplicate channel.
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, args) =>
      (handler as (input: unknown) => Promise<unknown>)(args)
    )
  }
}
