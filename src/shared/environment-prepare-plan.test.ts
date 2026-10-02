import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildPreparePlan,
  escapeHiddenCharacters,
  prepareApprovalHash,
  prepareApprovalPreimage
} from './environment-prepare-plan'
import type {
  EnvironmentRequirement,
  HostMeasurement,
  RequirementProbeResult
} from './environment-requirement-types'

const HOST = 'ssh:t1@0123456789abcdef'
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex')

function measured(probes: RequirementProbeResult[]): HostMeasurement {
  return {
    status: 'measured',
    at: 42,
    hostKey: HOST,
    platform: { os: 'linux', arch: 'x64' },
    probes
  }
}

function plan(
  requirements: EnvironmentRequirement[],
  measurement: HostMeasurement,
  approvals: Record<string, string> = {}
) {
  return buildPreparePlan(
    { contractSource: null, hostKey: HOST, requirements, measurement, approvals },
    { sha256Hex }
  )
}

const shim = (prepare?: string): EnvironmentRequirement =>
  ({
    id: 'shim',
    kind: 'command',
    name: 'shim',
    versionArg: '--version',
    ...(prepare === undefined ? {} : { prepare })
  }) as never

describe('buildPreparePlan', () => {
  it('no step without prepare', async () => {
    const result = await plan([shim()], measured([{ id: 'shim', outcome: 'absent' }]))
    expect(result.steps).toEqual([])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].verdict.state).toBe('missing')
  })

  it('an unapproved step is listed but not runnable and its row needs authorization', async () => {
    const result = await plan([shim('mkdir x')], measured([{ id: 'shim', outcome: 'absent' }]))
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({
      requirementId: 'shim',
      bytes: 'mkdir x',
      runnable: false
    })
    expect(result.rows[0].verdict.state).toBe('needs-authorization')
  })

  it('an approved step is runnable and its row stays missing', async () => {
    const hash = await prepareApprovalHash('shim', HOST, 'mkdir x', sha256Hex)
    const result = await plan([shim('mkdir x')], measured([{ id: 'shim', outcome: 'absent' }]), {
      shim: hash
    })
    expect(result.steps[0].runnable).toBe(true)
    expect(result.steps[0].approvalHash).toBe(hash)
    expect(result.rows[0].verdict.state).toBe('missing')
  })

  it('an approval for other bytes does not make a step runnable', async () => {
    const stale = await prepareApprovalHash('shim', HOST, 'mkdir y', sha256Hex)
    const result = await plan([shim('mkdir x')], measured([{ id: 'shim', outcome: 'absent' }]), {
      shim: stale
    })
    expect(result.steps[0].runnable).toBe(false)
  })

  it('a satisfied row never has a runnable step', async () => {
    const hash = await prepareApprovalHash('shim', HOST, 'mkdir x', sha256Hex)
    const result = await plan([shim('mkdir x')], measured([{ id: 'shim', outcome: 'found' }]), {
      shim: hash
    })
    expect(result.steps[0].runnable).toBe(false)
  })

  it('an unreachable host with an approved prepare offers no runnable step', async () => {
    const hash = await prepareApprovalHash('shim', HOST, 'mkdir x', sha256Hex)
    const result = await plan(
      [shim('mkdir x')],
      { status: 'unreachable', at: 1, hostKey: HOST, detail: 'x' },
      { shim: hash }
    )
    expect(result.rows[0].verdict.state).toBe('unknown')
    expect(result.steps[0].runnable).toBe(false)
  })

  it('labels elevation and relative script commands', async () => {
    const reqs = [
      { ...shim('sudo apt-get install x'), id: 'a' },
      { ...shim('"C:\\Windows\\runas.exe" /user:x y'), id: 'b' },
      { ...shim('./scripts/bootstrap.sh --fast'), id: 'c' },
      { ...shim('/usr/bin/true'), id: 'd' },
      { ...shim('echo hi'), id: 'e' }
    ] as EnvironmentRequirement[]
    const result = await plan(reqs, measured(reqs.map((r) => ({ id: r.id, outcome: 'absent' }))))
    const labels = Object.fromEntries(result.steps.map((s) => [s.requirementId, s.labels]))
    expect(labels.a).toContain('asks-for-elevation')
    expect(labels.b).toContain('asks-for-elevation')
    expect(labels.c).toEqual(['script-content-not-covered'])
    expect(labels.d).toEqual([])
    expect(labels.e).toEqual([])
  })

  // Trojan Source: a right-to-left override, an isolate and a zero-width space inside the command.
  const TROJAN = 'pnpm install \u202E# && echo ok\u2066 \u200Bz'
  // sha256 of `prepare:shim\n<HOST>\n<TROJAN>`, computed outside the code under test.
  const TROJAN_SHA256 = '93786262a9a35bc0cd12ca755cccd5b7299440c505c495a8f4c7385bf8f7b438'

  it('labels hidden characters and leaves the hashed and run bytes untouched', async () => {
    const result = await plan([shim(TROJAN)], measured([{ id: 'shim', outcome: 'absent' }]))
    expect(result.steps[0].labels).toContain('hidden-characters')
    expect(result.steps[0].bytes).toBe(TROJAN)
    expect(result.steps[0].approvalHash).toBe(TROJAN_SHA256)
  })

  it('labels hidden characters even when the command token is empty or elevated', async () => {
    const reqs = [
      { ...shim('\uFEFF'), id: 'a' },
      { ...shim('s\u200Budo apt-get install x'), id: 'b' },
      { ...shim('echo plain'), id: 'c' },
      { ...shim('printf a\tb\nc'), id: 'd' }
    ] as EnvironmentRequirement[]
    const result = await plan(reqs, measured(reqs.map((r) => ({ id: r.id, outcome: 'absent' }))))
    const labels = Object.fromEntries(result.steps.map((s) => [s.requirementId, s.labels]))
    expect(labels.a).toContain('hidden-characters')
    expect(labels.b).toContain('hidden-characters')
    expect(labels.c).not.toContain('hidden-characters')
    expect(labels.d).not.toContain('hidden-characters')
  })

  it('copies only declared fields', async () => {
    const dirty = measured([
      { id: 'shim', outcome: 'absent', extra: 'zz-sentinel-zz' } as RequirementProbeResult
    ]) as HostMeasurement & { leak?: string }
    dirty.leak = 'zz-sentinel-zz'
    const result = await plan([shim('mkdir x')], dirty)
    expect(JSON.stringify(result)).not.toContain('zz-sentinel-zz')
  })

  it('names an unreadable contract as unknown without rows', async () => {
    const result = await buildPreparePlan(
      {
        contractSource: null,
        hostKey: HOST,
        requirements: [],
        measurement: measured([]),
        approvals: {},
        contract: 'unreadable'
      },
      { sha256Hex }
    )
    expect(result.contractVerdict).toMatchObject({
      state: 'unknown',
      reason: 'contract-unreadable'
    })
    expect(result.steps).toEqual([])
  })

  // 20-04 L6: a killed ssh carrier fails the contract read; the plan must say the host was unreachable.
  it('attributes an unreadable contract on an unreachable host to the host', async () => {
    const result = await buildPreparePlan(
      {
        contractSource: null,
        hostKey: HOST,
        requirements: [],
        measurement: { status: 'unreachable', at: 1, hostKey: HOST, detail: 'x' },
        approvals: {},
        contract: 'unreadable'
      },
      { sha256Hex }
    )
    expect(result.contractVerdict).toMatchObject({ state: 'unknown', reason: 'unreachable' })
    expect(result.steps).toEqual([])
  })
})

describe('prepareApprovalHash', () => {
  it('binds the host key', async () => {
    const here = await prepareApprovalHash('shim', HOST, 'mkdir x', sha256Hex)
    const there = await prepareApprovalHash('shim', 'local@0123456789abcdef', 'mkdir x', sha256Hex)
    expect(here).not.toBe(there)
  })

  it('binds the requirement id', async () => {
    const a = await prepareApprovalHash('a', HOST, 'mkdir x', sha256Hex)
    const b = await prepareApprovalHash('b', HOST, 'mkdir x', sha256Hex)
    expect(a).not.toBe(b)
  })

  it('preimage is prepare:id LF hostKey LF bytes with no trimming', () => {
    const preimage = new TextDecoder().decode(prepareApprovalPreimage('shim', HOST, ' x \n'))
    expect(preimage).toBe(`prepare:shim\n${HOST}\n x \n`)
  })
})

describe('escapeHiddenCharacters', () => {
  it.each([
    ['\u202E', '<U+202E>'],
    ['\u2066', '<U+2066>'],
    ['\u2069', '<U+2069>'],
    ['\u200B', '<U+200B>'],
    ['\u200D', '<U+200D>'],
    ['\u2060', '<U+2060>'],
    ['\uFEFF', '<U+FEFF>'],
    ['\u0000', '<U+0000>'],
    ['\u001B', '<U+001B>'],
    ['\r', '<U+000D>'],
    ['\u007F', '<U+007F>'],
    ['\u0085', '<U+0085>']
  ])('writes hidden code point #%# as a visible escape', (hidden, shown) => {
    expect(escapeHiddenCharacters(`a${hidden}b`)).toBe(`a${shown}b`)
  })

  it('leaves newline, tab, ordinary text and astral characters alone', () => {
    const text = 'printf "caf\u00E9"\n\tgit status \u{1F600}'
    expect(escapeHiddenCharacters(text)).toBe(text)
  })
})
