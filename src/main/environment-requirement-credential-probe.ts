import {
  PROBE_TIMEOUT_MS,
  capProbeOutput,
  decideProbeExecution,
  isCredentialAuthenticated
} from '../shared/environment-requirement-probe-core'
import type { LocalProbeContext } from './environment-requirement-local-probe'
import type {
  RequirementProbeRequest,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

type CredentialRequest = Extract<RequirementProbeRequest, { kind: 'credential' }>

// Sign-in state of gh/glab on this host. Only a boolean leaves: the CLI's output is read here, for
// its own success marker, and dropped.
export async function probeCredentialLocally(
  request: CredentialRequest,
  context: LocalProbeContext
): Promise<RequirementProbeResult> {
  const { id } = request
  const resolved = await context.resolveForProbe(request.provider)
  if (resolved.kind === 'absent') {
    return { id, outcome: 'absent', reason: 'credential-cli-absent' }
  }
  if (resolved.kind === 'failed') {
    return { id, outcome: 'failed', reason: resolved.reason }
  }
  const decision = decideProbeExecution({
    resolvedRealPath: resolved.realPath,
    workspaceRealPath: resolved.workspaceRealPath,
    platform: context.platform,
    wantsVersion: true
  })
  if (!decision.execute) {
    return decision.outcome === 'refused'
      ? { id, outcome: 'refused', reason: decision.reason }
      : { id, outcome: 'failed', reason: 'credential-cli-unusable' }
  }
  try {
    await context.deps.execFile(resolved.realPath, ['auth', 'status'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      env: context.env
    })
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
