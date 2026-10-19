import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileSessionTab } from './mobile-session-route-types'
import { resolveMobileTerminalTabAgentId } from './mobile-terminal-tab-agent'

/** A New Tab row, tagged with the agent it launches when it launches one. */
export type RuntimeAgentAction = ActionSheetAction & { runtimeAgentId?: string }

export type ActiveTabRuntime =
  | { kind: 'agent'; agentId: string }
  | { kind: 'shell' }
  | { kind: 'none' }

const ACTIVE_HINT = 'Active tab'

export function resolveActiveTabRuntime(
  tab: MobileSessionTab | null | undefined
): ActiveTabRuntime {
  if (!tab || tab.type !== 'terminal') {
    return { kind: 'none' }
  }
  const agentId = resolveMobileTerminalTabAgentId(tab)
  return agentId ? { kind: 'agent', agentId } : { kind: 'shell' }
}

function markActive(action: ActionSheetAction): ActionSheetAction {
  return { ...action, hint: action.hint ? `${action.hint} · ${ACTIVE_HINT}` : ACTIVE_HINT }
}

/** The Runtimes sheet: New Tab's agent rows, then Terminal, with the active tab's runtime marked. */
export function buildMobileSessionRuntimeActions(
  agentActions: readonly RuntimeAgentAction[],
  terminalAction: ActionSheetAction,
  active: ActiveTabRuntime
): ActionSheetAction[] {
  const agents = agentActions.map((action) =>
    active.kind === 'agent' && action.runtimeAgentId === active.agentId
      ? markActive(action)
      : action
  )
  return [...agents, active.kind === 'shell' ? markActive(terminalAction) : terminalAction]
}
