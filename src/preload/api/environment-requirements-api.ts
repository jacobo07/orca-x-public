import type { EnvironmentRequirementsMeasurement } from '../../shared/environment-requirements-measurement'

/** Reads the repo's orca.yaml requirements and measures them on the host that owns the repo. */
export type EnvironmentRequirementsApi = {
  environment: {
    measureRequirements: (args: { repoId: string }) => Promise<EnvironmentRequirementsMeasurement>
  }
}
