export const WOL_ADAPTER_UNREADABLE = 'Unreadable'

// Why [string]: Windows PowerShell 5.1 serializes enums as integers; @() keeps one adapter an array.
// Why the fallback: unelevated Get-NetAdapterPowerManagement fails with system error 31 on some drivers
// (measured on a Realtek NIC); the *WakeOnMagicPacket keyword is the same setting and language independent.
export const WINDOWS_WOL_ADAPTER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$rows = @(Get-NetAdapter -Physical | ForEach-Object {',
  '  $adapter = $_',
  `  $wake = '${WOL_ADAPTER_UNREADABLE}'`,
  '  try {',
  '    $wake = [string](Get-NetAdapterPowerManagement -Name $adapter.Name).WakeOnMagicPacket',
  '  } catch {',
  "    $prop = Get-NetAdapterAdvancedProperty -Name $adapter.Name -RegistryKeyword '*WakeOnMagicPacket' -ErrorAction SilentlyContinue",
  "    if ($prop) { $wake = if ([string]$prop.RegistryValue -eq '1') { 'Enabled' } else { 'Disabled' } }",
  '  }',
  '  [pscustomobject]@{',
  '    Name = [string]$adapter.Name',
  '    InterfaceDescription = [string]$adapter.InterfaceDescription',
  '    MediaType = [string]$adapter.MediaType',
  '    WakeOnMagicPacket = $wake',
  '  }',
  '})',
  'ConvertTo-Json -InputObject $rows -Compress'
].join('\n')

export type WindowsWolAdapter = {
  name: string
  interfaceDescription: string
  mediaType: string
  wakeOnMagicPacket: string
}

type WolEvidence = { kind: 'os-probe'; observedAt: number }

// Why no supported branch: only an observed wake proves it, and that is OWNER_BOUND in this phase (D-02).
export type WolVerdict =
  | { value: 'not-supported' | 'needs-owner-setup'; reason: string; evidence: WolEvidence }
  | { value: 'unknown'; reason: string; evidence: null }

function osProbe(
  value: 'not-supported' | 'needs-owner-setup',
  reason: string,
  observedAt: number
): WolVerdict {
  return { value, reason, evidence: { kind: 'os-probe', observedAt } }
}

function unknownVerdict(reason: string): WolVerdict {
  return { value: 'unknown', reason, evidence: null }
}

// Why unknown: arming is visible to the OS, but whether firmware honours it is not.
const FIRMWARE_UNVERIFIED = unknownVerdict('firmware_unverified')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textField(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return typeof value === 'number' ? String(value) : ''
}

export function parseWindowsWolAdapters(stdout: string): WindowsWolAdapter[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const adapters: WindowsWolAdapter[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.Name !== 'string') {
      return null
    }
    adapters.push({
      name: entry.Name,
      interfaceDescription: textField(entry.InterfaceDescription),
      mediaType: textField(entry.MediaType),
      wakeOnMagicPacket: textField(entry.WakeOnMagicPacket)
    })
  }
  return adapters
}

export function parseWakeArmedDevices(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.toUpperCase() !== 'NONE')
}

export function windowsWolVerdict(input: {
  adapters: readonly WindowsWolAdapter[]
  armed: readonly string[]
  observedAt: number
}): WolVerdict {
  const wired = input.adapters.filter((adapter) => adapter.mediaType === '802.3')
  const capable = wired.filter((adapter) => adapter.wakeOnMagicPacket === 'Enabled')
  if (capable.length === 0) {
    // Why: an Ethernet adapter whose setting could not be read may be the capable one (D-03).
    return wired.some((adapter) => adapter.wakeOnMagicPacket === WOL_ADAPTER_UNREADABLE)
      ? unknownVerdict('wol_adapter_unreadable')
      : osProbe('not-supported', 'no_wake_capable_adapter', input.observedAt)
  }
  const armed = new Set(input.armed.map((device) => device.trim().toLowerCase()))
  const anyArmed = capable.some((adapter) =>
    armed.has(adapter.interfaceDescription.trim().toLowerCase())
  )
  return anyArmed
    ? FIRMWARE_UNVERIFIED
    : osProbe('needs-owner-setup', 'os_not_armed', input.observedAt)
}

export type LinuxWolRow = { name: string; ethtool: string | null; sysfsWakeup: string | null }

type LinuxRowState = 'armed' | 'not_armed' | 'incapable' | 'unreadable'

function ethtoolState(output: string | null): LinuxRowState {
  const supports = output?.match(/^\s*Supports Wake-on:\s*(\S+)/m)?.[1]
  const wakeOn = output?.match(/^\s*Wake-on:\s*(\S+)/m)?.[1]
  if (supports === undefined) {
    return 'unreadable'
  }
  // Why 'g': ethtool's flag for magic-packet wake; other flags do not answer a magic packet.
  if (!supports.includes('g')) {
    return 'incapable'
  }
  return wakeOn?.includes('g') ? 'armed' : 'not_armed'
}

function sysfsState(wakeup: string | null): LinuxRowState {
  const value = wakeup?.trim()
  if (value === 'enabled') {
    return 'armed'
  }
  return value === 'disabled' ? 'not_armed' : 'unreadable'
}

function linuxRowState(row: LinuxWolRow): LinuxRowState {
  const fromEthtool = ethtoolState(row.ethtool)
  return fromEthtool === 'unreadable' ? sysfsState(row.sysfsWakeup) : fromEthtool
}

export function linuxWolVerdict(rows: readonly LinuxWolRow[], observedAt: number): WolVerdict {
  if (rows.length === 0) {
    // Why: WSL and containers expose no device-backed NIC; absence of a NIC is not absence of support.
    return unknownVerdict('wol_not_observable')
  }
  const states = rows.map(linuxRowState)
  if (states.includes('armed')) {
    return FIRMWARE_UNVERIFIED
  }
  if (states.includes('not_armed')) {
    return osProbe('needs-owner-setup', 'os_not_armed', observedAt)
  }
  // Why: one unreadable NIC could be the capable one, so a mix is never a negative.
  return states.every((state) => state === 'incapable')
    ? osProbe('not-supported', 'no_wake_capable_adapter', observedAt)
    : unknownVerdict('wol_tool_unavailable')
}

export function darwinWolVerdict(pmsetStdout: string, observedAt: number): WolVerdict {
  const womp = pmsetStdout.match(/^\s*womp\s+(\d+)/m)?.[1]
  if (womp === undefined) {
    // Why: pmset omits womp on some hardware and versions; absence is not evidence of no hardware.
    return unknownVerdict('womp_not_reported')
  }
  return womp === '0'
    ? osProbe('needs-owner-setup', 'os_not_armed', observedAt)
    : FIRMWARE_UNVERIFIED
}
