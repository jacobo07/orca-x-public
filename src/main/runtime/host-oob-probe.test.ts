import { win32 as pathWin32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OOB_STATUS_MAX_AGE_MS,
  createHostOobProbe,
  defaultHostOobProbeDeps,
  type HostOobExecResult
} from './host-oob-probe'

const T = 1_760_000_000_000
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const SYSCTL = '/usr/sbin/sysctl'
const INTEL_CPUINFO = 'processor\t: 0\nvendor_id\t: GenuineIntel\n'

type Call = { file: string; args: readonly string[] }

function harness(
  platform: NodeJS.Platform,
  replies: Record<string, HostOobExecResult>,
  fsView: { files?: Record<string, string>; nodes?: string[] } = {}
) {
  const calls: Call[] = []
  const reads: string[] = []
  const probes: string[] = []
  let clock = T
  const probe = createHostOobProbe({
    platform,
    now: () => clock,
    exec: (file, args) => {
      calls.push({ file, args })
      return Promise.resolve(replies[file] ?? { code: -1, stdout: '' })
    },
    readText: (path) => {
      reads.push(path)
      return Promise.resolve(fsView.files?.[path] ?? null)
    },
    exists: (path) => {
      probes.push(path)
      return Promise.resolve(fsView.nodes?.includes(path) ?? false)
    },
    windowsPowerShellPath: POWERSHELL
  })
  return {
    probe,
    calls,
    reads,
    probes,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

const AMD_REPLY = { [POWERSHELL]: { code: 0, stdout: 'vendor=AuthenticAMD\r\nmei=0\r\n' } }

describe('host OOB probe bounds', () => {
  it('runs one refresh for ten reads inside the max age', async () => {
    const h = harness('win32', AMD_REPLY)
    h.probe.read()
    await h.probe.settled()
    for (let i = 0; i < 10; i++) {
      h.advance(OOB_STATUS_MAX_AGE_MS / 20)
      h.probe.read()
    }
    await h.probe.settled()
    expect(h.calls).toHaveLength(1)
  })

  it('starts one more refresh after the max age and answers the cached value meanwhile', async () => {
    const h = harness('win32', AMD_REPLY)
    h.probe.read()
    await h.probe.settled()
    const cached = h.probe.read()
    expect(cached.value).toBe('not-supported')
    h.advance(OOB_STATUS_MAX_AGE_MS)
    expect(h.probe.read()).toEqual(cached)
    expect(h.calls).toHaveLength(2)
    await h.probe.settled()
  })

  it('starts no refresh while one is in flight', async () => {
    const h = harness('win32', AMD_REPLY)
    for (let i = 0; i < 5; i++) {
      h.probe.read()
    }
    expect(h.calls).toHaveLength(1)
    await h.probe.settled()
  })

  it.each([
    ['a spawn failure', { code: -1, stdout: '' }],
    ['a non-zero exit', { code: 1, stdout: 'vendor=AuthenticAMD\nmei=0\n' }],
    ['an unparseable answer', { code: 0, stdout: 'garbage' }]
  ])('reads %s on win32 as oob_probe_unreadable', async (_name, reply) => {
    const h = harness('win32', { [POWERSHELL]: reply })
    h.probe.read()
    await h.probe.settled()
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'oob_probe_unreadable',
      evidence: null
    })
  })
})

describe('host OOB probe on linux, darwin and unlisted platforms', () => {
  it('reads /proc/cpuinfo and the MEI node without spawning', async () => {
    const h = harness(
      'linux',
      {},
      { files: { '/proc/cpuinfo': INTEL_CPUINFO }, nodes: ['/dev/mei'] }
    )
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([])
    expect(h.reads).toEqual(['/proc/cpuinfo'])
    expect(h.probes).toEqual(['/dev/mei0', '/dev/mei'])
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'intel_amt_unverified',
      evidence: null
    })
  })

  it('reads an Intel linux host with no MEI node as intel_mei_not_detected', async () => {
    const h = harness('linux', {}, { files: { '/proc/cpuinfo': INTEL_CPUINFO } })
    h.probe.read()
    await h.probe.settled()
    expect(h.probe.read().reason).toBe('intel_mei_not_detected')
  })

  it('reads an unreadable cpuinfo as oob_probe_unreadable', async () => {
    const h = harness('linux', {})
    h.probe.read()
    await h.probe.settled()
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'oob_probe_unreadable',
      evidence: null
    })
  })

  it('runs the absolute sysctl path on darwin', async () => {
    const h = harness('darwin', { [SYSCTL]: { code: 0, stdout: 'GenuineIntel\n' } })
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([{ file: SYSCTL, args: ['-n', 'machdep.cpu.vendor'] }])
    expect(h.probe.read().reason).toBe('intel_mei_not_detected')
  })

  it('reads a failed sysctl (Apple silicon has no key) as oob_probe_unreadable', async () => {
    const h = harness('darwin', { [SYSCTL]: { code: 1, stdout: '' } })
    h.probe.read()
    await h.probe.settled()
    expect(h.probe.read().reason).toBe('oob_probe_unreadable')
  })

  it('answers an unlisted platform with unknown and spawns or reads nothing', async () => {
    const h = harness('freebsd', AMD_REPLY)
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([])
    expect(h.reads).toEqual([])
    expect(h.probes).toEqual([])
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'oob_not_observable_on_platform',
      evidence: null
    })
  })
})

describe('default OOB probe deps', () => {
  it('spawns PowerShell from an absolute System32 path, never through PATH', () => {
    const { windowsPowerShellPath } = defaultHostOobProbeDeps()
    expect(pathWin32.isAbsolute(windowsPowerShellPath)).toBe(true)
    expect(
      windowsPowerShellPath.endsWith('System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    ).toBe(true)
  })

  it('reads a missing file as null and a missing node as absent', async () => {
    const deps = defaultHostOobProbeDeps()
    await expect(deps.readText('/nonexistent/orca-oob-probe/cpuinfo')).resolves.toBeNull()
    await expect(deps.exists('/nonexistent/orca-oob-probe/mei0')).resolves.toBe(false)
  })
})
