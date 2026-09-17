import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  buildMobileAiVaultResumeLaunch,
  resumeAiVaultSessionInTerminal,
  type MobileAiVaultResumeSettings
} from './ai-vault-resume-launch'

export type MobileAiVaultResumeRequest = {
  session: AiVaultSession
  worktreeId: string
  workspacePath: string | null
  hostPlatform: NodeJS.Platform
  hostTerminalWindowsShell: string | null
  settings: MobileAiVaultResumeSettings | null
  clientMutationId: string
}

export type MobileAiVaultResumeOutcome = {
  path: 'legacy'
  worktreeId: string
  tabId: string
  terminal: string
}

/** Turns an explicit AI Vault selection into a running session on the host. */
export async function materializeMobileAiVaultResume(
  client: Pick<RpcClient, 'sendRequest'>,
  request: MobileAiVaultResumeRequest
): Promise<MobileAiVaultResumeOutcome> {
  const launch = buildMobileAiVaultResumeLaunch({
    session: request.session,
    hostPlatform: request.hostPlatform,
    hostTerminalWindowsShell: request.hostTerminalWindowsShell,
    settings: request.settings
  })
  const tab = await resumeAiVaultSessionInTerminal(client, request.worktreeId, {
    ...launch,
    clientMutationId: request.clientMutationId
  })
  return { path: 'legacy', worktreeId: request.worktreeId, tabId: tab.id, terminal: tab.terminal }
}
