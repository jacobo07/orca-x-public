import { describe, expect, it } from 'vitest'
import { HOST_ORCA_STATES, HOST_POWER_STATES } from '../../../src/shared/host-availability'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'
import { MIN_COMPATIBLE_DESKTOP_VERSION } from '../transport/protocol-version'
import {
  HOST_CARD_LABELS,
  orcaLabelId,
  powerLabelId,
  presentHostCardAvailability,
  type HostCardAvailabilityProjection
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
