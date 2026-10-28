import type { HostCapability } from '../../shared/host-availability'

// Why no double quotes: the script travels as one argv entry, and Windows argv quoting rewrites them.
// Read-only CIM queries: the first CPU's vendor and how many Intel management engine interfaces exist.
export const WINDOWS_OOB_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
  "$mei = @(Get-CimInstance Win32_PnPEntity -Filter 'Name LIKE ''%Management Engine%''')",
  "'vendor=' + [string]$cpu.Manufacturer",
  "'mei=' + $mei.Count"
].join('\n')

const AMD_VENDOR = 'AuthenticAMD'
const INTEL_VENDOR = 'GenuineIntel'

function lineValue(lines: string[], key: string): string | null {
  const line = lines.find((candidate) => candidate.startsWith(`${key}=`))
  return line === undefined ? null : line.slice(key.length + 1).trim()
}

export function parseWindowsOobProbe(stdout: string): { vendor: string; meiCount: number } | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim())
  const vendor = lineValue(lines, 'vendor')
  const mei = lineValue(lines, 'mei')
  if (!vendor || mei === null || !/^\d+$/.test(mei)) {
    return null
  }
  return { vendor, meiCount: Number(mei) }
}

export function parseLinuxCpuVendor(cpuinfo: string): string | null {
  return /^vendor_id\s*:\s*(\S+)/m.exec(cpuinfo)?.[1] ?? null
}

function unknownOob(reason: string): HostCapability {
  return { value: 'unknown', reason, evidence: null }
}

// Why no supported branch: no OOB controller is proven in this phase, so the best answer is unknown (D-07).
export function oobVerdict(input: {
  vendor: string | null
  meiPresent: boolean
  observedAt: number
}): HostCapability {
  if (input.vendor === AMD_VENDOR) {
    // Why unknown: AMT is Intel-only, but an AMD vendor does not rule out DASH or a BMC, which nothing here reads.
    return unknownOob('amd_no_amt_oob_unmeasured')
  }
  if (input.vendor === INTEL_VENDOR) {
    // Why unknown with an interface: a present MEI is not a provisioned, reachable AMT.
    return unknownOob(input.meiPresent ? 'intel_amt_unverified' : 'intel_mei_not_detected')
  }
  return unknownOob(input.vendor === null ? 'oob_cpu_vendor_unreported' : 'oob_vendor_unrecognized')
}

export function windowsOobVerdict(stdout: string, observedAt: number): HostCapability {
  const parsed = parseWindowsOobProbe(stdout)
  return parsed === null
    ? unknownOob('oob_probe_unreadable')
    : oobVerdict({ vendor: parsed.vendor, meiPresent: parsed.meiCount > 0, observedAt })
}

export function linuxOobVerdict(
  cpuinfo: string,
  meiPresent: boolean,
  observedAt: number
): HostCapability {
  return oobVerdict({ vendor: parseLinuxCpuVendor(cpuinfo), meiPresent, observedAt })
}

// Why meiPresent false: macOS exposes no Intel management engine interface to user space.
export function darwinOobVerdict(stdout: string, observedAt: number): HostCapability {
  return oobVerdict({ vendor: stdout.trim() || null, meiPresent: false, observedAt })
}
