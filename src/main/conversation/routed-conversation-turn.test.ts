import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { ConversationService } from './conversation-service'
import { routeConversationTurn, type ConversationProviderEntry } from './conversation-provider-routing'
import type { ProviderTurnRequest } from './conversation-turn-runner'
import { ProviderQuotaObservations } from './provider-quota-observations'
import { runRoutedConversationTurn } from './routed-conversation-turn'

type Auth = { ready: true } | { ready: false; detail: string }

function entry(
  provider: 'codex' | 'claude',
  options: { auth?: Auth; tools?: 'supported' | 'unsupported'; calls?: ProviderTurnRequest[] } = {}
): ConversationProviderEntry {
  return {
    provider,
    tools: options.tools ?? (provider === 'codex' ? 'supported' : 'unsupported'),
    checkAuth: async () => options.auth ?? { ready: true },
    driver: {
      provider,
      runTurn: async (request) => {
        options.calls?.push(request)
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent({
          kind: 'message-completed',
          turnId: request.turnId,
          itemId: `${provider}-item`,
          role: 'assistant',
          blocks: [{ type: 'text', text: `answered by ${provider}` }]
        })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: `${provider}-session` }
      }
    }
  }
}

const SIGNED_OUT: Auth = { ready: false, detail: 'codex credential is no-credential' }

describe('routeConversationTurn', () => {
  const now = 1_000_000

  it('takes the first provider that can run the turn, and says why it passed the others', async () => {
    const route = await routeConversationTurn({
      entries: [entry('codex', { auth: SIGNED_OUT }), entry('claude')],
      requirement: {},
      quota: new ProviderQuotaObservations(),
      now
    })

    expect(route).toMatchObject({
      outcome: 'routed',
      entry: { provider: 'claude' },
      skipped: [{ provider: 'codex', reason: 'codex credential is no-credential' }]
    })
  })

  it('keeps a conversation on its provider, ahead of registry order', async () => {
    const route = await routeConversationTurn({
      entries: [entry('codex'), entry('claude')],
      requirement: { continuity: 'claude' },
      quota: new ProviderQuotaObservations(),
      now
    })

    expect(route).toMatchObject({ outcome: 'routed', entry: { provider: 'claude' }, skipped: [] })
  })

  it('puts an explicit preference ahead of continuity', async () => {
    const route = await routeConversationTurn({
      entries: [entry('codex'), entry('claude')],
      requirement: { continuity: 'claude', preferred: 'codex' },
      quota: new ProviderQuotaObservations(),
      now
    })

    expect(route).toMatchObject({ outcome: 'routed', entry: { provider: 'codex' } })
  })

  it('skips a provider whose own quota report says exhausted, until that window resets', async () => {
    const quota = new ProviderQuotaObservations()
    quota.record('claude', { status: 'rejected', utilization: 1, resetsAtMs: now + 60_000 }, now)
    const entries = [entry('claude'), entry('codex')]

    const during = await routeConversationTurn({ entries, requirement: {}, quota, now })
    const after = await routeConversationTurn({ entries, requirement: {}, quota, now: now + 60_001 })

    expect(during).toMatchObject({ outcome: 'routed', entry: { provider: 'codex' } })
    expect(during.skipped[0]).toMatchObject({ provider: 'claude' })
    expect(during.skipped[0].reason).toContain('quota rejected until')
    expect(after).toMatchObject({ outcome: 'routed', entry: { provider: 'claude' } })
  })

  it('still routes to a provider on a warning, which is not exhaustion', async () => {
    const quota = new ProviderQuotaObservations()
    quota.record('claude', { status: 'allowed_warning', utilization: 0.99, resetsAtMs: now + 60_000 }, now)

    const route = await routeConversationTurn({ entries: [entry('claude')], requirement: {}, quota, now })

    expect(route).toMatchObject({ outcome: 'routed', entry: { provider: 'claude' } })
  })

  it('ranks tool-capable providers first when tools are preferred, and requires them when needed', async () => {
    const entries = [entry('claude'), entry('codex')]
    const quota = new ProviderQuotaObservations()

    const preferred = await routeConversationTurn({ entries, requirement: { prefersTools: true }, quota, now })
    const needed = await routeConversationTurn({
      entries: [entry('claude'), entry('codex', { auth: SIGNED_OUT })],
      requirement: { needsTools: true },
      quota,
      now
    })

    expect(preferred).toMatchObject({ outcome: 'routed', entry: { provider: 'codex' } })
    expect(needed).toMatchObject({ outcome: 'refused' })
    expect(needed.skipped.map((skip) => skip.provider)).toEqual(['claude', 'codex'])
  })

  it('never routes to an excluded provider', async () => {
    const route = await routeConversationTurn({
      entries: [entry('codex'), entry('claude')],
      requirement: { exclude: ['codex'] },
      quota: new ProviderQuotaObservations(),
      now
    })

    expect(route).toMatchObject({ outcome: 'routed', entry: { provider: 'claude' } })
  })
})

describe('runRoutedConversationTurn', () => {
  let root = ''
  let service: ConversationService
  let emitted: AgentTurnEvent[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-routed-turn-'))
    service = new ConversationService(() => join(root, 'conversations'))
    emitted = []
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function deps(providers: ConversationProviderEntry[]) {
    let turn = 0
    return {
      service,
      providers,
      quota: new ProviderQuotaObservations(),
      resolveProjectLocation: () => ({ outcome: 'no-project' as const }),
      fallbackCwd: () => root,
      mintTurnId: () => `turn-${++turn}`,
      mintItemId: () => `item-${turn}`,
      emit: (_id: string, event: AgentTurnEvent) => {
        emitted.push(event)
      }
    }
  }

  it('runs on the provider that can, and announces the choice with its reason', async () => {
    const conversation = await service.create({})
    const claudeCalls: ProviderTurnRequest[] = []

    const result = await runRoutedConversationTurn(
      deps([entry('codex', { auth: SIGNED_OUT }), entry('claude', { calls: claudeCalls })]),
      { conversationId: conversation.id, text: 'hello', cwd: null }
    )

    expect(result).toMatchObject({ provider: 'claude', turn: { outcome: 'completed' } })
    expect(claudeCalls).toHaveLength(1)
    expect(emitted[0]).toEqual({
      kind: 'provider-status',
      status: 'routed',
      detail: 'running on claude (codex: codex credential is no-credential)'
    })
  })

  it('refuses with every reason and commits nothing when no provider can run the turn', async () => {
    const conversation = await service.create({})

    const result = await runRoutedConversationTurn(
      deps([
        entry('codex', { auth: SIGNED_OUT }),
        entry('claude', { auth: { ready: false, detail: 'claude credential is absent' } })
      ]),
      { conversationId: conversation.id, text: 'hello', cwd: null }
    )

    expect(result.turn).toEqual({
      outcome: 'no-provider',
      detail:
        'no provider can run this turn (codex: codex credential is no-credential; claude: claude credential is absent)'
    })
    const loaded = await service.read(conversation.id)
    expect(loaded.outcome === 'loaded' && loaded.record.messages).toEqual([])
  })

  it('stays on the provider a conversation already uses', async () => {
    const conversation = await service.create({})
    const codexCalls: ProviderTurnRequest[] = []
    const providers = [entry('codex', { calls: codexCalls }), entry('claude')]
    const signedOutFirst = [entry('codex', { auth: SIGNED_OUT }), entry('claude')]

    await runRoutedConversationTurn(deps(signedOutFirst), { conversationId: conversation.id, text: 'one', cwd: null })
    const second = await runRoutedConversationTurn(deps(providers), {
      conversationId: conversation.id,
      text: 'two',
      cwd: null
    })

    expect(second.provider).toBe('claude')
    expect(codexCalls).toEqual([])
  })
})
