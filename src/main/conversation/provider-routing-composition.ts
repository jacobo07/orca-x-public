// The one place the desktop's providers are assembled. The conversations IPC and the delegated-task
// runner both use it, so a person's message and an agent's task cannot see different providers,
// different auth checks or different quota. Free of Electron, so a real-provider test can build
// exactly what production builds.
import { checkClaudeAuth } from '../claude/claude-auth-readiness'
import { createClaudeConversationDriver } from '../claude/claude-conversation-driver'
import { checkCodexAuth } from '../codex/codex-auth-readiness'
import { createCodexConversationDriver } from '../codex/codex-conversation-driver'
import type { ConversationProviderEntry, TurnRequirement } from './conversation-provider-routing'
import type { ConversationTurnDeps, ConversationTurnRequest } from './conversation-turn-runner'
import { ProviderQuotaObservations } from './provider-quota-observations'
import { runRoutedConversationTurn, type RoutedTurnResult } from './routed-conversation-turn'

export type ProviderRouting = {
  providers: readonly ConversationProviderEntry[]
  quota: ProviderQuotaObservations
  runTurn: (
    request: ConversationTurnRequest,
    requirement?: Omit<TurnRequirement, 'continuity'>
  ) => Promise<RoutedTurnResult>
}

export function composeProviderRouting(params: {
  base: Omit<ConversationTurnDeps, 'driver' | 'checkAuth'>
  quota?: ProviderQuotaObservations
  /** Overridable so a test can pin one provider's answer; production takes the real checks. */
  checks?: {
    codex?: ConversationProviderEntry['checkAuth']
    claude?: ConversationProviderEntry['checkAuth']
  }
}): ProviderRouting {
  const quota = params.quota ?? new ProviderQuotaObservations()
  // Registry order is the default preference; routing explains every provider it passes over.
  // Both serve Orca's tools, each measured live: Codex as dynamic tools, Claude over a per-turn MCP server.
  const providers: ConversationProviderEntry[] = [
    {
      provider: 'codex',
      driver: createCodexConversationDriver(),
      checkAuth: params.checks?.codex ?? checkCodexAuth,
      tools: 'supported'
    },
    {
      provider: 'claude',
      driver: createClaudeConversationDriver({
        observeQuota: (observation) => quota.record('claude', observation, Date.now())
      }),
      checkAuth: params.checks?.claude ?? (() => checkClaudeAuth()),
      tools: 'supported'
    }
  ]
  const routedDeps = { ...params.base, providers, quota }
  return {
    providers,
    quota,
    runTurn: (request, requirement) => runRoutedConversationTurn(routedDeps, request, requirement)
  }
}
