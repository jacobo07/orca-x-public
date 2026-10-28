import { describe, expect, it } from 'vitest'
import type { HostCapability } from '../../shared/host-availability'
import {
  WINDOWS_OOB_PROBE_SCRIPT,
  darwinOobVerdict,
  linuxOobVerdict,
  oobVerdict,
  parseLinuxCpuVendor,
  parseWindowsOobProbe,
  windowsOobVerdict
} from './host-oob-verdict'

const T = 1_760_000_000_000
const WIRE_REASON = /^[a-z0-9_]{1,64}$/

const AMD_CPUINFO = 'processor\t: 0\nvendor_id\t: AuthenticAMD\ncpu family\t: 23\n'
const INTEL_CPUINFO = 'processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Core\n'
const ARM_CPUINFO = 'processor\t: 0\nBogoMIPS\t: 108.00\nCPU implementer\t: 0x41\n'
const TWO_CPU_CPUINFO =
  'processor\t: 0\nvendor_id\t: GenuineIntel\n\nprocessor\t: 1\nvendor_id\t: AuthenticAMD\n'
const HYGON_CPUINFO = 'processor\t: 0\nvendor_id\t: HygonGenuine\n'

type Expected = { value: HostCapability['value']; reason: string }
// Why unknown: a CPU vendor proves no AMT, not the absence of DASH or a BMC (review WR-02).
const AMD: Expected = { value: 'unknown', reason: 'amd_no_amt_oob_unmeasured' }
const NO_MEI: Expected = { value: 'unknown', reason: 'intel_mei_not_detected' }
const AMT_UNVERIFIED: Expected = { value: 'unknown', reason: 'intel_amt_unverified' }
const UNRECOGNIZED: Expected = { value: 'unknown', reason: 'oob_vendor_unrecognized' }
const UNREADABLE: Expected = { value: 'unknown', reason: 'oob_probe_unreadable' }
const UNREPORTED: Expected = { value: 'unknown', reason: 'oob_cpu_vendor_unreported' }

type Row = { name: string; verdict: () => HostCapability; expected: Expected }

const win = (stdout: string) => () => windowsOobVerdict(stdout, T)
const linux = (cpuinfo: string, meiPresent: boolean) => () =>
  linuxOobVerdict(cpuinfo, meiPresent, T)
const darwin = (stdout: string) => () => darwinOobVerdict(stdout, T)

const TABLE: Row[] = [
  { name: 'win: AMD, mei 0', verdict: win('vendor=AuthenticAMD\nmei=0\n'), expected: AMD },
  { name: 'win: AMD, mei 1', verdict: win('vendor=AuthenticAMD\nmei=1\n'), expected: AMD },
  { name: 'win: Intel, mei 0', verdict: win('vendor=GenuineIntel\nmei=0\n'), expected: NO_MEI },
  {
    name: 'win: Intel, mei 2',
    verdict: win('vendor=GenuineIntel\nmei=2\n'),
    expected: AMT_UNVERIFIED
  },
  {
    name: 'win: padded Intel, mei 1',
    verdict: win('  vendor= GenuineIntel  \n  mei= 1 \n'),
    expected: AMT_UNVERIFIED
  },
  { name: 'win: CRLF AMD', verdict: win('vendor=AuthenticAMD\r\nmei=0\r\n'), expected: AMD },
  {
    name: 'win: unrecognized vendor',
    verdict: win('vendor=CentaurHauls\nmei=0\n'),
    expected: UNRECOGNIZED
  },
  { name: 'win: empty stdout', verdict: win(''), expected: UNREADABLE },
  { name: 'win: missing mei line', verdict: win('vendor=AuthenticAMD\n'), expected: UNREADABLE },
  { name: 'win: mei=abc', verdict: win('vendor=GenuineIntel\nmei=abc\n'), expected: UNREADABLE },
  { name: 'win: empty vendor', verdict: win('vendor=\nmei=0\n'), expected: UNREADABLE },
  { name: 'linux: AMD', verdict: linux(AMD_CPUINFO, false), expected: AMD },
  { name: 'linux: AMD with a MEI node', verdict: linux(AMD_CPUINFO, true), expected: AMD },
  {
    name: 'linux: Intel, MEI present',
    verdict: linux(INTEL_CPUINFO, true),
    expected: AMT_UNVERIFIED
  },
  { name: 'linux: Intel, MEI absent', verdict: linux(INTEL_CPUINFO, false), expected: NO_MEI },
  { name: 'linux: ARM, no vendor_id', verdict: linux(ARM_CPUINFO, false), expected: UNREPORTED },
  {
    name: 'linux: first vendor_id wins',
    verdict: linux(TWO_CPU_CPUINFO, false),
    expected: NO_MEI
  },
  { name: 'linux: Hygon', verdict: linux(HYGON_CPUINFO, false), expected: UNRECOGNIZED },
  { name: 'darwin: Intel', verdict: darwin('GenuineIntel\n'), expected: NO_MEI },
  { name: 'darwin: empty answer', verdict: darwin(''), expected: UNREPORTED }
]

describe('OOB verdict table (D-07)', () => {
  it.each(TABLE.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(row.verdict()).toMatchObject(row.expected)
  })

  it('never yields supported over the whole table', () => {
    const supported = TABLE.filter((row) => (row.verdict().value as string) === 'supported')
    expect(TABLE.length, `table has ${TABLE.length} rows`).toBeGreaterThanOrEqual(16)
    expect(
      supported.map((row) => row.name),
      `of ${TABLE.length} rows`
    ).toEqual([])
  })

  it('keeps every reason on the wire pattern and evidence matched to the value', () => {
    for (const row of TABLE) {
      const verdict = row.verdict()
      expect(verdict.reason, row.name).toMatch(WIRE_REASON)
      if (verdict.value === 'unknown') {
        expect(verdict.evidence, row.name).toBeNull()
      } else {
        expect(verdict.evidence, row.name).toEqual({ kind: 'os-probe', observedAt: T })
      }
    }
  })
})

describe('OOB parsers', () => {
  it('parses vendor and MEI count, and rejects a partial answer', () => {
    expect(parseWindowsOobProbe('vendor=AuthenticAMD\r\nmei=0\r\n')).toEqual({
      vendor: 'AuthenticAMD',
      meiCount: 0
    })
    expect(parseWindowsOobProbe('mei=0\n')).toBeNull()
    expect(parseWindowsOobProbe('vendor=GenuineIntel\nmei=-1\n')).toBeNull()
  })

  it('reads the first vendor_id from cpuinfo and null when there is none', () => {
    expect(parseLinuxCpuVendor(TWO_CPU_CPUINFO)).toBe('GenuineIntel')
    expect(parseLinuxCpuVendor(ARM_CPUINFO)).toBeNull()
  })

  it('maps a missing vendor to unknown oob_cpu_vendor_unreported', () => {
    expect(oobVerdict({ vendor: null, meiPresent: true, observedAt: T })).toEqual({
      value: 'unknown',
      reason: 'oob_cpu_vendor_unreported',
      evidence: null
    })
  })

  it('keeps the Windows script to read-only CIM queries', () => {
    expect(WINDOWS_OOB_PROBE_SCRIPT).toContain('Get-CimInstance Win32_Processor')
    expect(WINDOWS_OOB_PROBE_SCRIPT).toContain('Get-CimInstance Win32_PnPEntity')
    expect(WINDOWS_OOB_PROBE_SCRIPT).not.toMatch(/Set-|Invoke-CimMethod|powercfg|bcdedit|"/i)
  })
})
