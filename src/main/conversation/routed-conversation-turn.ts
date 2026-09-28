// A conversation turn whose provider is chosen per turn. The runner is unchanged: routing only
// decides which driver and which auth check it is handed, and says why.
import type { ProviderType } from '../../shared/agent-status-types'
import type { ConversationTurnOutcome } from '../../shared/conversation-turn'
import {
  describeRoute,
  routeConversationTurn,
  type ConversationProviderEntry,
  type TurnRequirement
} from './conversation-provider-routing'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ConversationTurnRequest
} from './conversation-turn-runner'
import type { ProviderQuotaObservations } from './provider-quota-observations'

export type RoutedTurnDeps = Omit<ConversationTurnDeps, 'driver' | 'checkAuth'> & {
  providers: readonly ConversationProviderEntry[]
  quota: ProviderQuotaObservations
}

export type RoutedTurnResult = {
  turn: ConversationTurnOutcome
  /** Null when no provider could run the turn; on auth-required, the one that would run it. */
  provider: ProviderType | null
  route: string
}

export async function runRoutedConversationTurn(
  deps: RoutedTurnDeps,
  request: ConversationTurnRequest,
  requirement: Omit<TurnRequirement, 'continuity'> = {}
): Promise<RoutedTurnResult> {
  const now = deps.now ?? (() => Date.now())
  const existing = await deps.service.read(request.conversationId)
  // Continuity only: a conversation already talking to a provider keeps doing so while it can.
  const continuity = existing.outcome === 'loaded' ? (existing.record.provenance.at(-1)?.agent ?? null) : null
  const route = await routeConversationTurn({
    entries: deps.providers,
    requirement: { ...requirement, continuity },
    quota: deps.quota,
    now: now()
  })
  const explained = describeRoute(route)
  if (route.outcome === 'refused') {
    return { turn: { outcome: 'no-provider', detail: explained }, provider: null, route: explained }
  }
  // Signed out is not absent: the runner keeps its own order (project gate, durable message, auth)
  // and answers auth-required naming every provider. Re-asked there, so a sign-in meanwhile counts.
  const checkAuth: ConversationTurnDeps['checkAuth'] =
    route.outcome === 'routed'
      ? route.entry.checkAuth
      : async () => {
          const auth = await route.entry.checkAuth()
          return auth.ready ? auth : { ready: false, detail: explained }
        }
  if (route.outcome === 'routed') {
    deps.emit(request.conversationId, { kind: 'provider-status', status: 'routed', detail: explained })
  }
  const turn = await runConversationTurn({ ...deps, driver: route.entry.driver, checkAuth }, request)
  return { turn, provider: route.entry.provider, route: explained }
}
