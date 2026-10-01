import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from './tui-agent-detection-commands'
import type { TuiAgentDetectionCommand } from './tui-agent-detection-commands'
import {
  COMMAND_NAME_PATTERN,
  ENV_NAME_PATTERN,
  REQUIREMENT_ARCH_VALUES,
  REQUIREMENT_CREDENTIAL_PROVIDERS,
  REQUIREMENT_OS_VALUES,
  isEvaluatedRequirement,
  type CredentialRequirement,
  type EnvironmentRequirement,
  type RequirementPlatform,
  type RequirementProbeRequest,
  type RequirementVersionArg
} from './environment-requirement-types'
import { MAX_REQUIREMENTS_PER_REQUEST, VERSION_ARGS } from './environment-requirement-probe-core'

// Same grammar as ORCA_VM_RECIPE_ID_PATTERN (a test pins the equality); kept here so a relay does
// not have to load the YAML parser to validate an id.
export const REQUIREMENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

const MAX_PLATFORM_ENTRIES = 8
const MAX_AGENT_COMMANDS = 16
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
function toPlatforms(platforms: RequirementPlatform[] | undefined): {
  platforms?: RequirementPlatform[]
} {
  return platforms ? { platforms: platforms.map((entry) => ({ ...entry })) } : {}
}

export function toProbeRequests(requirements: EnvironmentRequirement[]): RequirementProbeRequest[] {
  const requests: RequirementProbeRequest[] = []
  for (const requirement of requirements) {
    if (!isEvaluatedRequirement(requirement)) {
      continue
    }
    const base = { id: requirement.id, ...toPlatforms(requirement.platforms) }
    switch (requirement.kind) {
      case 'command': {
        const range = requirement.versionRange
        requests.push({
          ...base,
          kind: 'command',
          name: requirement.name,
          versionArg: requirement.versionArg,
          version: !range ? 'none' : range.status === 'supported' ? 'wanted' : 'unsupported'
        })
        break
      }
      case 'agent':
        requests.push({
          ...base,
          kind: 'agent',
          provider: requirement.provider,
          commands: KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter(
            (command) => command.id === requirement.provider
          ).map((command) => ({ ...command }))
        })
        break
      case 'platform':
        requests.push({
          ...base,
          kind: 'platform',
          ...(requirement.os ? { os: requirement.os } : {}),
          ...(requirement.arch ? { arch: requirement.arch } : {})
        })
        break
      case 'env':
        requests.push({ ...base, kind: 'env', name: requirement.name })
        break
      case 'credential':
        requests.push({ ...base, kind: 'credential', provider: requirement.provider })
        break
    }
  }
  return requests
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function parsePlatformEntry(value: unknown): RequirementPlatform | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const { os, arch } = record
  if (
    (os !== undefined && !isOneOf(REQUIREMENT_OS_VALUES, os)) ||
    (arch !== undefined && !isOneOf(REQUIREMENT_ARCH_VALUES, arch))
  ) {
    return null
  }
  if (os === undefined && arch === undefined) {
    return null
  }
  return {
    ...(os !== undefined ? { os } : {}),
    ...(arch !== undefined ? { arch } : {})
  } as RequirementPlatform
}

function parsePlatforms(value: unknown): RequirementPlatform[] | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLATFORM_ENTRIES) {
    return null
  }
  const entries = value.map(parsePlatformEntry)
  return entries.every((entry) => entry !== null) ? (entries as RequirementPlatform[]) : null
}

function isProbeName(value: unknown): value is string {
  return typeof value === 'string' && COMMAND_NAME_PATTERN.test(value)
}

function parseAgentCommands(value: unknown): TuiAgentDetectionCommand[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AGENT_COMMANDS) {
    return null
  }
  const commands: TuiAgentDetectionCommand[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record || typeof record.id !== 'string' || !PROVIDER_PATTERN.test(record.id)) {
      return null
    }
    if (!isProbeName(record.cmd)) {
      return null
    }
    const required = record.requiredCommands
    if (
      required !== undefined &&
      !(
        Array.isArray(required) &&
        required.length <= MAX_AGENT_COMMANDS &&
        required.every(isProbeName)
      )
    ) {
      return null
    }
    const unsupported = record.unsupportedRuntimes
    if (
      unsupported !== undefined &&
      !(
        Array.isArray(unsupported) &&
        unsupported.length <= MAX_PLATFORM_ENTRIES &&
        unsupported.every(
          (runtime) => typeof runtime === 'string' && PROVIDER_PATTERN.test(runtime)
        )
      )
    ) {
      return null
    }
    commands.push({
      id: record.id as TuiAgentDetectionCommand['id'],
      cmd: record.cmd,
      ...(required ? { requiredCommands: [...(required as string[])] } : {}),
      ...(unsupported
        ? {
            unsupportedRuntimes: [
              ...(unsupported as string[])
            ] as TuiAgentDetectionCommand['unsupportedRuntimes']
          }
        : {})
    })
  }
  return commands
}

function parseProbeRequest(value: unknown): RequirementProbeRequest | null {
  const record = asRecord(value)
  if (!record || typeof record.id !== 'string' || !REQUIREMENT_ID_PATTERN.test(record.id)) {
    return null
  }
  const platforms = parsePlatforms(record.platforms)
  if (platforms === null) {
    return null
  }
  const base = { id: record.id, ...(platforms ? { platforms } : {}) }
  switch (record.kind) {
    case 'command':
      return isProbeName(record.name) &&
        isOneOf<RequirementVersionArg>(VERSION_ARGS, record.versionArg) &&
        isOneOf(['none', 'wanted', 'unsupported'] as const, record.version)
        ? {
            ...base,
            kind: 'command',
            name: record.name,
            versionArg: record.versionArg,
            version: record.version
          }
        : null
    case 'env':
      return typeof record.name === 'string' && ENV_NAME_PATTERN.test(record.name)
        ? { ...base, kind: 'env', name: record.name }
        : null
    case 'credential':
      return isOneOf<CredentialRequirement['provider']>(
        REQUIREMENT_CREDENTIAL_PROVIDERS,
        record.provider
      )
        ? { ...base, kind: 'credential', provider: record.provider }
        : null
    case 'platform': {
      const os = record.os
      const arch = record.arch
      if (
        (os !== undefined && !isOneOf(REQUIREMENT_OS_VALUES, os)) ||
        (arch !== undefined && !isOneOf(REQUIREMENT_ARCH_VALUES, arch))
      ) {
        return null
      }
      return {
        ...base,
        kind: 'platform',
        ...(os !== undefined ? { os } : {}),
        ...(arch !== undefined ? { arch } : {})
      }
    }
    case 'agent': {
      const commands = parseAgentCommands(record.commands)
      return commands &&
        typeof record.provider === 'string' &&
        PROVIDER_PATTERN.test(record.provider)
        ? { ...base, kind: 'agent', provider: record.provider, commands }
        : null
    }
    default:
      return null
  }
}

// Strict: any bad entry rejects the whole request, so a relay answers -32602 instead of a partial result.
export function parseProbeRequests(value: unknown): RequirementProbeRequest[] | null {
  if (!Array.isArray(value) || value.length > MAX_REQUIREMENTS_PER_REQUEST) {
    return null
  }
  const requests: RequirementProbeRequest[] = []
  for (const entry of value) {
    const request = parseProbeRequest(entry)
    if (!request) {
      return null
    }
    requests.push(request)
  }
  return requests
}
