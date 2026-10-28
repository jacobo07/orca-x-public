import { buildPosixCommandPathLookupScript } from '../shared/posix-command-path-lookup'
import {
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  capProbeOutput,
  decideProbeExecution,
  isCredentialAuthenticated,
  mapMeasuredArch,
  mapWithConcurrency,
  platformGateResult,
  resultFromVersionOutput,
  COMMAND_NAME_PATTERN,
  ENV_NAME_PATTERN
} from '../shared/environment-requirement-probe-core'
import {
  getTuiAgentDetectionProbeCommands,
  resolveDetectedTuiAgentIds
} from '../shared/tui-agent-detection-commands'
import { shellQuote } from './ipc/preflight-command-exec'
import { runPreflightCommandInWsl } from './ipc/preflight-wsl-command'
import type { WslPreflightTarget } from './ipc/preflight-wsl-agent-detection'
import type {
  MeasuredPlatform,
  RequirementProbeRequest,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

const MARK = '__ORCA_ENVPROBE__'
// Why: one cold wsl.exe start plus a lookup of every name needs more than a single probe's 5 s.
const WSL_LOOKUP_TIMEOUT_MS = 10_000
const UNKNOWN_PLATFORM: MeasuredPlatform = { os: 'unknown', arch: 'unknown' }

export type WslProbeDeps = {
  exec: (
    target: WslPreflightTarget,
    script: string,
    timeoutMs: number
  ) => Promise<{ stdout: string; stderr: string }>
}

type WslLookup = {
  machine: string
  workspaceReal: string | null
  commands: Map<string, { resolved: string; real: string }>
  env: Set<string>
}

function lookupNames(requests: RequirementProbeRequest[]): string[] {
  const names = new Set<string>()
  for (const request of requests) {
    if (request.kind === 'command') {
      names.add(request.name)
    } else if (request.kind === 'credential') {
      names.add(request.provider)
    } else if (request.kind === 'agent') {
      for (const name of getTuiAgentDetectionProbeCommands(request.commands, 'wsl')) {
        names.add(name)
      }
    }
  }
  return [...names].filter((name) => COMMAND_NAME_PATTERN.test(name))
}

function buildLookupScript(requests: RequirementProbeRequest[], workspacePath: string): string {
  const names = lookupNames(requests)
  const envNames = [
    ...new Set(requests.flatMap((request) => (request.kind === 'env' ? [request.name] : [])))
  ].filter((name) => ENV_NAME_PATTERN.test(name))
  const lines: string[] = []
  if (names.length > 0) {
    lines.push(
      `for cmd in ${names.map(shellQuote).join(' ')}; do`,
      buildPosixCommandPathLookupScript({ kind: 'shell-variable', name: 'cmd' }),
      'if [ -n "$resolved" ]; then',
      'real=$(readlink -f -- "$resolved" 2>/dev/null)',
      `printf '${MARK}C\\t%s\\t%s\\t%s\\n' "$cmd" "$resolved" "$real"`,
      'fi',
      'done'
    )
  }
  for (const name of envNames) {
    // Why: presence only; the variable's value is never expanded into output.
    lines.push(`if [ -n "\${${name}+x}" ]; then printf '${MARK}E\\t${name}\\n'; fi`)
  }
  lines.push(
    `printf '${MARK}U\\t%s\\n' "$(uname -m)"`,
    `printf '${MARK}W\\t%s\\n' "$(readlink -f -- ${shellQuote(workspacePath)} 2>/dev/null)"`
  )
  return lines.join('\n')
}

function isPosixAbsolute(value: string): boolean {
  return value.startsWith('/')
}

function parseLookup(stdout: string): WslLookup {
  const lookup: WslLookup = {
    machine: '',
    workspaceReal: null,
    commands: new Map(),
    env: new Set()
  }
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(MARK)) {
      continue
    }
    const [kind, ...fields] = line.slice(MARK.length).split('\t')
    if (kind === 'U') {
      lookup.machine = fields[0] ?? ''
    } else if (kind === 'W' && fields[0] && isPosixAbsolute(fields[0])) {
      lookup.workspaceReal = fields[0]
    } else if (kind === 'E' && fields[0]) {
      lookup.env.add(fields[0])
    } else if (kind === 'C' && fields.length >= 3) {
      const [name, resolved, real] = fields
      // Why: a real guest executable resolves to a POSIX-absolute path; anything else is spoofed output.
      if (isPosixAbsolute(resolved) && isPosixAbsolute(real)) {
        lookup.commands.set(name, { resolved, real })
      }
    }
  }
  return lookup
}

async function runInWsl(
  deps: WslProbeDeps,
  target: WslPreflightTarget,
  script: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null; ran: boolean }> {
  try {
    const out = await deps.exec(target, script, PROBE_TIMEOUT_MS)
    return { ...out, exitCode: 0, ran: true }
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string }
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      // Why: a numeric code means the program ran and exited; anything else is a launch/timeout failure.
      ran: typeof failure.code === 'number'
    }
  }
}

type WslContext = {
  deps: WslProbeDeps
  target: WslPreflightTarget
  lookup: WslLookup
  platform: MeasuredPlatform
}

async function probeCommandInWsl(
  request: Extract<RequirementProbeRequest, { kind: 'command' }>,
  context: WslContext
): Promise<RequirementProbeResult> {
  const { id } = request
  const hit = context.lookup.commands.get(request.name)
  if (!hit) {
    return { id, outcome: 'absent' }
  }
  const { workspaceReal } = context.lookup
  if (!workspaceReal) {
    return { id, outcome: 'failed', reason: 'workspace-unreadable' }
  }
  const wantsVersion = request.version === 'wanted'
  const decision = decideProbeExecution({
    resolvedRealPath: hit.real,
    workspaceRealPath: workspaceReal,
    platform: 'linux',
    wantsVersion
  })
  if (!decision.execute) {
    if (decision.outcome === 'refused') {
      return { id, outcome: 'refused', reason: decision.reason }
    }
    if (decision.outcome === 'failed') {
      return { id, outcome: 'failed', reason: decision.reason, resolvedPath: hit.real }
    }
    return request.version === 'unsupported'
      ? { id, outcome: 'failed', reason: 'unsupported-version-range', resolvedPath: hit.real }
      : { id, outcome: 'found', resolvedPath: hit.real }
  }
  const run = await runInWsl(
    context.deps,
    context.target,
    `${shellQuote(hit.real)} ${shellQuote(request.versionArg)}`
  )
  return run.ran && run.exitCode === 0
    ? resultFromVersionOutput(id, hit.real, `${run.stdout}\n${run.stderr}`)
    : { id, outcome: 'failed', reason: 'probe-failed' }
}

async function probeCredentialInWsl(
  request: Extract<RequirementProbeRequest, { kind: 'credential' }>,
  context: WslContext
): Promise<RequirementProbeResult> {
  const { id } = request
  const hit = context.lookup.commands.get(request.provider)
  if (!hit) {
    return { id, outcome: 'absent', reason: 'credential-cli-absent' }
  }
  const { workspaceReal } = context.lookup
  if (!workspaceReal) {
    return { id, outcome: 'failed', reason: 'workspace-unreadable' }
  }
  const decision = decideProbeExecution({
    resolvedRealPath: hit.real,
    workspaceRealPath: workspaceReal,
    platform: 'linux',
    wantsVersion: true
  })
  if (!decision.execute) {
    return decision.outcome === 'refused'
      ? { id, outcome: 'refused', reason: decision.reason }
      : { id, outcome: 'failed', reason: 'credential-cli-unusable' }
  }
  const run = await runInWsl(context.deps, context.target, `${shellQuote(hit.real)} auth status`)
  if (!run.ran) {
    return { id, outcome: 'failed', reason: 'probe-failed' }
  }
  // Output is read on the host for the CLI's own marker and then discarded.
  const authenticated = isCredentialAuthenticated(request.provider, {
    exitedZero: run.exitCode === 0,
    output: capProbeOutput(`${run.stdout}\n${run.stderr}`)
  })
  return { id, outcome: 'found', authenticated }
}

function probeAgentInWsl(
  request: Extract<RequirementProbeRequest, { kind: 'agent' }>,
  context: WslContext
): RequirementProbeResult {
  const { id } = request
  const found = new Set<string>()
  for (const name of getTuiAgentDetectionProbeCommands(request.commands, 'wsl')) {
    const hit = context.lookup.commands.get(name)
    if (!hit) {
      continue
    }
    if (!context.lookup.workspaceReal) {
      return { id, outcome: 'failed', reason: 'workspace-unreadable' }
    }
    const decision = decideProbeExecution({
      resolvedRealPath: hit.real,
      workspaceRealPath: context.lookup.workspaceReal,
      platform: 'linux',
      wantsVersion: false
    })
    if (!decision.execute && decision.outcome === 'refused') {
      return { id, outcome: 'refused', reason: decision.reason }
    }
    found.add(name)
  }
  return resolveDetectedTuiAgentIds(request.commands, found, 'wsl').length > 0
    ? { id, outcome: 'found' }
    : { id, outcome: 'absent' }
}

async function probeOneInWsl(
  request: RequirementProbeRequest,
  context: WslContext
): Promise<RequirementProbeResult> {
  const gated = platformGateResult(request, context.platform)
  if (gated) {
    return gated
  }
  switch (request.kind) {
    case 'command':
      return COMMAND_NAME_PATTERN.test(request.name)
        ? probeCommandInWsl(request, context)
        : { id: request.id, outcome: 'failed', reason: 'invalid-name' }
    case 'credential':
      return probeCredentialInWsl(request, context)
    case 'agent':
      return probeAgentInWsl(request, context)
    case 'env': {
      const present = context.lookup.env.has(request.name)
      return { id: request.id, outcome: present ? 'found' : 'absent', present }
    }
    case 'platform':
      return { id: request.id, outcome: 'found' }
  }
}

const defaultDeps: WslProbeDeps = { exec: runPreflightCommandInWsl }

// `workspacePath` is a path inside the distro; the caller converts a Windows path first.
export async function measureRequestsInWsl(input: {
  requests: RequirementProbeRequest[]
  workspacePath: string
  target: WslPreflightTarget
  deps?: Partial<WslProbeDeps>
}): Promise<{ platform: MeasuredPlatform; probes: RequirementProbeResult[] }> {
  const deps: WslProbeDeps = { ...defaultDeps, ...input.deps }
  const script = buildLookupScript(input.requests, input.workspacePath)
  let stdout: string
  try {
    // One lookup script per measurement keeps a cold wsl.exe start from being paid per name.
    stdout = (await deps.exec(input.target, script, WSL_LOOKUP_TIMEOUT_MS)).stdout
  } catch {
    return {
      platform: UNKNOWN_PLATFORM,
      probes: input.requests.map((request) => ({
        id: request.id,
        outcome: 'failed',
        reason: 'lookup-failed'
      }))
    }
  }
  const lookup = parseLookup(stdout)
  const platform: MeasuredPlatform = { os: 'linux', arch: mapMeasuredArch(lookup.machine) }
  const context: WslContext = { deps, target: input.target, lookup, platform }
  const probes = await mapWithConcurrency(input.requests, PROBE_CONCURRENCY, (request) =>
    probeOneInWsl(request, context)
  )
  return { platform, probes }
}
