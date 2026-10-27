import { describe, expect, it } from 'vitest'
import { HOST_CAPABILITY_VALUES } from '../../shared/host-availability'
import {
  darwinWolVerdict,
  linuxWolVerdict,
  parseWakeArmedDevices,
  parseWindowsWolAdapters,
  windowsWolVerdict,
  type LinuxWolRow,
  type WindowsWolAdapter,
  type WolVerdict
} from './host-wol-verdict'

const T = 1_760_000_000_000
const REALTEK = 'Realtek PCIe GbE Family Controller'
const REASON_PATTERN = /^[a-z0-9_]{1,64}$/

function nic(overrides: Partial<WindowsWolAdapter> = {}): WindowsWolAdapter {
  return {
    name: 'Ethernet',
    interfaceDescription: REALTEK,
    mediaType: '802.3',
    wakeOnMagicPacket: 'Enabled',
    ...overrides
  }
}

function win(adapters: WindowsWolAdapter[], armed: string[]): WolVerdict {
  return windowsWolVerdict({ adapters, armed, observedAt: T })
}

function parsedWin(json: string, armed: string[]): WolVerdict {
  const adapters = parseWindowsWolAdapters(json)
  if (adapters === null) {
    throw new Error(`fixture did not parse: ${json}`)
  }
  return win(adapters, armed)
}

function ethtool(supports: string, wakeOn: string): string {
  return `Settings for enp3s0:\n\tSupports Wake-on: ${supports}\n\tWake-on: ${wakeOn}\n\tLink detected: yes\n`
}

function linux(rows: LinuxWolRow[]): WolVerdict {
  return linuxWolVerdict(rows, T)
}

function row(ethtoolOut: string | null, sysfsWakeup: string | null, name = 'enp3s0'): LinuxWolRow {
  return { name, ethtool: ethtoolOut, sysfsWakeup }
}

type Expected = { value: WolVerdict['value']; reason: string }
const NOT_SUPPORTED: Expected = { value: 'not-supported', reason: 'no_wake_capable_adapter' }
const NOT_ARMED: Expected = { value: 'needs-owner-setup', reason: 'os_not_armed' }
const FIRMWARE: Expected = { value: 'unknown', reason: 'firmware_unverified' }

const TABLE: { name: string; verdict: () => WolVerdict; expected: Expected }[] = [
  { name: 'win: zero adapters', verdict: () => win([], []), expected: NOT_SUPPORTED },
  {
    name: 'win: only Wi-Fi enabled',
    verdict: () => win([nic({ name: 'Wi-Fi', mediaType: 'Native 802.11' })], ['Wi-Fi']),
    expected: NOT_SUPPORTED
  },
  {
    name: 'win: 802.3 Disabled',
    verdict: () => win([nic({ wakeOnMagicPacket: 'Disabled' })], [REALTEK]),
    expected: NOT_SUPPORTED
  },
  {
    name: 'win: 802.3 Unsupported',
    verdict: () => win([nic({ wakeOnMagicPacket: 'Unsupported' })], [REALTEK]),
    expected: NOT_SUPPORTED
  },
  {
    name: 'win: enabled, armed list holds another device',
    verdict: () => win([nic()], ['HID Keyboard Device']),
    expected: NOT_ARMED
  },
  { name: 'win: enabled and armed', verdict: () => win([nic()], [REALTEK]), expected: FIRMWARE },
  {
    name: 'win: enabled and armed, different case and padding',
    verdict: () => win([nic()], [`  ${REALTEK.toUpperCase()} `]),
    expected: FIRMWARE
  },
  {
    name: 'win: two adapters, one armed',
    verdict: () =>
      win([nic({ name: 'Ethernet 2', interfaceDescription: 'Intel(R) I219-V' }), nic()], [REALTEK]),
    expected: FIRMWARE
  },
  {
    name: 'win: single JSON object instead of an array',
    verdict: () =>
      parsedWin(
        `{"Name":"Ethernet","InterfaceDescription":"${REALTEK}","MediaType":"802.3","WakeOnMagicPacket":"Enabled"}`,
        []
      ),
    expected: NOT_ARMED
  },
  {
    name: 'win: integer WakeOnMagicPacket (PS 5.1 enum leak) is not Enabled',
    verdict: () =>
      parsedWin(
        `[{"Name":"Ethernet","InterfaceDescription":"${REALTEK}","MediaType":"802.3","WakeOnMagicPacket":2}]`,
        [REALTEK]
      ),
    expected: NOT_SUPPORTED
  },
  {
    name: 'linux: no physical NIC (WSL, container)',
    verdict: () => linux([]),
    expected: { value: 'unknown', reason: 'wol_not_observable' }
  },
  {
    name: 'linux: pumbg armed g',
    verdict: () => linux([row(ethtool('pumbg', 'g'), null)]),
    expected: FIRMWARE
  },
  {
    name: 'linux: pumbg disarmed d',
    verdict: () => linux([row(ethtool('pumbg', 'd'), null)]),
    expected: NOT_ARMED
  },
  {
    name: 'linux: supports d only',
    verdict: () => linux([row(ethtool('d', 'd'), null)]),
    expected: NOT_SUPPORTED
  },
  {
    name: 'linux: no ethtool, sysfs enabled',
    verdict: () => linux([row(null, 'enabled\n')]),
    expected: FIRMWARE
  },
  {
    name: 'linux: no ethtool, sysfs disabled',
    verdict: () => linux([row(null, 'disabled\n')]),
    expected: NOT_ARMED
  },
  {
    name: 'linux: no ethtool, no sysfs',
    verdict: () => linux([row(null, null)]),
    expected: { value: 'unknown', reason: 'wol_tool_unavailable' }
  },
  {
    name: 'linux: ethtool without Wake-on lines (EPERM) falls to sysfs',
    verdict: () => linux([row('Settings for enp3s0:\n\tLink detected: yes\n', 'enabled')]),
    expected: FIRMWARE
  },
  {
    name: 'linux: one incapable NIC and one armed NIC',
    verdict: () => linux([row(ethtool('d', 'd'), null, 'eno1'), row(ethtool('pumbg', 'g'), null)]),
    expected: FIRMWARE
  },
  {
    name: 'linux: one incapable NIC and one unreadable NIC is not a negative',
    verdict: () => linux([row(ethtool('d', 'd'), null, 'eno1'), row(null, null)]),
    expected: { value: 'unknown', reason: 'wol_tool_unavailable' }
  },
  {
    name: 'darwin: womp 1',
    verdict: () => darwinWolVerdict('System-wide power settings:\n womp                 1\n', T),
    expected: FIRMWARE
  },
  {
    name: 'darwin: womp 0',
    verdict: () => darwinWolVerdict(' displaysleep 10\n womp                 0\n', T),
    expected: NOT_ARMED
  },
  {
    name: 'darwin: no womp line',
    verdict: () => darwinWolVerdict(' displaysleep 10\n sleep 1\n', T),
    expected: { value: 'unknown', reason: 'womp_not_reported' }
  }
]

describe('WOL verdict table (D-02)', () => {
  it.each(TABLE.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const verdict = entry.verdict()
    expect({ value: verdict.value, reason: verdict.reason }).toEqual(entry.expected)
    if (verdict.value === 'unknown') {
      expect(verdict.evidence).toBeNull()
    } else {
      expect(verdict.evidence).toEqual({ kind: 'os-probe', observedAt: T })
    }
    expect(verdict.reason).toMatch(REASON_PATTERN)
    expect(HOST_CAPABILITY_VALUES).toContain(verdict.value)
  })

  it('never yields supported over the whole table', () => {
    const supported = TABLE.filter((entry) => (entry.verdict().value as string) === 'supported')
    expect(TABLE.length, `table has ${TABLE.length} rows`).toBeGreaterThanOrEqual(20)
    expect(
      supported.map((entry) => entry.name),
      `of ${TABLE.length} rows`
    ).toEqual([])
  })
})

describe('WOL output parsers', () => {
  it('reads unparseable adapter JSON as null', () => {
    expect(parseWindowsWolAdapters('Get-NetAdapter : not recognized')).toBeNull()
    expect(parseWindowsWolAdapters('[1,2]')).toBeNull()
  })

  it('reads an empty adapter array as no adapters', () => {
    expect(parseWindowsWolAdapters('[]\r\n')).toEqual([])
  })

  it('keeps trimmed powercfg device lines and drops NONE', () => {
    expect(parseWakeArmedDevices(`HID Keyboard Device\r\n  ${REALTEK} \r\n\r\n`)).toEqual([
      'HID Keyboard Device',
      REALTEK
    ])
    expect(parseWakeArmedDevices('NONE\r\n')).toEqual([])
  })
})
