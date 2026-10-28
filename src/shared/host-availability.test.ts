import { describe, expect, it } from 'vitest'
import {
  HOST_CAPABILITY_IDS,
  HOST_CONNECTIVITY_STATES,
  HOST_EVIDENCE_KINDS,
  composeHostAvailability,
  parseHostAvailabilityAnnouncement,
  type HostAvailabilityObservations,
  type HostProcessKind
} from './host-availability'

const T = 1_760_000_000_000
const VERDICTS = ['normal', 'warning', 'unreachable', 'auth-failed'] as const
const GRAPHS = ['ready', 'reloading', 'unavailable', undefined, 'bogus'] as const
const WINDOWS = ['available', 'openable', 'initializing', 'blocked', undefined, 'bogus'] as const
const PROCESS_KINDS: (HostProcessKind | null)[] = ['serve', 'desktop', null]
const KNOWN_WINDOWS = new Set<string>(['available', 'openable', 'initializing', 'blocked'])
const POWER_LOSS = new Set(['sleeping', 'hibernating', 'powered-off', 'unobservable'])

type Row = {
  verdictKind: (typeof VERDICTS)[number]
  connected: boolean
  hasStatus: boolean
  graphStatus: (typeof GRAPHS)[number]
  desktopWindowStatus: (typeof WINDOWS)[number]
  processKind: HostProcessKind | null
  protocolCompatible: boolean
}

function allRows(): Row[] {
  const rows: Row[] = []
  for (const verdictKind of VERDICTS) {
    for (const connected of [true, false]) {
      for (const hasStatus of [true, false]) {
        for (const graphStatus of GRAPHS) {
          for (const desktopWindowStatus of WINDOWS) {
            for (const processKind of PROCESS_KINDS) {
              for (const protocolCompatible of [true, false]) {
                rows.push({
                  verdictKind,
                  connected,
                  hasStatus,
                  graphStatus,
                  desktopWindowStatus,
                  processKind,
                  protocolCompatible
                })
              }
            }
          }
        }
      }
    }
  }
  return rows
}

function observations(row: Row): HostAvailabilityObservations {
  return {
    transport: { verdictKind: row.verdictKind, connected: row.connected, observedAt: T },
    status: row.hasStatus
      ? {
          observedAt: T + 1,
          protocolCompatible: row.protocolCompatible,
          graphStatus: row.graphStatus,
          desktopWindowStatus: row.desktopWindowStatus,
          processKind: row.processKind
        }
      : null
  }
}

function windowDetail(window: string | undefined): string {
  if (window === undefined) {
    return 'window_status_absent'
  }
  return KNOWN_WINDOWS.has(window) ? window : 'unrecognized_window_status'
}

// Why a table here: the expectation must not come from the composer under test (D-03).
function expectedOrca(row: Row): { value: string; detail?: string; reason?: string } {
  if (!row.connected) {
    return { value: 'unknown', reason: 'not_connected' }
  }
  if (!row.hasStatus) {
    return { value: 'unknown', reason: 'no_live_response' }
  }
  if (!row.protocolCompatible) {
    return { value: 'version-mismatch' }
  }
  if (row.graphStatus === 'unavailable') {
    return { value: 'unavailable' }
  }
  if (row.graphStatus === 'reloading') {
    return { value: 'starting' }
  }
  if (row.graphStatus !== 'ready') {
    return { value: 'unknown', reason: 'graph_status_unrecognized' }
  }
  const window = row.desktopWindowStatus
  if (window === 'available') {
    return { value: 'ui-open' }
  }
  if (row.processKind === 'serve') {
    return { value: 'service-ready', detail: windowDetail(window) }
  }
  if (window === undefined) {
    return { value: 'runtime-ready' }
  }
  if (KNOWN_WINDOWS.has(window)) {
    return { value: 'ui-closed', detail: window }
  }
  return { value: 'runtime-ready', detail: 'unrecognized_window_status' }
}

function assertEvidenced(field: {
  value: string
  evidence: { kind: string; observedAt: number } | null
  reason?: string
}): void {
  if (field.value === 'unknown') {
    expect(field.evidence).toBeNull()
    expect(typeof field.reason).toBe('string')
    expect(field.reason?.length).toBeGreaterThan(0)
    return
  }
  expect(field.evidence).not.toBeNull()
  expect(HOST_EVIDENCE_KINDS).toContain(field.evidence?.kind)
  expect(Number.isFinite(field.evidence?.observedAt)).toBe(true)
}

describe('composeHostAvailability matrix', () => {
  const rows = allRows()

  it(`covers ${rows.length} rows (at least 1000)`, () => {
    expect(rows.length).toBeGreaterThanOrEqual(1000)
  })

  it(`never emits a power-loss value and evidences every value across ${rows.length} rows`, () => {
    for (const row of rows) {
      const result = composeHostAvailability(observations(row))
      expect(POWER_LOSS.has(result.power.value), JSON.stringify(row)).toBe(false)
      expect(['awake', 'unknown']).toContain(result.power.value)
      expect(result.power.value === 'awake', JSON.stringify(row)).toBe(
        row.connected && row.hasStatus
      )
      expect(result.connectivity.value).toBe(row.verdictKind)
      expect(HOST_CONNECTIVITY_STATES).toContain(result.connectivity.value)
      expect(result.connectivity.evidence).toEqual({ kind: 'transport-observed', observedAt: T })
      assertEvidenced(result.power)
      assertEvidenced(result.orca)
      if (result.power.value === 'awake') {
        expect(result.power.evidence).toEqual({ kind: 'live-response', observedAt: T + 1 })
      }
    }
  })

  it(`matches the orca table in all ${rows.length} rows`, () => {
    for (const row of rows) {
      const orca = composeHostAvailability(observations(row)).orca
      const expected = expectedOrca(row)
      expect(orca.value, JSON.stringify(row)).toBe(expected.value)
      if (orca.value === 'unknown') {
        expect(orca.reason, JSON.stringify(row)).toBe(expected.reason)
      } else {
        expect(orca.detail, JSON.stringify(row)).toBe(expected.detail)
        expect(orca.evidence).toEqual({ kind: 'live-response', observedAt: T + 1 })
      }
    }
  })
})

function announcing(hostAvailability: unknown): Record<string, unknown> {
  return { capabilities: ['host.availability.v1'], hostAvailability }
}

function goodEntry(): Record<string, unknown> {
  return {
    value: 'supported',
    reason: 'relay_registered',
    evidence: { kind: 'relay-reported', observedAt: T }
  }
}

function announcementWith(entry: unknown): Record<string, unknown> {
  return announcing({
    schema: 1,
    processKind: 'desktop',
    observedAt: T,
    capabilities: { 'can-relay': entry }
  })
}

describe('parseHostAvailabilityAnnouncement', () => {
  it.each([
    ['missing', undefined],
    ['not an object', 'yes'],
    ['an array', []],
    ['schema 2', { schema: 2, processKind: 'serve', observedAt: T, capabilities: {} }],
    ['schema absent', { processKind: 'serve', observedAt: T, capabilities: {} }]
  ])('reads an announced but %s hostAvailability as announcement_unreadable', (_label, value) => {
    const parsed = parseHostAvailabilityAnnouncement(announcing(value))
    expect(parsed.processKind).toBeNull()
    for (const id of HOST_CAPABILITY_IDS) {
      expect(parsed.capabilities[id]).toEqual({
        value: 'unknown',
        reason: 'announcement_unreadable',
        evidence: null
      })
    }
  })

  it('keeps a well-formed capability and reads a missing id as capability_not_announced', () => {
    const parsed = parseHostAvailabilityAnnouncement(announcementWith(goodEntry()))
    expect(parsed.processKind).toBe('desktop')
    expect(parsed.capabilities['can-relay']).toEqual(goodEntry())
    expect(parsed.capabilities['can-direct']).toEqual({
      value: 'unknown',
      reason: 'capability_not_announced',
      evidence: null
    })
  })

  it.each([
    ['powered-off', 'unrecognized_value'],
    ['SUPPORTED', 'unrecognized_value'],
    [42, 'unrecognized_value'],
    [undefined, 'unrecognized_value']
  ])('reads value %s as unknown %s', (value, reason) => {
    const parsed = parseHostAvailabilityAnnouncement(announcementWith({ ...goodEntry(), value }))
    expect(parsed.capabilities['can-relay']).toEqual({ value: 'unknown', reason, evidence: null })
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a foreign kind', { kind: 'rumour', observedAt: T }],
    ['a non-finite time', { kind: 'relay-reported', observedAt: Number.NaN }],
    ['a string time', { kind: 'relay-reported', observedAt: String(T) }],
    ['an infinite time', { kind: 'relay-reported', observedAt: Number.POSITIVE_INFINITY }]
  ])('reads a supported value with %s evidence as evidence_missing', (_label, evidence) => {
    const parsed = parseHostAvailabilityAnnouncement(announcementWith({ ...goodEntry(), evidence }))
    expect(parsed.capabilities['can-relay']).toEqual({
      value: 'unknown',
      reason: 'evidence_missing',
      evidence: null
    })
  })

  it.each([['Has Spaces'], ['x'.repeat(65)], [''], ['<script>'], [7]])(
    'replaces reason %s with unspecified',
    (reason) => {
      const parsed = parseHostAvailabilityAnnouncement(announcementWith({ ...goodEntry(), reason }))
      expect(parsed.capabilities['can-relay']).toMatchObject({
        value: 'supported',
        reason: 'unspecified'
      })
    }
  )

  it('drops evidence carried on an unknown value and ignores unknown extra ids', () => {
    const status = announcing({
      schema: 1,
      processKind: 'bogus',
      observedAt: T,
      capabilities: {
        'can-relay': {
          value: 'unknown',
          reason: 'relay_status_pending',
          evidence: { kind: 'os-probe', observedAt: T }
        },
        'can-teleport': goodEntry()
      }
    })
    const parsed = parseHostAvailabilityAnnouncement(status)
    expect(parsed.processKind).toBeNull()
    expect(parsed.capabilities['can-relay']).toEqual({
      value: 'unknown',
      reason: 'relay_status_pending',
      evidence: null
    })
    expect(Object.keys(parsed.capabilities).sort()).toEqual([...HOST_CAPABILITY_IDS].sort())
  })

  it('reads a phase 20 announcement as exactly the six phase 18 capability ids (row M)', () => {
    expect(HOST_CAPABILITY_IDS).toEqual([
      'can-start-orca',
      'can-wake-lan',
      'can-wake-remote',
      'can-power-on-oob',
      'can-relay',
      'can-direct'
    ])
    const hostAvailability = {
      schema: 1,
      processKind: 'desktop',
      observedAt: T,
      capabilities: {
        'can-start-orca': goodEntry(),
        'can-wake-lan': goodEntry(),
        'can-wake-remote': {
          value: 'not-configured',
          reason: 'no_wake_broker',
          evidence: { kind: 'host-announced', observedAt: T }
        },
        'can-power-on-oob': {
          value: 'not-supported',
          reason: 'hardware_bound_amd_no_amt',
          evidence: { kind: 'os-probe', observedAt: T }
        },
        'can-relay': goodEntry(),
        'can-direct': goodEntry()
      }
    }
    expect(Object.keys(hostAvailability)).toEqual([
      'schema',
      'processKind',
      'observedAt',
      'capabilities'
    ])
    const parsed = parseHostAvailabilityAnnouncement(announcing(hostAvailability))
    expect(Object.keys(parsed.capabilities)).toEqual([...HOST_CAPABILITY_IDS])
    for (const id of HOST_CAPABILITY_IDS) {
      expect(parsed.capabilities[id].reason, id).not.toBe('unspecified')
    }
    expect(parsed.capabilities['can-power-on-oob']).toMatchObject({
      value: 'not-supported',
      reason: 'hardware_bound_amd_no_amt'
    })
    expect(parsed.capabilities['can-wake-remote']).toMatchObject({
      value: 'not-configured',
      reason: 'no_wake_broker'
    })
  })

  it('lets an old client ignore a capability id added after phase 18 (row M)', () => {
    const parsed = parseHostAvailabilityAnnouncement(
      announcing({
        schema: 1,
        processKind: 'serve',
        observedAt: T,
        capabilities: { 'can-relay': goodEntry(), 'can-wake-proxy': goodEntry() }
      })
    )
    expect(Object.keys(parsed.capabilities)).toEqual([...HOST_CAPABILITY_IDS])
    expect(parsed.capabilities['can-relay']).toEqual(goodEntry())
  })

  it('never throws on hostile input', () => {
    const hostile: unknown[] = [
      null,
      undefined,
      42,
      'status',
      [],
      { capabilities: 'host.availability.v1' },
      { capabilities: ['host.availability.v1'], hostAvailability: { schema: 1, capabilities: [] } },
      {
        capabilities: ['host.availability.v1'],
        hostAvailability: { schema: 1, capabilities: null }
      },
      JSON.parse(
        '{"capabilities":["host.availability.v1"],"hostAvailability":{"schema":1,"capabilities":{"__proto__":{"value":"supported"},"can-relay":[1,2]}}}'
      )
    ]
    for (const input of hostile) {
      const parsed = parseHostAvailabilityAnnouncement(input)
      for (const id of HOST_CAPABILITY_IDS) {
        expect(parsed.capabilities[id].value).toBe('unknown')
        expect(parsed.capabilities[id].evidence).toBeNull()
      }
    }
  })
})
