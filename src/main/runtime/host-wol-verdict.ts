// Why [string]: Windows PowerShell 5.1 serializes enums as integers; @() keeps one adapter an array.
export const WINDOWS_WOL_ADAPTER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$rows = @(Get-NetAdapter -Physical | ForEach-Object {',
  '  $pm = Get-NetAdapterPowerManagement -Name $_.Name',
  '  [pscustomobject]@{',
  '    Name = [string]$_.Name',
  '    InterfaceDescription = [string]$_.InterfaceDescription',
  '    MediaType = [string]$_.MediaType',
  '    WakeOnMagicPacket = [string]$pm.WakeOnMagicPacket',
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
  const capable = input.adapters.filter(
    (adapter) => adapter.mediaType === '802.3' && adapter.wakeOnMagicPacket === 'Enabled'
  )
  if (capable.length === 0) {
    return osProbe('not-supported', 'no_wake_capable_adapter', input.observedAt)
  }
  const armed = new Set(input.armed.map((device) => device.trim().toLowerCase()))
  const anyArmed = capable.some((adapter) =>
    armed.has(adapter.interfaceDescription.trim().toLowerCase())
  )
  return anyArmed
    ? FIRMWARE_UNVERIFIED
    : osProbe('needs-owner-setup', 'os_not_armed', input.observedAt)
}
