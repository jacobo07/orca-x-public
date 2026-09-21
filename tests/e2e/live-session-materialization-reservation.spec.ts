import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import type {
  LiveAgentSessionPresenceWireKind,
  LiveSessionMaterializationResponse
} from '../../src/shared/live-agent-session-presence-types'

// Drives the real preload → IPC → main reservation authority, a real PTY's teardown and
// a real SessionStart hook event. Session ids are fresh UUIDs; no provider CLI runs.

type Accept = { kind: LiveAgentSessionPresenceWireKind; ownersRevision: string }

function reserve(
  page: Page,
  args: { worktreeId: string; sessionId: string; operationId: string; accept?: Accept }
): Promise<LiveSessionMaterializationResponse> {
  return page.evaluate(
    ({ worktreeId, sessionId, operationId, accept }) =>
      window.api.agentStatus.reserveMaterialization({
        worktreeId,
        agent: 'claude',
        providerSession: { key: 'session_id', id: sessionId },
        operationId,
        ...(accept ? { accept } : {})
      }),
    args
  )
}

test.describe('live session materialization reservation', () => {
  test('grants one Orca-selected resume per session and hands off to live presence', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const tabId = paneKey.split(':')[0]
    const S = randomUUID()
    const T = randomUUID()
    const U = randomUUID()

    // Two attempts issued together for one session: exactly one is granted.
    const [a, b, unrelated] = await Promise.all([
      reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-a' }),
      reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-b' }),
      reserve(orcaPage, { worktreeId, sessionId: T, operationId: 'op-t' })
    ])
    expect([a.outcome, b.outcome].sort()).toEqual(['blocked', 'granted'])
    const [winner, loser] = a.outcome === 'granted' ? ['op-a', b] : ['op-b', a]
    expect(loser.presence.kind).toBe('materializing')
    expect(unrelated.outcome, 'an unrelated session is not serialized').toBe('granted')

    // Released by its owner, the session is free for the next attempt.
    await orcaPage.evaluate(
      (operationId) => window.api.agentStatus.releaseMaterialization({ operationId }),
      winner
    )
    expect(
      (await reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-c' })).outcome
    ).toBe('granted')

    // op-c's tab has a live PTY and no provider report yet: still starting.
    const attached = await orcaPage.evaluate(
      (args) => window.api.agentStatus.attachMaterializationTab(args),
      { operationId: 'op-c', tabId }
    )
    expect(attached).toBe(true)
    const starting = await reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-d' })
    expect(starting.presence.kind).toBe('materializing')

    // The provider reports SessionStart through the real hook server.
    const endpoint = await readHookEndpoint(electronApp)
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': endpoint.token
      },
      body: JSON.stringify({
        paneKey,
        tabId,
        worktreeId,
        env: endpoint.env,
        version: endpoint.version,
        payload: { hook_event_name: 'SessionStart', session_id: S, source: 'resume' }
      })
    })
    expect(response.status).toBe(204)

    let live: LiveSessionMaterializationResponse | null = null
    await expect
      .poll(
        async () => {
          live = await reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-d' })
          return live.presence.kind
        },
        { timeout: 15_000, message: 'the reported session should read as live elsewhere' }
      )
      .toBe('live-elsewhere')
    // Handoff released op-c: accepting the live collision can now take the reservation.
    const override = await reserve(orcaPage, {
      worktreeId,
      sessionId: S,
      operationId: 'op-d',
      accept: { kind: live!.presence.kind, ownersRevision: live!.presence.ownersRevision }
    })
    expect(override.outcome).toBe('granted')
    // One-shot: a later attempt without an accept is asked again.
    expect(
      (await reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-e' })).outcome
    ).toBe('blocked')

    // A runtime that exits before reporting frees its session.
    expect(
      (await reserve(orcaPage, { worktreeId, sessionId: U, operationId: 'op-u' })).outcome
    ).toBe('granted')
    await orcaPage.evaluate((args) => window.api.agentStatus.attachMaterializationTab(args), {
      operationId: 'op-u',
      tabId
    })
    expect(
      (await reserve(orcaPage, { worktreeId, sessionId: U, operationId: 'op-v' })).presence.kind
    ).toBe('materializing')
    await orcaPage.evaluate((id) => window.api.pty.kill(id), ptyId)
    await expect
      .poll(
        async () =>
          (await reserve(orcaPage, { worktreeId, sessionId: U, operationId: 'op-v' })).outcome,
        { timeout: 15_000, message: 'the PTY teardown should release the reservation' }
      )
      .toBe('granted')
  })

  test('refuses a resume spawn of a session another operation is starting', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const { worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
    const S = randomUUID()
    // What a sleep launch, cold restore or working-set revival sends: an exact session.
    const resumeSpawn = (tabId: string) =>
      orcaPage.evaluate(
        ({ worktreeId, sessionId, tabId, leafId }) =>
          window.api.pty.spawn({
            cols: 80,
            rows: 24,
            worktreeId,
            tabId,
            leafId,
            command: 'echo resume-gate-probe',
            launchAgent: 'claude',
            resumeProviderSession: { key: 'session_id', id: sessionId }
          }),
        { worktreeId, sessionId: S, tabId, leafId: randomUUID() }
      )
    const spawned: string[] = []

    try {
      // An AI Vault resume holds S in another tab and has not reported yet.
      expect(
        (await reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-vault' })).outcome
      ).toBe('granted')
      await orcaPage.evaluate((args) => window.api.agentStatus.attachMaterializationTab(args), {
        operationId: 'op-vault',
        tabId: `e2e-vault-${S}`
      })

      const refused = await resumeSpawn(`e2e-sleep-${S}`)
      spawned.push(refused.id)
      expect(refused.agentResumeRefused).toBe('materializing')
      expect(refused.launchConfig).toBeUndefined()

      await orcaPage.evaluate(
        (operationId) => window.api.agentStatus.releaseMaterialization({ operationId }),
        'op-vault'
      )
      const granted = await resumeSpawn(`e2e-restore-${S}`)
      spawned.push(granted.id)
      expect(granted.agentResumeRefused).toBeUndefined()

      // The granted spawn now holds S against the vault path.
      const vault = await reserve(orcaPage, { worktreeId, sessionId: S, operationId: 'op-vault-2' })
      expect(vault).toMatchObject({ outcome: 'blocked', presence: { kind: 'materializing' } })
    } finally {
      for (const id of spawned) {
        await orcaPage.evaluate((ptyId) => window.api.pty.kill(ptyId), id)
      }
    }
  })
})
