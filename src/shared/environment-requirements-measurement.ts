import type {
  EnvironmentRequirement,
  HostMeasurement,
  RequirementDiagnostic
} from './environment-requirement-types'

export type ContractSource = { hostKey: string; path: string; contentHash: string }
export type ContractReadState = 'parsed' | 'absent' | 'unreadable' | 'unparseable'

export type EnvironmentRequirementsMeasurement = {
  // Null when no bytes were read (the file is absent or could not be read).
  contractSource: ContractSource | null
  contract: ContractReadState
  requirements: EnvironmentRequirement[]
  diagnostics: RequirementDiagnostic[]
  measurement: HostMeasurement
}

// What a client learns from asking a host; an old host is a named answer, never an empty measurement.
export type RequirementsMeasurementOutcome =
  | { status: 'measured'; result: EnvironmentRequirementsMeasurement }
  | { status: 'host-predates-probes'; detail: 'method-not-found' }
