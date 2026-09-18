import { describe, expect, it, vi } from 'vitest'
import {
  handOffMaterializationOnLiveReport,
  installMaterializationHandoff,
  type MaterializationHandoffEvent
} from './live-session-materialization-handoff'
import { LiveSessionMaterializationReservations } from './live-session-materialization-reservation'

const SESSION_S = { key: 'session_id' as const, id: 'session-s' }
const LEAF = '11111111-1111-4111-8111-111111111111'

function setup() {
  const reservations = new LiveSessionMaterializationReservations({
    now: () => 1_000,
    hasBoundPty: () => true
  })
  expect(reservations.tryAcquire('key:s', 'op-1', 7)).toBe('granted')
  expect(reservations.attachTab('op-1', 7, 'tab-a')).toBe(true)
  const deps = {
    resolveIdentityKey: vi.fn(async ({ providerSession }: { providerSession: { id: string } }) =>
      providerSession.id === 'session-s' ? 'key:s' : `key:${providerSession.id}`
    )
  }
  return { reservations, deps }
}

function report(overrides: Partial<MaterializationHandoffEvent> = {}): MaterializationHandoffEvent {
  return {
    paneKey: `tab-a:${LEAF}`,
    worktreeId: 'wt-1',
    connectionId: null,
    providerSession: SESSION_S,
    payload: { state: 'working', prompt: '', agentType: 'claude' },
    ...overrides
  } as MaterializationHandoffEvent
}

// A resumed session that goes live ends its reservation at once. Without this the tab's
// still-bound shell kept it held after the agent exited, refusing the next resume.
describe('handOffMaterializationOnLiveReport', () => {
  it('releases the reservation when its session reports live in the reserved tab', async () => {
    const { reservations, deps } = setup()
    await expect(handOffMaterializationOnLiveReport(deps, reservations, report())).resolves.toBe(
      true
    )
    expect(reservations.holder('key:s')).toBeNull()
    expect(reservations.tryAcquire('key:s', 'op-2', 7)).toBe('granted')
  })

  it.each<[string, Partial<MaterializationHandoffEvent>]>([
    [
      'a different session in the same tab',
      { providerSession: { key: 'session_id', id: 'other' } }
    ],
    ['the same session in another tab', { paneKey: `tab-b:${LEAF}` }],
    ['a replayed report', { isReplay: true }],
    ['a report restored from disk', { restoredUnconfirmed: true }],
    ['an identity kept only for liveness', { retainedForLiveness: true }],
    ['a report with no session', { providerSession: undefined }]
  ])('keeps the reservation for %s', async (_label, overrides) => {
    const { reservations, deps } = setup()
    await expect(
      handOffMaterializationOnLiveReport(deps, reservations, report(overrides))
    ).resolves.toBe(false)
    expect(reservations.holder('key:s')?.operationId).toBe('op-1')
  })

  it('does not resolve identities for a tab that holds no reservation', async () => {
    const { reservations, deps } = setup()
    await handOffMaterializationOnLiveReport(
      deps,
      reservations,
      report({ paneKey: `tab-z:${LEAF}` })
    )
    expect(deps.resolveIdentityKey).not.toHaveBeenCalled()
  })

  it('keeps the reservation when the identity cannot be placed', async () => {
    const { reservations } = setup()
    const deps = { resolveIdentityKey: vi.fn(async () => null) }
    await expect(handOffMaterializationOnLiveReport(deps, reservations, report())).resolves.toBe(
      false
    )
    expect(reservations.holder('key:s')).not.toBeNull()
  })

  it('is wired to live reports and survives a runtime that is not ready', async () => {
    const { reservations, deps } = setup()
    let listener: ((event: MaterializationHandoffEvent) => void) | null = null
    let ready = false
    const unsubscribe = vi.fn()
    installMaterializationHandoff({
      subscribe: (l) => {
        listener = l
        return unsubscribe
      },
      resolveDeps: () => {
        if (!ready) {
          throw new Error('runtime_unavailable')
        }
        return deps
      },
      resolveReservations: () => reservations
    })
    expect(() => listener!(report())).not.toThrow()
    ready = true
    listener!(report())
    await vi.waitFor(() => expect(reservations.holder('key:s')).toBeNull())
  })
})
