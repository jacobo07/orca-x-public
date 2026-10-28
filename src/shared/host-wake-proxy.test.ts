import { describe, expect, it } from 'vitest'
import { HOST_CONNECTIVITY_STATES } from './host-availability'
import { composeWakeProgress } from './host-wake'
import {
  WAKE_PROXY_UNKNOWN_REASONS,
  composeHostWakeRoute,
  composeWakeProxyAvailability,
  planWakeRequest,
  type HostWakeRoute,
  type WakeProxyInputs,
  type WakeRouteBroker
} from './host-wake-proxy'

const T0 = 1_760_000_000_000
// Why a copy: host-availability.ts keeps its wire pattern private, and the composer must meet the same one.
const REASON_PATTERN = /^[a-z0-9_]{1,64}$/
const FORBIDDEN_WORDS = ['powered-off', 'woken', 'host-announced', 'awake']
const BROKER_CAPABILITIES = ['host.availability.v1', 'host.wake-broker.v1']
const GRANTED = [{ targetId: 'wt_1', label: 'PC' }]

function current(overrides: Partial<WakeProxyInputs> = {}): WakeProxyInputs {
  return {
    broker: { connected: true, lastConnectedAt: T0 },
    status: { observedAt: T0 + 1, result: { capabilities: BROKER_CAPABILITIES } },
    targets: { observedAt: T0 + 2, targets: GRANTED },
    ...overrides
  }
}

type Row = {
  name: string
  inputs: WakeProxyInputs
  expected:
    | { value: 'wake-proxy-available'; observedAt: number }
    | { value: 'unknown'; reason: string }
}

// Why a table: the expectation must not come from the composer under test.
const ROWS: Row[] = [
  {
    name: 'positive control: current status then current targets',
    inputs: current(),
    expected: { value: 'wake-proxy-available', observedAt: T0 + 1 }
  },
  {
    name: 'positive control: targets at the connect instant, one malformed entry beside a granted one',
    inputs: current({
      status: { observedAt: T0 + 5, result: { capabilities: BROKER_CAPABILITIES } },
      targets: { observedAt: T0, targets: [{ targetId: 7, label: 'x' }, ...GRANTED] }
    }),
    expected: { value: 'wake-proxy-available', observedAt: T0 }
  },
  {
    name: 'K: broker disconnected with otherwise current answers',
    inputs: current({ broker: { connected: false, lastConnectedAt: T0 } }),
    expected: { value: 'unknown', reason: 'broker_not_connected' }
  },
  {
    name: 'K: never connected this session',
    inputs: current({ broker: { connected: true, lastConnectedAt: null } }),
    expected: { value: 'unknown', reason: 'broker_not_connected' }
  },
  {
    name: 'K: disconnected and never connected',
    inputs: current({ broker: { connected: false, lastConnectedAt: null } }),
    expected: { value: 'unknown', reason: 'broker_not_connected' }
  },
  {
    name: 'status absent',
    inputs: current({ status: null }),
    expected: { value: 'unknown', reason: 'no_status_this_session' }
  },
  {
    name: 'status stale (before the latest connect)',
    inputs: current({
      status: { observedAt: T0 - 1, result: { capabilities: BROKER_CAPABILITIES } }
    }),
    expected: { value: 'unknown', reason: 'no_status_this_session' }
  },
  {
    name: 'status result not an object',
    inputs: current({ status: { observedAt: T0 + 1, result: 'ready' } }),
    expected: { value: 'unknown', reason: 'status_unreadable' }
  },
  {
    name: 'status result null',
    inputs: current({ status: { observedAt: T0 + 1, result: null } }),
    expected: { value: 'unknown', reason: 'status_unreadable' }
  },
  {
    name: 'status capabilities not an array',
    inputs: current({
      status: { observedAt: T0 + 1, result: { capabilities: 'host.wake-broker.v1' } }
    }),
    expected: { value: 'unknown', reason: 'status_unreadable' }
  },
  {
    name: 'M: old broker without host.wake-broker.v1',
    inputs: current({
      status: { observedAt: T0 + 1, result: { capabilities: ['host.availability.v1'] } }
    }),
    expected: { value: 'unknown', reason: 'broker_not_announced' }
  },
  {
    name: 'M: broker announcing no capabilities',
    inputs: current({ status: { observedAt: T0 + 1, result: { capabilities: [] } } }),
    expected: { value: 'unknown', reason: 'broker_not_announced' }
  },
  {
    name: 'targets absent',
    inputs: current({ targets: null }),
    expected: { value: 'unknown', reason: 'no_targets_this_session' }
  },
  {
    name: 'targets stale (before the latest connect)',
    inputs: current({ targets: { observedAt: T0 - 1, targets: GRANTED } }),
    expected: { value: 'unknown', reason: 'no_targets_this_session' }
  },
  {
    name: 'targets not an array',
    inputs: current({ targets: { observedAt: T0 + 2, targets: { wt_1: 'PC' } } }),
    expected: { value: 'unknown', reason: 'targets_unreadable' }
  },
  {
    name: 'targets empty',
    inputs: current({ targets: { observedAt: T0 + 2, targets: [] } }),
    expected: { value: 'unknown', reason: 'no_granted_target' }
  },
  {
    name: 'targets only malformed entries',
    inputs: current({
      targets: {
        observedAt: T0 + 2,
        targets: [{ targetId: 1, label: 'PC' }, { label: 'PC' }, { targetId: 'wt_1' }, null, 'wt_1']
      }
    }),
    expected: { value: 'unknown', reason: 'no_granted_target' }
  }
]

describe('composeWakeProxyAvailability', () => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const observed = composeWakeProxyAvailability(row.inputs)
    if (row.expected.value === 'wake-proxy-available') {
      expect(observed).toEqual({
        value: 'wake-proxy-available',
        evidence: { kind: 'live-response', observedAt: row.expected.observedAt }
      })
      expect(planWakeRequest(observed)).toEqual({ send: true })
      return
    }
    expect(observed).toEqual({ value: 'unknown', evidence: null, reason: row.expected.reason })
    expect(planWakeRequest(observed)).toEqual({ send: false, reason: row.expected.reason })
  })

  const names = ROWS.map((row) => row.name).join('; ')
  it(`only the positive controls yield wake-proxy-available across ${ROWS.length} rows: ${names}`, () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(14)
    expect(HOST_CONNECTIVITY_STATES).toContain('wake-proxy-available')
    for (const row of ROWS) {
      const observed = composeWakeProxyAvailability(row.inputs)
      const plan = planWakeRequest(observed)
      expect(observed.value === 'wake-proxy-available', row.name).toBe(
        row.name.startsWith('positive control')
      )
      const serialized = JSON.stringify([observed, plan])
      for (const word of FORBIDDEN_WORDS) {
        expect(serialized.includes(word), `${row.name} carries ${word}`).toBe(false)
      }
      if (observed.value === 'unknown') {
        expect(WAKE_PROXY_UNKNOWN_REASONS, row.name).toContain(observed.reason)
        expect(observed.reason, row.name).toMatch(REASON_PATTERN)
        expect(plan, row.name).toEqual({ send: false, reason: observed.reason })
      }
    }
  })

  it('names every unknown reason in the wire pattern and covers each one in the table', () => {
    const seen = new Set(
      ROWS.map((row) => composeWakeProxyAvailability(row.inputs)).flatMap((observed) =>
        observed.value === 'unknown' ? [observed.reason] : []
      )
    )
    for (const reason of WAKE_PROXY_UNKNOWN_REASONS) {
      expect(reason).toMatch(REASON_PATTERN)
      expect(seen.has(reason), reason).toBe(true)
    }
  })

  it('invents no wake stage when the broker gave no answer', () => {
    expect(composeWakeProgress(undefined, null)).toEqual([])
  })
})

const CARD_HOST = 'host-card'
const K = `${'Kq0_'.repeat(10)}K-z`
const DESK_ID = 'wt_0123456789ab'
const BOUND_DESK = { targetId: DESK_ID, label: 'desk', hostKey: K }

function routeBroker(
  brokerHostId: string,
  targets: unknown[],
  overrides: Partial<WakeProxyInputs> = {}
): WakeRouteBroker {
  return {
    brokerHostId,
    inputs: current({ targets: { observedAt: T0 + 2, targets }, ...overrides })
  }
}

type RouteRow = {
  name: string
  hostKey: string | null
  brokers: WakeRouteBroker[]
  expected: HostWakeRoute
}

// Why a table: the expected route is written by hand, never derived from the composer.
const ROUTE_ROWS: RouteRow[] = [
  {
    name: 'tracer: the one available broker lists one target bound to the card key',
    hostKey: K,
    brokers: [routeBroker('host-broker', [BOUND_DESK])],
    expected: { send: true, brokerHostId: 'host-broker', targetId: DESK_ID, observedAt: T0 + 1 }
  },
  {
    name: 'tracer: the same target with no hostKey is not a binding',
    hostKey: K,
    brokers: [routeBroker('host-broker', [{ targetId: DESK_ID, label: 'desk' }])],
    expected: { send: false, reason: 'no_bound_target' }
  },
  {
    name: 'D-04: two available brokers both bind the card key',
    hostKey: K,
    brokers: [
      routeBroker('host-broker-1', [BOUND_DESK]),
      routeBroker('host-broker-2', [BOUND_DESK])
    ],
    expected: { send: false, reason: 'ambiguous_broker' }
  }
]

describe('composeHostWakeRoute', () => {
  it.each(ROUTE_ROWS.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(K).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const route = composeHostWakeRoute({
      targetHostId: CARD_HOST,
      hostKey: row.hostKey,
      brokers: row.brokers
    })
    expect(route).toEqual(row.expected)
  })
})
