// Which provider runs a turn, and why. The agent is the identity; the provider is a resource
// chosen per turn. Deterministic and explained: every provider not chosen carries its reason, and
// the answer is a refusal — never a silent fallback to something that cannot run the turn.
import type { ProviderType } from '../../shared/agent-status-types'
import type { AgentCapabilitySupport } from '../../shared/agent-turn-event'
import type { ConversationTurnDriver } from './conversation-turn-runner'
import type { ProviderQuotaObservations } from './provider-quota-observations'

export type ConversationProviderEntry = {
  provider: ProviderType
  driver: ConversationTurnDriver
  checkAuth: () => Promise<{ ready: true } | { ready: false; detail: string }>
  /** Whether Orca can offer this provider tools (orca_delegate). Proven, not assumed. */
  tools: AgentCapabilitySupport
}

export type TurnRequirement = {
  /** A person's or policy's explicit choice. Tried first; never silently replaced if it can run. */
  preferred?: ProviderType
  /** The provider the conversation last used, preferred for continuity after `preferred`. */
  continuity?: ProviderType | null
  /** Hard: the turn must run somewhere that can serve Orca's tools. */
  needsTools?: boolean
  /** Soft: rank providers that can serve tools ahead of those that cannot. */
  prefersTools?: boolean
  /** Never these, e.g. the provider that produced what is being independently reviewed. */
  exclude?: readonly ProviderType[]
}

/** `auth` is the one kind a person can fix by signing in; the provider exists and could run the turn. */
export type ProviderSkipKind = 'excluded' | 'capability' | 'quota' | 'auth'

export type ProviderSkip = { provider: ProviderType; kind: ProviderSkipKind; reason: string }

export type ProviderRoute =
  | { outcome: 'routed'; entry: ConversationProviderEntry; skipped: ProviderSkip[] }
  /** Nothing ran, but sign-in alone would change that. `entry` is the best-ranked signed-out
   *  provider, so the turn still passes through the runner's own gates in their own order. */
  | { outcome: 'auth-required'; entry: ConversationProviderEntry; skipped: ProviderSkip[] }
  | { outcome: 'refused'; skipped: ProviderSkip[] }

function rank(entries: readonly ConversationProviderEntry[], requirement: TurnRequirement): ConversationProviderEntry[] {
  const score = (entry: ConversationProviderEntry): number => {
    if (entry.provider === requirement.preferred) {
      return 0
    }
    if (entry.provider === requirement.continuity) {
      return 1
    }
    if (requirement.prefersTools && entry.tools === 'supported') {
      return 2
    }
    return 3
  }
  // Stable: equal scores keep registry order, so the answer never depends on sort internals.
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => score(a.entry) - score(b.entry) || a.index - b.index)
    .map(({ entry }) => entry)
}

export async function routeConversationTurn(params: {
  entries: readonly ConversationProviderEntry[]
  requirement: TurnRequirement
  quota: ProviderQuotaObservations
  now: number
}): Promise<ProviderRoute> {
  const { requirement } = params
  const skipped: ProviderSkip[] = []
  let signedOut: ConversationProviderEntry | null = null
  for (const entry of rank(params.entries, requirement)) {
    const skip = (kind: ProviderSkipKind, reason: string): void => {
      skipped.push({ provider: entry.provider, kind, reason })
    }
    if (requirement.exclude?.includes(entry.provider)) {
      skip('excluded', 'excluded for this turn')
      continue
    }
    if (requirement.needsTools && entry.tools !== 'supported') {
      skip('capability', `cannot serve Orca's tools (${entry.tools})`)
      continue
    }
    const quota = params.quota.read(entry.provider, params.now)
    if (quota.state === 'exhausted') {
      const until = quota.resetsAtMs === null ? 'an unstated time' : new Date(quota.resetsAtMs).toISOString()
      skip('quota', `quota ${quota.reported} until ${until}`)
      continue
    }
    const auth = await entry.checkAuth()
    if (!auth.ready) {
      skip('auth', auth.detail)
      signedOut ??= entry
      continue
    }
    return { outcome: 'routed', entry, skipped }
  }
  // A signed-out provider exists and passed every other check: absent is the wrong answer for it.
  return signedOut ? { outcome: 'auth-required', entry: signedOut, skipped } : { outcome: 'refused', skipped }
}

/** One line a transcript can show: who runs this turn and why the others did not. */
export function describeRoute(route: ProviderRoute): string {
  const others = route.skipped.map((skip) => `${skip.provider}: ${skip.reason}`).join('; ')
  switch (route.outcome) {
    case 'routed':
      return `running on ${route.entry.provider}${others ? ` (${others})` : ''}`
    case 'auth-required':
      return `sign in to run this turn (${others})`
    case 'refused':
      return `no provider can run this turn (${others || 'none registered'})`
  }
}
