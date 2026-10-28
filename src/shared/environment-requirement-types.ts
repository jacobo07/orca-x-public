import type { TuiAgentDetectionCommand } from './tui-agent-detection-commands'

export const EVALUATED_REQUIREMENT_KINDS = [
  'command',
  'agent',
  'platform',
  'env',
  'credential'
] as const
export type EvaluatedRequirementKind = (typeof EVALUATED_REQUIREMENT_KINDS)[number]

export const REQUIREMENT_OS_VALUES = ['linux', 'darwin', 'win32'] as const
export const REQUIREMENT_ARCH_VALUES = ['x64', 'arm64'] as const
export const REQUIREMENT_CREDENTIAL_PROVIDERS = ['gh', 'glab'] as const

export type RequirementPlatform = {
  os?: (typeof REQUIREMENT_OS_VALUES)[number]
  arch?: (typeof REQUIREMENT_ARCH_VALUES)[number]
}

export type VersionComparator = {
  op: '>=' | '>' | '<=' | '<' | '='
  version: readonly [number, number, number]
}

export type RequirementVersionRange =
  | { status: 'supported'; raw: string; comparators: VersionComparator[] }
  | { status: 'unsupported'; raw: string }

export const REQUIREMENT_VERSION_ARGS = ['--version', '-v', '-V', 'version'] as const
export type RequirementVersionArg = (typeof REQUIREMENT_VERSION_ARGS)[number]

// Names, never paths: a command is looked up, so it must not carry a separator or shell syntax.
export const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/

type RequirementCommon = {
  id: string
  platforms?: RequirementPlatform[]
  // Why: kept verbatim (no trim) because these are the exact bytes an approval hashes.
  prepare?: string
  description?: string
}

export type CommandRequirement = RequirementCommon & {
  kind: 'command'
  name: string
  versionRange?: RequirementVersionRange
  versionArg: RequirementVersionArg
}
export type AgentRequirement = RequirementCommon & { kind: 'agent'; provider: string }
export type PlatformRequirement = RequirementCommon & {
  kind: 'platform'
  os?: RequirementPlatform['os']
  arch?: RequirementPlatform['arch']
}
export type EnvRequirement = RequirementCommon & { kind: 'env'; name: string }
export type CredentialRequirement = RequirementCommon & {
  kind: 'credential'
  provider: (typeof REQUIREMENT_CREDENTIAL_PROVIDERS)[number]
}

export type EvaluatedRequirement =
  | CommandRequirement
  | AgentRequirement
  | PlatformRequirement
  | EnvRequirement
  | CredentialRequirement

// A kind this Orca does not know: kept so it classifies unknown, never dropped.
export type UnsupportedRequirement = { id: string; kind: string; unsupportedByThisOrca: true }
// A known kind whose fields failed validation: kept beside its diagnostic, never omitted.
export type MalformedRequirement = { id: string; kind: string; malformed: true }

export type EnvironmentRequirement =
  | EvaluatedRequirement
  | UnsupportedRequirement
  | MalformedRequirement

export function isEvaluatedRequirement(
  requirement: EnvironmentRequirement
): requirement is EvaluatedRequirement {
  return !('unsupportedByThisOrca' in requirement) && !('malformed' in requirement)
}

export type RequirementDiagnostic = { index: number; field?: string; message: string }

export type RequirementsUnparseableReason =
  | 'yaml-error'
  | 'too-large'
  | 'not-a-list'
  | 'too-many-entries'

export type RequirementsParseResult =
  | {
      status: 'parsed'
      requirements: EnvironmentRequirement[]
      diagnostics: RequirementDiagnostic[]
    }
  | { status: 'absent' }
  | { status: 'unparseable'; reason: RequirementsUnparseableReason }

// What a probe executor is asked to measure: the evaluated rows reduced to what a host needs, so a
// relay stays catalog-free (the client sends the agent's detection commands) and never sees prose.
export type RequirementVersionDemand = 'none' | 'wanted' | 'unsupported'
type ProbeRequestBase = { id: string; platforms?: RequirementPlatform[] }
export type RequirementProbeRequest =
  | (ProbeRequestBase & {
      kind: 'command'
      name: string
      versionArg: RequirementVersionArg
      version: RequirementVersionDemand
    })
  | (ProbeRequestBase & {
      kind: 'agent'
      provider: string
      commands: TuiAgentDetectionCommand[]
    })
  | (ProbeRequestBase & {
      kind: 'platform'
      os?: RequirementPlatform['os']
      arch?: RequirementPlatform['arch']
    })
  | (ProbeRequestBase & { kind: 'env'; name: string })
  | (ProbeRequestBase & { kind: 'credential'; provider: CredentialRequirement['provider'] })

export type RequirementProbeOutcome = 'found' | 'absent' | 'skipped-platform' | 'refused' | 'failed'

// Only the version string, the resolved path and booleans may leave a host: no field here can hold
// an env value or command output.
export type RequirementProbeResult = {
  id: string
  outcome: RequirementProbeOutcome
  resolvedPath?: string
  version?: string
  present?: boolean
  authenticated?: boolean
  reason?: string
}

export type MeasuredPlatform = { os: string; arch: string }

// Why: unreachable (and every other non-measured status) is never "measured with nothing".
export type HostMeasurement =
  | {
      status: 'measured'
      at: number
      hostKey: string
      platform: MeasuredPlatform
      probes: RequirementProbeResult[]
    }
  | {
      status: 'unreachable' | 'host-predates-probes' | 'refused' | 'timed-out'
      at: number
      hostKey: string
      detail: string
    }
