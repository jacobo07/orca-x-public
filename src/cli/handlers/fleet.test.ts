import { describe, expect, it } from 'vitest'
import type { FleetPlacementViewResult } from '../../shared/fleet-placement-view'
import { fleetPlacementExitCode, formatFleetPlacementView } from '../fleet-placement-format'
import { FLEET_HANDLERS, fleetManifestParams, fleetPlacementParams } from './fleet'

const GB = 1024 ** 3
const candidate = (key: string, label: string, availableMemory: number) => ({
  key,
  fingerprint: `fp-${key}`,
  label,
  addresses: [key],
  evidenceAddress: key,
  availableMemory,
  availableMemorySource: 'proc-meminfo',
  sampleAgeMs: 3_000,
  isCurrent: false
})

function okResult(selectedKey: string | null): FleetPlacementViewResult {
  const eligible = [candidate('local', 'this pc', 2 * GB), candidate('runtime:vps', 'vps', 9 * GB)]
  return {
    status: 'ok',
    request: { now: 1, maxSampleAgeMs: 60_000 },
    observation: {
      observedAt: 0,
      completedAt: 1,
      members: [],
      coverage: { runtimeEnvironments: 2, sshTargets: 'not-enumerated' }
    },
    proposal: {
      decision: selectedKey ? 'selected' : 'no-eligible-host',
      selected: eligible.find((entry) => entry.key === selectedKey) ?? null,
      eligible: selectedKey ? eligible : [],
      rejected: [
        {
          key: 'runtime:old',
          fingerprint: null,
          addresses: ['runtime:old'],
          reasons: [{ reason: 'identity-unavailable' }, { reason: 'protocol-blocked' }]
        },
        {
          key: 'runtime:small',
          fingerprint: 'fp-small',
          addresses: ['runtime:small'],
          reasons: [{ reason: 'insufficient-memory', availableMemory: GB, required: 4 * GB }]
        }
      ]
    }
  } as FleetPlacementViewResult
}

describe('orca fleet placement', () => {
  it('maps flags to the method params and omits what was not asked', () => {
    expect(fleetPlacementParams(new Map())).toEqual({})
    expect(
      fleetPlacementParams(
        new Map<string, string | boolean>([
          ['min-available-mb', '4096'],
          ['platform', 'linux'],
          ['capabilities', ' cap.a, ,cap.b '],
          ['max-sample-age-ms', '5000']
        ])
      )
    ).toEqual({
      minAvailableBytes: 4 * GB,
      platform: 'linux',
      requiredCapabilities: ['cap.a', 'cap.b'],
      maxSampleAgeMs: 5000
    })
  })

  it('rejects a non-integer memory floor instead of sending a guess', () => {
    expect(() =>
      fleetPlacementParams(new Map<string, string | boolean>([['min-available-mb', '1.5']]))
    ).toThrow(/min-available-mb/)
  })

  it('exits 0 on a selection, 2 when none is eligible, 1 when it could not ask', () => {
    expect(fleetPlacementExitCode(okResult('runtime:vps'))).toBe(0)
    expect(fleetPlacementExitCode(okResult(null))).toBe(2)
    expect(fleetPlacementExitCode({ status: 'refused', reason: 'remote-caller' })).toBe(1)
    expect(fleetPlacementExitCode({ status: 'unavailable', reason: 'no-fleet-reader' })).toBe(1)
  })

  it('marks the selected host after a JSON round trip, and names every rejection', () => {
    const text = formatFleetPlacementView(JSON.parse(JSON.stringify(okResult('runtime:vps'))))
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^fleet: selected vps — 9(\.0)? GB/)
    expect(lines.find((line) => line.includes('runtime:vps'))).toMatch(/^ {2}\* /)
    expect(lines.find((line) => line.includes(' local'))).toMatch(/^ {3} /)
    expect(text).toContain('runtime:old: no verifiable host key; protocol incompatible')
    expect(text).toMatch(/runtime:small: 1(\.0)? GB available, 4(\.0)? GB required/)
    expect(text).toContain('SSH targets are not enumerated')
    expect(text).toContain('nothing was moved')
  })

  it('keeps refusal and absence apart in words', () => {
    const refused = formatFleetPlacementView({ status: 'refused', reason: 'remote-caller' })
    const unavailable = formatFleetPlacementView({
      status: 'unavailable',
      reason: 'no-fleet-reader'
    })
    expect(refused).toContain('refused')
    expect(unavailable).toContain('no fleet reader')
    expect(refused).not.toBe(unavailable)
  })
})

describe('orca fleet manifest', () => {
  const flagsOf = (entries: [string, string | boolean][]) => new Map(entries)

  it('maps --model-probe-ports to params and sends nothing when absent', () => {
    expect(fleetManifestParams(new Map())).toEqual({})
    expect(fleetManifestParams(flagsOf([['model-probe-ports', '8081, 8082']]))).toEqual({
      modelProbePorts: [8081, 8082]
    })
  })

  it('rejects a non-integer, an out-of-range port and more than four ports before any RPC', () => {
    for (const bad of ['80.5', 'abc', '65536', '0', '1,2,3,4,5', '8081,']) {
      expect(() => fleetManifestParams(flagsOf([['model-probe-ports', bad]]))).toThrow(
        /model-probe-ports/
      )
    }
  })

  async function run(result: unknown, entries: [string, string | boolean][] = []) {
    const calls: { method: string; params: unknown }[] = []
    const client = {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
      }
    }
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => void lines.push(args.join(' '))
    const previousExit = process.exitCode
    try {
      await FLEET_HANDLERS['fleet manifest']({
        client: client as never,
        flags: flagsOf(entries),
        cwd: '.',
        json: entries.some(([name]) => name === 'json')
      })
      const exitCode = process.exitCode
      return { calls, lines, exitCode }
    } finally {
      console.log = original
      process.exitCode = previousExit
    }
  }

  it('calls only fleet.nodeManifests, sets the exit code, and prints the RPC result with --json', async () => {
    const okResult = { status: 'ok', observedAt: 1, manifests: [] }
    const printed = await run(okResult, [
      ['json', true],
      ['model-probe-ports', '8081']
    ])
    expect(printed.calls).toEqual([
      { method: 'fleet.nodeManifests', params: { modelProbePorts: [8081] } }
    ])
    expect(printed.exitCode).toBe(0)
    expect(JSON.parse(printed.lines.join('\n')).result).toEqual(okResult)
    const refused = await run({ status: 'refused', reason: 'remote-caller' })
    expect(refused.exitCode).toBe(1)
    expect(refused.lines.join('\n')).toContain('refused')
    expect(
      printed.calls.concat(refused.calls).some((c) => c.method === 'fleet.placementView')
    ).toBe(false)
  })
})
