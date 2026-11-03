import { randomUUID } from 'node:crypto'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { readHeadlessCoordinator } from './headless-coordinator-env'

export function createOrchestrationCompatibilityEnvelope(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope {
  const headless = readHeadlessCoordinator(env)
  if (headless) {
    // Why no evidence: a headless caller is not a terminal, and evidence attested for the shell
    // that launched it would fence or misroute the headless identity (K4).
    return {
      compatibilityInvocationId: randomUUID(),
      ...(headless.token ? { orchestrationCoordinatorToken: headless.token } : {}),
      ...(headless.newToken ? { orchestrationNewCoordinatorToken: headless.newToken } : {})
    }
  }
  return {
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence: readOrchestrationCompatibilityEvidence(env)
  }
}
