import { describe, expect, it } from 'vitest'
import { HOST_ORCA_STATES, HOST_POWER_STATES } from '../../../src/shared/host-availability'
import { HOST_WAKE_REFUSAL_CODES, type HostWakeRefusalCode } from '../../../src/shared/host-wake'
import type { WakeRouteBroker } from '../../../src/shared/host-wake-proxy'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'
import { MIN_COMPATIBLE_DESKTOP_VERSION } from '../transport/protocol-version'
import {
  HOST_CARD_LABELS,
  orcaLabelId,
  powerLabelId,
  presentHostCardAvailability,
  presentHostCardWake,
  type HostCardAvailabilityProjection,
  type HostCardLabelId,
  type HostCardWakeAttempt,
  type HostCardWakeProjection
} from './host-availability-presentation'

const LABEL_TEXTS = new Set<string>(Object.values(HOST_CARD_LABELS))

function announcement(capabilities: Record<string, unknown>, processKind: unknown = 'serve') {
  return {
    capabilities: ['host.availability.v1'],
    hostAvailability: { schema: 1, processKind, observedAt: 100, capabilities }
  }
}

const relaySupported = {
  'can-relay': {
    value: 'supported',
    reason: 'relay_paired',
    evidence: { kind: 'relay-reported', observedAt: 100 }
  }
}

function snapshot(result: Record<string, unknown>, observedAt = 2000): HomeHostStatusSnapshot {
  return {
    observedAt,
    result: { protocolVersion: MIN_COMPATIBLE_DESKTOP_VERSION, graphStatus: 'ready', ...result }
  }
}

function present(overrides: {
  connected?: boolean
  verdictKind?: 'normal' | 'warning' | 'unreachable' | 'auth-failed'
  lastConnectedAt?: number | null
  snapshot?: HomeHostStatusSnapshot
}): HostCardAvailabilityProjection {
  return presentHostCardAvailability({
    connected: overrides.connected ?? true,
    verdictKind: overrides.verdictKind ?? 'normal',
    lastConnectedAt: overrides.lastConnectedAt === undefined ? 1000 : overrides.lastConnectedAt,
    snapshot: overrides.snapshot,
    nowMs: 3000
  })
}

// Every visible string must be a label or a join of labels; nothing from the host answer.
function expectOnlyLabels(projection: HostCardAvailabilityProjection): void {
  for (const part of projection.availabilityText.split(' · ')) {
    expect(LABEL_TEXTS.has(part)).toBe(true)
  }
  for (const part of projection.capabilityText.split(' · ')) {
    const pair = part.split(': ')
    expect(pair.length === 1 || pair.length === 2).toBe(true)
    for (const piece of pair) {
      expect(LABEL_TEXTS.has(piece)).toBe(true)
    }
  }
  const spoken = `${projection.availabilityText}, ${projection.capabilityText}`.split(' · ')
  expect(projection.accessibilityText).toBe(spoken.join(', '))
  for (const id of projection.labelIds) {
    expect(Object.hasOwn(HOST_CARD_LABELS, id)).toBe(true)
  }
}

describe('presentHostCardAvailability', () => {
  it('states unknown as unknown with no answer and no connection', () => {
    const projection = present({ connected: false, verdictKind: 'warning', lastConnectedAt: null })

    expect(projection.availabilityText).toBe('Power unknown · Orca unknown')
    expect(projection.capabilityText).toBe('Capabilities unknown')
    expect(projection.tone).toBe('muted')
    expect(projection.labelIds).toEqual(['power.unknown', 'orca.unknown', 'capabilities.unknown'])
    expectOnlyLabels(projection)
  })

  it('does not call the host awake on an answer older than the latest connect', () => {
    const projection = present({
      lastConnectedAt: 5000,
      snapshot: snapshot(announcement(relaySupported), 4000)
    })

    expect(projection.availabilityText).toBe('Power unknown · Orca unknown')
    expect(projection.tone).toBe('muted')
    expect(projection.capabilityText).toContain('Relay: yes')
    expectOnlyLabels(projection)
  })

  it.each([
    ['service-ready', { ...announcement({}) }, 'Host Service running', 'normal'],
    ['runtime-ready', {}, 'Orca runtime ready', 'normal'],
    ['ui-open', { desktopWindowStatus: 'available' }, 'Orca open', 'normal'],
    ['ui-closed', { desktopWindowStatus: 'openable' }, 'Orca running, window closed', 'normal'],
    ['starting', { graphStatus: 'reloading' }, 'Orca starting', 'normal'],
    ['version-mismatch', { protocolVersion: 0 }, 'Orca version mismatch', 'warning'],
    ['unavailable', { graphStatus: 'unavailable' }, 'Orca unavailable', 'warning']
  ] as const)('maps a current %s answer to its label', (_state, result, orcaText, tone) => {
    const projection = present({ snapshot: snapshot(result) })

    expect(projection.availabilityText).toBe(`Awake · ${orcaText}`)
    expect(projection.tone).toBe(tone)
    expectOnlyLabels(projection)
  })

  it('reads an old host as running with unknown capabilities (D-05)', () => {
    const projection = present({ snapshot: snapshot({ desktopWindowStatus: 'openable' }) })

    expect(projection.availabilityText).toBe('Awake · Orca running, window closed')
    expect(projection.capabilityText).toBe('Capabilities unknown')
    expectOnlyLabels(projection)
  })

  it('keeps announced capabilities but not power once the host is unreachable', () => {
    const projection = present({
      connected: false,
      verdictKind: 'unreachable',
      snapshot: snapshot(announcement(relaySupported))
    })

    expect(projection.availabilityText).toBe('Power unknown · Orca unknown')
    expect(projection.capabilityText).toBe(
      'Logon start: unknown · LAN wake: unknown · Remote wake: unknown · Power-on: unknown · Relay: yes · Direct: unknown'
    )
    expectOnlyLabels(projection)
  })

  it('treats an unreadable answer as no answer', () => {
    const projection = present({ snapshot: { observedAt: 2000, result: 'not a record' } })

    expect(projection.availabilityText).toBe('Power unknown · Orca unknown')
    expect(projection.capabilityText).toBe('Capabilities unknown')
  })

  it('never surfaces a host-provided string', () => {
    const hostile = 'x'.repeat(500)
    const projection = present({
      snapshot: snapshot({
        graphStatus: '<b>pwned</b>',
        desktopWindowStatus: '<script>alert(1)</script>',
        ...announcement(
          {
            'can-relay': {
              value: 'supported',
              reason: '<img src=x onerror=alert(1)>',
              evidence: { kind: 'relay-reported', observedAt: 1 },
              label: hostile
            },
            'can-direct': { value: '<i>yes</i>', reason: hostile },
            'can-wake-lan': hostile
          },
          '<desktop>'
        )
      })
    })

    expect(projection.availabilityText).toBe('Awake · Orca unknown')
    const everything = JSON.stringify(projection)
    for (const fragment of ['<', 'pwned', 'script', 'onerror', 'xxxx']) {
      expect(everything).not.toContain(fragment)
    }
    expectOnlyLabels(projection)
  })
})

describe('host card label lookup', () => {
  it('declares no power label beyond the two a producer can prove', () => {
    expect(Object.keys(HOST_CARD_LABELS).filter((key) => key.startsWith('power.'))).toEqual([
      'power.awake',
      'power.unknown'
    ])
  })

  it.each(HOST_POWER_STATES)('renders power %s as a label, unknown when it has none', (value) => {
    const id = powerLabelId(value)
    expect(LABEL_TEXTS.has(HOST_CARD_LABELS[id])).toBe(true)
    expect(HOST_CARD_LABELS[id]).toBe(value === 'awake' ? 'Awake' : 'Power unknown')
  })

  it.each(HOST_ORCA_STATES)('renders orca %s through its own family', (value) => {
    const id = orcaLabelId(value)
    expect(id).toBe(`orca.${value}`)
    expect(LABEL_TEXTS.has(HOST_CARD_LABELS[id])).toBe(true)
  })
})

const HOST_KEY = 'Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0'
const PRESSED_AT = 5000
const REPLIED_AT = 5200
const HOUR = 3_600_000
const WOKEN_WORDING = /\b(?:woken|awake|on|up|ready|running|online|booted)\b/i
const TARGET_STAGE_LABELS: readonly HostCardLabelId[] = [
  'wake.host-announced',
  'wake.runtime-ready'
]

function routeBroker(brokerHostId: string): WakeRouteBroker {
  return {
    brokerHostId,
    inputs: {
      broker: { connected: true, lastConnectedAt: 1000 },
      status: { observedAt: 1001, result: { capabilities: ['host.wake-broker.v1'] } },
      targets: {
        observedAt: 1002,
        targets: [{ targetId: 'wt_0123456789ab', label: 'Studio', hostKey: HOST_KEY }]
      }
    }
  }
}

function brokerStages(stages: readonly string[], offset = 0): unknown[] {
  return stages.map((stage, index) => ({
    stage,
    observedAt: PRESSED_AT + 50 + index + offset,
    observer: 'broker'
  }))
}

const SENT = ['requested', 'authorized', 'packet-sent'] as const

function attempt(overrides: Partial<HostCardWakeAttempt> = {}): HostCardWakeAttempt {
  return {
    brokerHostId: 'host-broker',
    targetId: 'wt_0123456789ab',
    requestId: 'req-00000001',
    pressedAt: PRESSED_AT,
    repliedAt: REPLIED_AT,
    wakeId: 'wake-1',
    brokerStages: brokerStages(SENT),
    refusalCode: null,
    ...overrides
  }
}

function targetAnswer(graphStatus: string, observedAt = 6100): HomeHostStatusSnapshot {
  return { observedAt, result: { protocolVersion: MIN_COMPATIBLE_DESKTOP_VERSION, graphStatus } }
}

function presentWake(input: {
  attempt?: HostCardWakeAttempt | null
  brokers?: WakeRouteBroker[]
  powerAwake?: boolean
  snapshot?: HomeHostStatusSnapshot
  lastConnectedAt?: number | null
}): HostCardWakeProjection {
  return presentHostCardWake({
    targetHostId: 'host-1',
    wake: {
      hostKey: HOST_KEY,
      brokers: input.brokers ?? [routeBroker('host-broker')],
      attempt: input.attempt === undefined ? null : input.attempt
    },
    powerAwake: input.powerAwake ?? false,
    targetSnapshot: input.snapshot,
    targetLastConnectedAt: input.lastConnectedAt === undefined ? 6000 : input.lastConnectedAt
  })
}

describe('presentHostCardWake', () => {
  it('route: a bound route offers the control; no wake inputs, awake power or no binding do not', () => {
    expect(presentWake({}).showControl).toBe(true)
    expect(presentWake({ powerAwake: true }).showControl).toBe(false)
    expect(presentWake({ brokers: [] }).showControl).toBe(false)
    const none = presentHostCardWake({
      targetHostId: 'host-1',
      wake: undefined,
      powerAwake: false,
      targetSnapshot: undefined,
      targetLastConnectedAt: null
    })
    expect(none).toEqual({
      showControl: false,
      busy: false,
      stageLabelId: null,
      stageText: null,
      tone: 'muted'
    })
  })

  it('broker stages: requested, authorized and packet-sent show the packet sent, muted', () => {
    const projection = presentWake({ attempt: attempt() })

    expect(projection.stageLabelId).toBe('wake.packet-sent')
    expect(projection.stageText).toBe('Wake packet sent')
    expect(projection.tone).toBe('muted')
    expect(projection.busy).toBe(false)
  })

  it('broker stages: a failed send shows packet-send-failed with tone warning', () => {
    const projection = presentWake({
      attempt: attempt({
        brokerStages: brokerStages(['requested', 'authorized', 'packet-send-failed'])
      })
    })

    expect(projection.stageLabelId).toBe('wake.packet-send-failed')
    expect(projection.tone).toBe('warning')
  })

  it('broker stages: evidence order, not the order the broker listed them in', () => {
    const projection = presentWake({
      attempt: attempt({ brokerStages: brokerStages(['packet-sent', 'authorized', 'requested']) })
    })

    expect(projection.stageLabelId).toBe('wake.packet-sent')
  })

  it.each([
    ['not a list', 'stages'],
    ['an empty list', []],
    ['an unknown stage', [{ stage: 'woken', observedAt: 5300, observer: 'broker' }]],
    ['a record without a time', [{ stage: 'packet-sent', observer: 'broker' }]],
    ['a broker writing target stages', brokerStages(['host-announced', 'runtime-ready'])]
  ] as const)('broker stages: %s shows wake.unknown', (_name, stages) => {
    const projection = presentWake({ attempt: attempt({ brokerStages: stages }) })

    expect(projection.stageLabelId).toBe('wake.unknown')
    expect(projection.stageText).toBe('Wake status unknown')
    expect(projection.tone).toBe('muted')
  })

  it('target evidence: an answer after the reply on a connection after the press shows host-announced', () => {
    const projection = presentWake({ attempt: attempt(), snapshot: targetAnswer('reloading') })

    expect(projection.stageLabelId).toBe('wake.host-announced')
    expect(projection.stageText).toBe('Host answered after wake')
    expect(projection.tone).toBe('normal')
  })

  it('target evidence: a ready graph in that answer shows runtime-ready', () => {
    const projection = presentWake({ attempt: attempt(), snapshot: targetAnswer('ready') })

    expect(projection.stageLabelId).toBe('wake.runtime-ready')
    expect(projection.tone).toBe('normal')
  })

  it.each([
    ['observed before the reply', targetAnswer('ready', REPLIED_AT - 1), PRESSED_AT + 100],
    ['observed at the reply', targetAnswer('ready', REPLIED_AT), PRESSED_AT + 100],
    ['on a connection made before the press', targetAnswer('ready'), PRESSED_AT - 1],
    ['on a connection made at the press', targetAnswer('ready'), PRESSED_AT],
    ['with no connection time', targetAnswer('ready'), null],
    ['from before the latest connect', targetAnswer('ready', 6100), 6200],
    ['unreadable', { observedAt: 6100, result: 'ready' }, 6000]
  ] as const)(
    'before the press: an answer %s never shows host-announced',
    (_name, snapshot, at) => {
      const projection = presentWake({ attempt: attempt(), snapshot, lastConnectedAt: at })

      expect(projection.stageLabelId).toBe('wake.packet-sent')
    }
  )

  it.each([
    ['one hour ahead', HOUR],
    ['one hour behind', -HOUR]
  ])('clock skew: broker records %s give the unskewed result', (_name, offset) => {
    for (const snapshot of [undefined, targetAnswer('reloading'), targetAnswer('ready')]) {
      const unskewed = presentWake({ attempt: attempt(), snapshot })
      const skewed = presentWake({
        attempt: attempt({ brokerStages: brokerStages(SENT, offset) }),
        snapshot
      })
      expect(skewed).toEqual(unskewed)
    }
    expect(
      presentWake({
        attempt: attempt({ brokerStages: brokerStages(SENT, HOUR) }),
        snapshot: targetAnswer('ready')
      }).stageLabelId
    ).toBe('wake.runtime-ready')
  })

  const PHONE_REFUSALS = HOST_WAKE_REFUSAL_CODES.filter(
    (code): code is Exclude<HostWakeRefusalCode, 'host_key_unavailable'> =>
      code !== 'host_key_unavailable'
  )

  it('refusals: eleven phone refusal codes, each with its own label', () => {
    expect(PHONE_REFUSALS).toHaveLength(11)
  })

  it.each(PHONE_REFUSALS)('refusals: %s shows its own label with tone warning', (code) => {
    const projection = presentWake({ attempt: attempt({ refusalCode: code, brokerStages: [] }) })

    expect(projection.stageLabelId).toBe(`wake.${code}`)
    expect(projection.stageText).toBe(HOST_CARD_LABELS[`wake.${code}`])
    expect(projection.tone).toBe('warning')
  })

  it.each(['wake_new_reason', 'host_key_unavailable', '', 'wake.unknown', 'toString'])(
    'refusals: unlisted code %j shows wake.unknown',
    (code) => {
      const projection = presentWake({ attempt: attempt({ refusalCode: code, brokerStages: [] }) })

      expect(projection.stageLabelId).toBe('wake.unknown')
      expect(projection.tone).toBe('muted')
    }
  )

  it('refusals: a refusal wins over stages the same answer carried', () => {
    const projection = presentWake({
      attempt: attempt({ refusalCode: 'wake_grant_missing' }),
      snapshot: targetAnswer('ready')
    })

    expect(projection.stageLabelId).toBe('wake.wake_grant_missing')
  })

  it('in flight: no reply yet is busy with the control still routed and no stage', () => {
    const projection = presentWake({
      attempt: attempt({ repliedAt: null, wakeId: null, brokerStages: null }),
      snapshot: targetAnswer('ready')
    })

    expect(projection).toEqual({
      showControl: true,
      busy: true,
      stageLabelId: null,
      stageText: null,
      tone: 'muted'
    })
  })

  it('ambiguity: two bound brokers and no attempt read ambiguous with no control', () => {
    const projection = presentWake({
      brokers: [routeBroker('host-broker'), routeBroker('host-broker-2')]
    })

    expect(projection.showControl).toBe(false)
    expect(projection.stageLabelId).toBe('wake.ambiguous-broker')
    expect(projection.stageText).toBe('Wake unavailable: ambiguous broker')
    expect(projection.tone).toBe('warning')
  })

  it('ambiguity: an unbound or bound route with no attempt shows no stage', () => {
    expect(presentWake({ brokers: [] }).stageText).toBeNull()
    expect(presentWake({}).stageText).toBeNull()
  })

  it('text law: no broker- or phone-observed wake label reads as a woken host', () => {
    const observed = Object.entries(HOST_CARD_LABELS).filter(
      ([key]) => key.startsWith('wake.') && !TARGET_STAGE_LABELS.includes(key as HostCardLabelId)
    )
    expect(observed).toHaveLength(17)
    for (const [, text] of observed) {
      expect(text).not.toMatch(WOKEN_WORDING)
    }
  })

  it('table: 41 labels, exactly 19 of them wake.*', () => {
    const keys = Object.keys(HOST_CARD_LABELS)
    expect(keys).toHaveLength(41)
    expect(keys.filter((key) => key.startsWith('wake.'))).toHaveLength(19)
  })
})
