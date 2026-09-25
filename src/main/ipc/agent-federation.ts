// The desktop's channels for an agent's reviews and approvals. Deciding an approval is a person's
// act, so it is served only here — to Orca's own window — and never over the runtime RPC, which a
// worker terminal or a paired device can also call.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import { isAgentId } from '../../shared/agent-identity'
import type { AgentFederationView, GateDecisionView } from '../../shared/agent-federation-view'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import {
  decideAgentApproval,
  readAgentFederationView,
  rebindAgentApproval
} from '../runtime/orchestration/agent-federation-view'
import { isTrustedUIRenderer } from './ui'

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`agent-federation: missing ${what}`)
  }
  return value
}

function requirePerson(event: IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('agent-federation: approvals are decided only from Orca’s own window')
  }
}

export function registerAgentFederationHandlers(getDb: () => OrchestrationDb): void {
  ipcMain.removeHandler('federation:agentView')
  ipcMain.handle('federation:agentView', async (_event, args): Promise<AgentFederationView> => {
    const agentId = (args as { agentId?: unknown } | null)?.agentId
    if (typeof agentId !== 'string' || !isAgentId(agentId)) {
      throw new Error('agent-federation: invalid agentId')
    }
    try {
      return await readAgentFederationView(getDb(), agentId)
    } catch (error) {
      return { outcome: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.removeHandler('federation:decideGate')
  ipcMain.handle('federation:decideGate', async (event, args): Promise<GateDecisionView> => {
    requirePerson(event)
    const input = args as { gateId?: unknown; decision?: unknown; revision?: unknown; patchHash?: unknown } | null
    const decision = input?.decision
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new Error('agent-federation: decision must be approved or rejected')
    }
    return decideAgentApproval(getDb(), {
      gateId: requireString(input?.gateId, 'gateId'),
      decision,
      observed: { revision: requireString(input?.revision, 'revision'), patchHash: requireString(input?.patchHash, 'patchHash') }
    })
  })

  ipcMain.removeHandler('federation:rebindGate')
  ipcMain.handle('federation:rebindGate', async (event, args): Promise<GateDecisionView> => {
    requirePerson(event)
    return rebindAgentApproval(getDb(), requireString((args as { gateId?: unknown } | null)?.gateId, 'gateId'))
  })
}
