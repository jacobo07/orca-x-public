import { describe, expect, it } from 'vitest'
import { routeConversationTurn } from './conversation-provider-routing'
import { composeProviderRouting } from './provider-routing-composition'
import type { ConversationTurnDeps } from './conversation-turn-runner'

const base = {} as Omit<ConversationTurnDeps, 'driver' | 'checkAuth'>

describe('the composed providers', () => {
  // Codex signed out, Claude signed in: this host, and the case where Claude's tool bridge is the
  // only way an agent can delegate at all.
  it('routes a turn that must offer Orca’s tools to Claude when Codex cannot run', async () => {
    const routing = composeProviderRouting({
      base,
      checks: {
        codex: async () => ({ ready: false, detail: 'codex is signed out' }),
        claude: async () => ({ ready: true })
      }
    })

    const route = await routeConversationTurn({
      entries: routing.providers,
      requirement: { needsTools: true },
      quota: routing.quota,
      now: 0
    })

    expect(route).toMatchObject({ outcome: 'routed', entry: { provider: 'claude' } })
    expect(routing.providers.map((entry) => [entry.provider, entry.tools])).toEqual([
      ['codex', 'supported'],
      ['claude', 'supported']
    ])
  })
})
