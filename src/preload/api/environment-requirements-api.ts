import type {
  PrepareHostRefusalReason,
  RunPrepareStepRequest
} from '../../shared/environment-prepare-run-result'
import type { EnvironmentRequirementsMeasurement } from '../../shared/environment-requirements-measurement'

/** Reads the repo's orca.yaml requirements and measures them on the host that owns the repo. */
export type EnvironmentRequirementsApi = {
  environment: {
    measureRequirements: (args: { repoId: string }) => Promise<EnvironmentRequirementsMeasurement>
    // Names a requirement and an approval hash; the host re-reads orca.yaml and runs only that text.
    runPrepareStep: (
      args: { repoId: string } & RunPrepareStepRequest
    ) => Promise<{ status: 'started' } | { status: 'refused'; reason: PrepareHostRefusalReason }>
  }
}
