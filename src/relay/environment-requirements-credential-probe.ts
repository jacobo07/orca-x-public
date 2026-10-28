import { buildRelayCommandEnv } from './relay-command-env'
import {
  PROBE_TIMEOUT_MS,
  capProbeOutput,
  decideProbeExecution,
  isCredentialAuthenticated
} from '../shared/environment-requirement-probe-core'
import type { EnvironmentRequirementsDeps } from './environment-requirements-handler'
import type {
  MeasuredPlatform,
  RequirementProbeRequest,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

export type ProbeResolved =
  | { kind: 'absent' }
  | { kind: 'failed'; reason: string }
  | { kind: 'ok'; realPath: string; workspaceRealPath: string }

export type ProbeContext = {
  deps: EnvironmentRequirementsDeps
  host: MeasuredPlatform
  resolve: (name: string) => Promise<ProbeResolved>
}

export function relayExecOptions(deps: EnvironmentRequirementsDeps): Record<string, unknown> {
  // No `shell`: a resolved real path is executed directly with a closed argument list.
  return {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    env: buildRelayCommandEnv(deps.env, deps.platform)
  }
}

// Sign-in state of gh/glab on the relay host. Only a boolean leaves: the CLI's output is read here,
// for its own success marker, and dropped.
export async function probeCredential(
  request: Extract<RequirementProbeRequest, { kind: 'credential' }>,
  context: ProbeContext
): Promise<RequirementProbeResult> {
  const { id } = request
  const resolved = await context.resolve(request.provider)
  if (resolved.kind === 'absent') {
    return { id, outcome: 'absent', reason: 'credential-cli-absent' }
  }
  if (resolved.kind === 'failed') {
    return { id, outcome: 'failed', reason: resolved.reason }
  }
  const decision = decideProbeExecution({
    resolvedRealPath: resolved.realPath,
    workspaceRealPath: resolved.workspaceRealPath,
    platform: context.deps.platform,
    wantsVersion: true
  })
  if (!decision.execute) {
    return decision.outcome === 'refused'
      ? { id, outcome: 'refused', reason: decision.reason }
      : { id, outcome: 'failed', reason: 'credential-cli-unusable' }
  }
  try {
    await context.deps.execFile(
      resolved.realPath,
      ['auth', 'status'],
      relayExecOptions(context.deps)
    )
    return { id, outcome: 'found', authenticated: true }
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string }
    // Why: a numeric code means the CLI ran and said no; anything else means it never answered.
    if (typeof failure.code !== 'number') {
      return { id, outcome: 'failed', reason: 'probe-failed' }
    }
    const authenticated = isCredentialAuthenticated(request.provider, {
      exitedZero: false,
      output: capProbeOutput(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}`)
    })
    return { id, outcome: 'found', authenticated }
  }
}
