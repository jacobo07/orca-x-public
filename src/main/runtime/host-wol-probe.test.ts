import { describe, expect, it } from 'vitest'
import { WINDOWS_WOL_ADAPTER_SCRIPT } from './host-wol-verdict'
import { createHostWolProbe, type HostWolExecResult } from './host-wol-probe'

const T = 1_760_000_000_000
const ADAPTERS_JSON =
  '[{"Name":"Ethernet","InterfaceDescription":"Realtek PCIe GbE Family Controller","MediaType":"802.3","WakeOnMagicPacket":"Enabled"}]'
const ARMED_WITHOUT_NIC = 'HID Keyboard Device\r\nHID-compliant mouse\r\n'

type Call = { file: string; args: readonly string[] }
type Replies = Record<string, HostWolExecResult>

function ok(stdout: string): HostWolExecResult {
  return { code: 0, stdout, stderr: '' }
}

function harness(platform: NodeJS.Platform, replies: Replies) {
  const calls: Call[] = []
  let clock = T
  const probe = createHostWolProbe({
    platform,
    now: () => clock,
    exec: (file, args) => {
      calls.push({ file, args })
      return Promise.resolve(replies[file] ?? { code: -1, stdout: '', stderr: 'ENOENT' })
    },
    listPhysicalInterfaces: () => Promise.resolve([]),
    readText: () => Promise.resolve(null)
  })
  return {
    probe,
    calls,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock
  }
}

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
