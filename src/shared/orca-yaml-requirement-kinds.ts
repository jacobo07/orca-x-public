import { isOrcaYamlFieldWithinLimit } from './orca-yaml-file-limit'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from './tui-agent-detection-commands'
import { parseVersionRange } from './environment-version-range'
import {
  COMMAND_NAME_PATTERN,
  ENV_NAME_PATTERN,
  REQUIREMENT_ARCH_VALUES,
  REQUIREMENT_CREDENTIAL_PROVIDERS,
  REQUIREMENT_OS_VALUES,
  REQUIREMENT_VERSION_ARGS,
  type AgentRequirement,
  type CommandRequirement,
  type CredentialRequirement,
  type EnvRequirement,
  type EvaluatedRequirementKind,
  type PlatformRequirement,
  type RequirementPlatform
} from './environment-requirement-types'

// Why: copied from orca-yaml.ts (module-private there) so that file stays byte-identical.
export function asRequirementRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asRequirementString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isOrcaYamlFieldWithinLimit(value)) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

export type RequirementReporter = (field: string | undefined, message: string) => void

const MAX_PLATFORM_ENTRIES = 8

export type RequirementCommonFields = {
  platforms?: RequirementPlatform[]
  prepare?: string
  description?: string
}

function readPlatforms(
  value: unknown,
  report: RequirementReporter
): RequirementPlatform[] | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLATFORM_ENTRIES) {
    report(
      'platforms',
      `platforms must be a list of 1-${MAX_PLATFORM_ENTRIES} { os, arch } entries.`
    )
    return null
  }
  const platforms: RequirementPlatform[] = []
  for (const entry of value) {
    const record = asRequirementRecord(entry)
    const os = record ? asRequirementString(record.os) : undefined
    const arch = record ? asRequirementString(record.arch) : undefined
    const osOk = os === undefined || (REQUIREMENT_OS_VALUES as readonly string[]).includes(os)
    const archOk =
      arch === undefined || (REQUIREMENT_ARCH_VALUES as readonly string[]).includes(arch)
    if (!record || !osOk || !archOk || (os === undefined && arch === undefined)) {
      report(
        'platforms',
        'Each platforms entry needs os (linux, darwin, win32) and/or arch (x64, arm64).'
      )
      return null
    }
    platforms.push({
      ...(os ? { os: os as RequirementPlatform['os'] } : {}),
      ...(arch ? { arch: arch as RequirementPlatform['arch'] } : {})
    })
  }
  return platforms
}

// Returns null when a field is invalid (a diagnostic was reported); the row becomes malformed.
export function readCommonFields(
  record: Record<string, unknown>,
  report: RequirementReporter
): RequirementCommonFields | null {
  const platforms = readPlatforms(record.platforms, report)
  if (platforms === null) {
    return null
  }
  let description: string | undefined
  if (record.description !== undefined) {
    description = asRequirementString(record.description)
    if (description === undefined) {
      report('description', 'description must be a non-empty string.')
      return null
    }
  }
  let prepare: string | undefined
  if (record.prepare !== undefined) {
    const raw = record.prepare
    // Why: the exact scalar is what an approval hashes, so it is never trimmed or normalized.
    if (typeof raw !== 'string' || raw.trim() === '' || !isOrcaYamlFieldWithinLimit(raw)) {
      report('prepare', 'prepare must be a non-empty command within 64 KiB.')
      return null
    }
    prepare = raw
  }
  return {
    ...(platforms ? { platforms } : {}),
    ...(prepare !== undefined ? { prepare } : {}),
    ...(description ? { description } : {})
  }
}

type KindPart<T> = Omit<T, 'id' | 'platforms' | 'prepare' | 'description'>
export type EvaluatedKindPart =
  | KindPart<CommandRequirement>
  | KindPart<AgentRequirement>
  | KindPart<PlatformRequirement>
  | KindPart<EnvRequirement>
  | KindPart<CredentialRequirement>

function readCommand(
  record: Record<string, unknown>,
  report: RequirementReporter
): KindPart<CommandRequirement> | null {
  const name = asRequirementString(record.name)
  if (!name || !COMMAND_NAME_PATTERN.test(name)) {
    report(
      'name',
      'command name must be a bare command name (letters, digits, . _ + -), never a path.'
    )
    return null
  }
  let versionArg: CommandRequirement['versionArg'] = '--version'
  if (record.versionArgs !== undefined) {
    const arg = typeof record.versionArgs === 'string' ? record.versionArgs : undefined
    if (arg === undefined || !(REQUIREMENT_VERSION_ARGS as readonly string[]).includes(arg)) {
      report('versionArgs', `versionArgs must be one of ${REQUIREMENT_VERSION_ARGS.join(', ')}.`)
      return null
    }
    versionArg = arg as CommandRequirement['versionArg']
  }
  let versionRange: CommandRequirement['versionRange']
  if (record.version !== undefined) {
    const raw =
      typeof record.version === 'string' || typeof record.version === 'number'
        ? String(record.version).trim()
        : ''
    versionRange = parseVersionRange(raw)
    if (versionRange.status === 'unsupported') {
      report(
        'version',
        'Unsupported version range; use space-separated >=, >, <=, <, = comparators.'
      )
    }
  }
  return { kind: 'command', name, versionArg, ...(versionRange ? { versionRange } : {}) }
}

function readEnv(
  record: Record<string, unknown>,
  report: RequirementReporter
): KindPart<EnvRequirement> | null {
  for (const forbidden of ['value', 'default']) {
    if (record[forbidden] !== undefined) {
      // Why: the message names the field only; the value is never read into a diagnostic.
      report(forbidden, `env requirements carry a name only; remove "${forbidden}".`)
      return null
    }
  }
  const name = asRequirementString(record.name)
  if (!name || !ENV_NAME_PATTERN.test(name)) {
    report('name', 'env name must be UPPER_SNAKE_CASE (A-Z, 0-9, _).')
    return null
  }
  return { kind: 'env', name }
}

function readAgent(
  record: Record<string, unknown>,
  report: RequirementReporter
): KindPart<AgentRequirement> | null {
  const provider = asRequirementString(record.provider)
  if (!provider || !KNOWN_TUI_AGENT_DETECTION_COMMANDS.some((entry) => entry.id === provider)) {
    report('provider', 'agent provider must be a known agent id.')
    return null
  }
  return { kind: 'agent', provider }
}

function readPlatformKind(
  record: Record<string, unknown>,
  report: RequirementReporter
): KindPart<PlatformRequirement> | null {
  const os = asRequirementString(record.os)
  const arch = asRequirementString(record.arch)
  const osOk = os === undefined || (REQUIREMENT_OS_VALUES as readonly string[]).includes(os)
  const archOk = arch === undefined || (REQUIREMENT_ARCH_VALUES as readonly string[]).includes(arch)
  if (!osOk || !archOk || (os === undefined && arch === undefined)) {
    report('os', 'platform needs os (linux, darwin, win32) and/or arch (x64, arm64).')
    return null
  }
  return {
    kind: 'platform',
    ...(os ? { os: os as PlatformRequirement['os'] } : {}),
    ...(arch ? { arch: arch as PlatformRequirement['arch'] } : {})
  }
}

function readCredential(
  record: Record<string, unknown>,
  report: RequirementReporter
): KindPart<CredentialRequirement> | null {
  const provider = asRequirementString(record.provider)
  if (!provider || !(REQUIREMENT_CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)) {
    report('provider', 'credential provider must be gh or glab.')
    return null
  }
  return { kind: 'credential', provider: provider as CredentialRequirement['provider'] }
}

export function readEvaluatedKind(
  kind: EvaluatedRequirementKind,
  record: Record<string, unknown>,
  report: RequirementReporter
): EvaluatedKindPart | null {
  switch (kind) {
    case 'command':
      return readCommand(record, report)
    case 'env':
      return readEnv(record, report)
    case 'agent':
      return readAgent(record, report)
    case 'platform':
      return readPlatformKind(record, report)
    case 'credential':
      return readCredential(record, report)
  }
}
