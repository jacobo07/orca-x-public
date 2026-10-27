import { describe, expect, it } from 'vitest'
import { WINDOWS_WOL_ADAPTER_SCRIPT } from './host-wol-verdict'
import {
  WOL_STATUS_MAX_AGE_MS,
  createHostWolProbe,
  defaultHostWolProbeDeps,
  type HostWolExecResult
} from './host-wol-probe'

const T = 1_760_000_000_000
const ADAPTERS_JSON =
  '[{"Name":"Ethernet","InterfaceDescription":"Realtek PCIe GbE Family Controller","MediaType":"802.3","WakeOnMagicPacket":"Enabled"}]'
const ARMED_WITHOUT_NIC = 'HID Keyboard Device\r\nHID-compliant mouse\r\n'
const SYSFS_ENP3S0 = '/sys/class/net/enp3s0/device/power/wakeup'

type Call = { file: string; args: readonly string[] }
type Replies = Record<string, HostWolExecResult>

function ok(stdout: string): HostWolExecResult {
  return { code: 0, stdout, stderr: '' }
}

function harness(
  platform: NodeJS.Platform,
  replies: Replies,
  linux: { interfaces?: string[]; files?: Record<string, string> } = {}
) {
  const calls: Call[] = []
  const reads: string[] = []
  let clock = T
  const probe = createHostWolProbe({
    platform,
    now: () => clock,
    exec: (file, args) => {
      calls.push({ file, args })
      return Promise.resolve(replies[file] ?? { code: -1, stdout: '', stderr: 'ENOENT' })
    },
    listPhysicalInterfaces: () => Promise.resolve(linux.interfaces ?? []),
    readText: (path) => {
      reads.push(path)
      return Promise.resolve(linux.files?.[path] ?? null)
    }
  })
  return {
    probe,
    calls,
    reads,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock
  }
}

const WIN_REPLIES: Replies = {
  'powershell.exe': ok(ADAPTERS_JSON),
  'powercfg.exe': ok(ARMED_WITHOUT_NIC)
}

function adapterReads(calls: Call[]): number {
  return calls.filter((call) => call.file === 'powershell.exe').length
}

describe('host WOL probe bounds (D-03)', () => {
  it('runs one refresh for ten reads inside the max age', async () => {
    const h = harness('win32', WIN_REPLIES)
    h.probe.read()
    await h.probe.settled()
    for (let i = 0; i < 10; i++) {
      h.advance(WOL_STATUS_MAX_AGE_MS / 20)
      h.probe.read()
    }
    await h.probe.settled()
    expect(adapterReads(h.calls)).toBe(1)
  })

  it('starts one more refresh after the max age and answers the cached value meanwhile', async () => {
    const h = harness('win32', WIN_REPLIES)
    h.probe.read()
    await h.probe.settled()
    const cached = h.probe.read()
    h.advance(WOL_STATUS_MAX_AGE_MS)
    expect(h.probe.read()).toEqual(cached)
    expect(adapterReads(h.calls)).toBe(2)
    await h.probe.settled()
  })

  it('starts no refresh while one is in flight', async () => {
    const h = harness('win32', WIN_REPLIES)
    for (let i = 0; i < 5; i++) {
      h.probe.read()
    }
    expect(adapterReads(h.calls)).toBe(1)
    await h.probe.settled()
  })
})

describe('host WOL probe on linux and darwin', () => {
  it('runs ethtool with the interface as argv and falls back to sysfs on ENOENT', async () => {
    const h = harness(
      'linux',
      {},
      {
        interfaces: ['enp3s0'],
        files: { [SYSFS_ENP3S0]: 'disabled\n' }
      }
    )
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([{ file: 'ethtool', args: ['enp3s0'] }])
    expect(h.reads).toEqual([SYSFS_ENP3S0])
    expect(h.probe.read()).toMatchObject({ value: 'needs-owner-setup', reason: 'os_not_armed' })
  })

  it('maps an armed ethtool answer to firmware_unverified', async () => {
    const h = harness(
      'linux',
      { ethtool: ok('Settings for enp3s0:\n\tSupports Wake-on: pumbg\n\tWake-on: g\n') },
      { interfaces: ['enp3s0'] }
    )
    h.probe.read()
    await h.probe.settled()
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'firmware_unverified',
      evidence: null
    })
  })

  it('reads a host with no physical NIC as wol_not_observable without spawning', async () => {
    const h = harness('linux', {})
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([])
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'wol_not_observable',
      evidence: null
    })
  })

  it('never passes an option-shaped interface name to ethtool', async () => {
    const h = harness('linux', {}, { interfaces: ['-s'] })
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([])
    expect(h.probe.read().value).toBe('unknown')
  })

  it('runs pmset -g on darwin', async () => {
    const h = harness('darwin', { pmset: ok(' womp                 0\n') })
    h.probe.read()
    h.advance(10)
    await h.probe.settled()
    expect(h.calls).toEqual([{ file: 'pmset', args: ['-g'] }])
    expect(h.probe.read()).toEqual({
      value: 'needs-owner-setup',
      reason: 'os_not_armed',
      evidence: { kind: 'os-probe', observedAt: T + 10 }
    })
  })

  it('reads a failed pmset as wol_probe_unreadable', async () => {
    const h = harness('darwin', {})
    h.probe.read()
    await h.probe.settled()
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'wol_probe_unreadable',
      evidence: null
    })
  })

  it('answers an unlisted platform with unknown and spawns nothing', async () => {
    const h = harness('freebsd', WIN_REPLIES)
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([])
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'wol_not_observable_on_platform',
      evidence: null
    })
  })
})

describe('default WOL probe deps', () => {
  it('reads a missing file as null and never throws listing interfaces', async () => {
    const deps = defaultHostWolProbeDeps()
    await expect(deps.readText('/nonexistent/orca-wol-probe/wakeup')).resolves.toBeNull()
    await expect(deps.listPhysicalInterfaces()).resolves.toEqual(expect.any(Array))
  })
})

describe('host WOL probe on win32', () => {
  it('answers pending, then maps an enabled but unarmed Ethernet adapter to os_not_armed', async () => {
    const h = harness('win32', {
      'powershell.exe': ok(ADAPTERS_JSON),
      'powercfg.exe': ok(ARMED_WITHOUT_NIC)
    })
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'wol_probe_pending',
      evidence: null
    })
    h.advance(250)
    await h.probe.settled()
    expect(h.probe.read()).toEqual({
      value: 'needs-owner-setup',
      reason: 'os_not_armed',
      evidence: { kind: 'os-probe', observedAt: T + 250 }
    })
  })

  it('spawns exactly the constant adapter script and the read-only powercfg query', async () => {
    const h = harness('win32', {
      'powershell.exe': ok(ADAPTERS_JSON),
      'powercfg.exe': ok(ARMED_WITHOUT_NIC)
    })
    h.probe.read()
    await h.probe.settled()
    expect(h.calls).toEqual([
      {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_WOL_ADAPTER_SCRIPT]
      },
      { file: 'powercfg.exe', args: ['/devicequery', 'wake_armed'] }
    ])
  })

  it('reads a failed adapter spawn as wol_probe_unreadable, never not-supported', async () => {
    const h = harness('win32', { 'powercfg.exe': ok(ARMED_WITHOUT_NIC) })
    h.probe.read()
    await h.probe.settled()
    expect(h.probe.read()).toEqual({
      value: 'unknown',
      reason: 'wol_probe_unreadable',
      evidence: null
    })
  })
})
