import { extractFirstVersion } from './environment-version-range'
import {
  COMMAND_NAME_PATTERN,
  ENV_NAME_PATTERN,
  REQUIREMENT_VERSION_ARGS,
  type CredentialRequirement,
  type MeasuredPlatform,
  type RequirementPlatform,
  type RequirementProbeRequest,
  type RequirementProbeResult
} from './environment-requirement-types'

// The closed rules every probe executor (local, WSL, relay) obeys before it runs anything.
export { COMMAND_NAME_PATTERN, ENV_NAME_PATTERN }
export const VERSION_ARGS = REQUIREMENT_VERSION_ARGS
export const PROBE_TIMEOUT_MS = 5000
export const MAX_PROBE_OUTPUT_CHARS = 4096
export const MAX_REQUIREMENTS_PER_REQUEST = 64
export const PROBE_CONCURRENCY = 4

export function capProbeOutput(text: string): string {
  return text.length > MAX_PROBE_OUTPUT_CHARS ? text.slice(0, MAX_PROBE_OUTPUT_CHARS) : text
}

function splitAbsolutePath(value: string, win32: boolean): string[] | null {
  // Why: only a drive or UNC path is absolute on win32; a drive-less `\x` depends on the cwd.
  if (win32 ? !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value) : !value.startsWith('/')) {
    return null
  }
  const text = win32 ? value.replace(/\//g, '\\').toLowerCase() : value
  const segments: string[] = []
  for (const segment of text.split(win32 ? '\\' : '/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments
}

// SSH and WSL hosts are judged by their own path semantics, never the machine running this code.
export function isPathInsideWorkspace(child: string, parent: string, platform: string): boolean {
  const win32 = platform === 'win32'
  const childSegments = splitAbsolutePath(child, win32)
  const parentSegments = splitAbsolutePath(parent, win32)
  // Fail closed: a path that cannot be placed is treated as inside, so it is never executed.
  if (!childSegments || !parentSegments) {
    return true
  }
  return parentSegments.every((segment, index) => childSegments[index] === segment)
}

export type ProbeExecutionDecision =
  | { execute: true }
  | { execute: false; outcome: 'refused'; reason: 'resolves-inside-workspace' }
  | { execute: false; outcome: 'failed'; reason: 'version-probe-needs-shell' }
  | { execute: false; outcome: 'found' }

export function decideProbeExecution(input: {
  resolvedRealPath: string
  workspaceRealPath: string
  platform: string
  wantsVersion: boolean
}): ProbeExecutionDecision {
  const { resolvedRealPath, workspaceRealPath, platform, wantsVersion } = input
  if (isPathInsideWorkspace(resolvedRealPath, workspaceRealPath, platform)) {
    return { execute: false, outcome: 'refused', reason: 'resolves-inside-workspace' }
  }
  // Why: a .cmd/.bat cannot be run without a shell, and a shell would re-parse repo-supplied text.
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(resolvedRealPath)) {
    return wantsVersion
      ? { execute: false, outcome: 'failed', reason: 'version-probe-needs-shell' }
      : { execute: false, outcome: 'found' }
  }
  // Presence needs no execution; only a wanted version is worth running a binary for.
  return wantsVersion ? { execute: true } : { execute: false, outcome: 'found' }
}

function matchesPlatform(entry: RequirementPlatform, host: MeasuredPlatform): boolean | null {
  if ((entry.os && host.os === 'unknown') || (entry.arch && host.arch === 'unknown')) {
    return null
  }
  return (!entry.os || entry.os === host.os) && (!entry.arch || entry.arch === host.arch)
}

// Returns a final result when the platform decides the request, or null when probing should go on.
// A `platform` request is always decided here.
export function platformGateResult(
  request: RequirementProbeRequest,
  host: MeasuredPlatform
): RequirementProbeResult | null {
  const unknown: RequirementProbeResult = {
    id: request.id,
    outcome: 'failed',
    reason: 'platform-unknown'
  }
  if (request.platforms) {
    const verdicts = request.platforms.map((entry) => matchesPlatform(entry, host))
    if (!verdicts.includes(true)) {
      return verdicts.includes(null) ? unknown : { id: request.id, outcome: 'skipped-platform' }
    }
  }
  if (request.kind !== 'platform') {
    return null
  }
  const verdict = matchesPlatform({ os: request.os, arch: request.arch }, host)
  if (verdict === null) {
    return unknown
  }
  return verdict
    ? { id: request.id, outcome: 'found' }
    : { id: request.id, outcome: 'skipped-platform', reason: 'platform-mismatch' }
}

// Only the version string and the resolved path survive; the rest of the output is dropped here.
export function resultFromVersionOutput(
  id: string,
  resolvedPath: string,
  output: string
): RequirementProbeResult {
  const version = extractFirstVersion(capProbeOutput(output))
  return version
    ? { id, outcome: 'found', resolvedPath, version }
    : { id, outcome: 'failed', reason: 'unparseable-version', resolvedPath }
}

export function mapMeasuredArch(unameMachine: string): string {
  const machine = unameMachine.trim().toLowerCase()
  if (machine === 'x86_64' || machine === 'amd64') {
    return 'x64'
  }
  return machine === 'aarch64' || machine === 'arm64' ? 'arm64' : 'unknown'
}

// Mirrors the existing preflight semantics: exit 0, else the CLI's own success marker on the host.
export function isCredentialAuthenticated(
  provider: CredentialRequirement['provider'],
  result: { exitedZero: boolean; output: string }
): boolean {
  if (result.exitedZero) {
    return true
  }
  if (provider === 'gh') {
    return result.output.includes('Logged in') || result.output.includes('Active account: true')
  }
  return result.output.includes('Logged in')
}

export function splitByRequestCap(requests: RequirementProbeRequest[]): {
  accepted: RequirementProbeRequest[]
  overflow: RequirementProbeResult[]
} {
  return {
    accepted: requests.slice(0, MAX_REQUIREMENTS_PER_REQUEST),
    overflow: requests.slice(MAX_REQUIREMENTS_PER_REQUEST).map(
      (request): RequirementProbeResult => ({
        id: request.id,
        outcome: 'failed',
        reason: 'too-many-requirements'
      })
    )
  }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
