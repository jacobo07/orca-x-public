import { execFile, type ExecFileOptions } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  COMMAND_NAME_PATTERN,
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  decideProbeExecution,
  mapWithConcurrency,
  platformGateResult,
  resultFromVersionOutput,
  splitByRequestCap
} from '../shared/environment-requirement-probe-core'
import { toProbeRequests } from '../shared/environment-requirement-probe-request'
import {
  getTuiAgentDetectionProbeCommands,
  resolveDetectedTuiAgentIds
} from '../shared/tui-agent-detection-commands'
import { resolveCommandOnLocalPath } from './ipc/command-path-resolver'
import { buildLocalPreflightEnv } from './ipc/preflight-local-env'
import { probeCredentialLocally } from './environment-requirement-credential-probe'
import { measureRequestsInWsl } from './environment-requirement-wsl-probe'
import type { WslPreflightTarget } from './ipc/preflight-wsl-agent-detection'
import type {
  EnvironmentRequirement,
  HostMeasurement,
  MeasuredPlatform,
  RequirementProbeRequest,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

const execFileAsync = promisify(execFile)

export type LocalProbeDeps = {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  now: () => number
  resolveCommand: (name: string) => Promise<string | null>
  realpath: (target: string) => Promise<string>
  execFile: (
    file: string,
    args: string[],
    options: ExecFileOptions
  ) => Promise<{ stdout: string; stderr: string }>
}

export type ResolvedForProbe =
  | { kind: 'absent' }
  | { kind: 'failed'; reason: string }
  | { kind: 'ok'; realPath: string; workspaceRealPath: string }

export type LocalProbeContext = {
  platform: NodeJS.Platform
  hostPlatform: MeasuredPlatform
  env: NodeJS.ProcessEnv
  deps: LocalProbeDeps
  resolveForProbe: (name: string) => Promise<ResolvedForProbe>
}

type Request<K extends RequirementProbeRequest['kind']> = Extract<
  RequirementProbeRequest,
  { kind: K }
>

function buildDeps(overrides: Partial<LocalProbeDeps> | undefined): LocalProbeDeps {
  const platform = overrides?.platform ?? process.platform
  const env = overrides?.env ?? buildLocalPreflightEnv() ?? process.env
  return {
    platform,
    arch: process.arch,
    env,
    now: Date.now,
    // Why: the current directory can be repo content, and what resolves here is later executed.
    resolveCommand: (name) =>
      resolveCommandOnLocalPath(name, { platform, env, searchCurrentDirectory: false }),
    realpath: (target) => realpath(target),
    execFile: (file, args, options) =>
      execFileAsync(file, args, options) as Promise<{ stdout: string; stderr: string }>,
    ...overrides
  }
}

function isEnvPresent(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') {
    return env[name] !== undefined
  }
  const lower = name.toLowerCase()
  return Object.keys(env).some((key) => key.toLowerCase() === lower && env[key] !== undefined)
}

async function probeCommand(
  request: Request<'command'>,
  context: LocalProbeContext
): Promise<RequirementProbeResult> {
  const { id } = request
  if (!COMMAND_NAME_PATTERN.test(request.name)) {
    return { id, outcome: 'failed', reason: 'invalid-name' }
  }
  const resolved = await context.resolveForProbe(request.name)
  if (resolved.kind === 'absent') {
    return { id, outcome: 'absent' }
  }
  if (resolved.kind === 'failed') {
    return { id, outcome: 'failed', reason: resolved.reason }
  }
  const decision = decideProbeExecution({
    resolvedRealPath: resolved.realPath,
    workspaceRealPath: resolved.workspaceRealPath,
    platform: context.platform,
    wantsVersion: request.version === 'wanted'
  })
  if (!decision.execute) {
    if (decision.outcome === 'refused') {
      return { id, outcome: 'refused', reason: decision.reason }
    }
    if (decision.outcome === 'failed') {
      return { id, outcome: 'failed', reason: decision.reason, resolvedPath: resolved.realPath }
    }
    // Why: a range this Orca cannot evaluate must read unknown, not satisfied.
    return request.version === 'unsupported'
      ? {
          id,
          outcome: 'failed',
          reason: 'unsupported-version-range',
          resolvedPath: resolved.realPath
        }
      : { id, outcome: 'found', resolvedPath: resolved.realPath }
  }
  try {
    // No shell: the resolved real path is executed directly with one closed argument.
    const { stdout, stderr } = await context.deps.execFile(
      resolved.realPath,
      [request.versionArg],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: context.env }
    )
    return resultFromVersionOutput(id, resolved.realPath, `${stdout}\n${stderr}`)
  } catch {
    return { id, outcome: 'failed', reason: 'probe-failed' }
  }
}

async function probeAgent(
  request: Request<'agent'>,
  context: LocalProbeContext
): Promise<RequirementProbeResult> {
  const { id } = request
  const found = new Set<string>()
  for (const name of getTuiAgentDetectionProbeCommands(request.commands, context.platform)) {
    const resolved = await context.resolveForProbe(name)
    if (resolved.kind === 'absent') {
      continue
    }
    if (resolved.kind === 'failed') {
      return { id, outcome: 'failed', reason: resolved.reason }
    }
    const decision = decideProbeExecution({
      resolvedRealPath: resolved.realPath,
      workspaceRealPath: resolved.workspaceRealPath,
      platform: context.platform,
      wantsVersion: false
    })
    if (!decision.execute && decision.outcome === 'refused') {
      return { id, outcome: 'refused', reason: decision.reason }
    }
    found.add(name)
  }
  return resolveDetectedTuiAgentIds(request.commands, found, context.platform).length > 0
    ? { id, outcome: 'found' }
    : { id, outcome: 'absent' }
}

async function probeOne(
  request: RequirementProbeRequest,
  context: LocalProbeContext
): Promise<RequirementProbeResult> {
  const gated = platformGateResult(request, context.hostPlatform)
  if (gated) {
    return gated
  }
  switch (request.kind) {
    case 'command':
      return probeCommand(request, context)
    case 'agent':
      return probeAgent(request, context)
    case 'credential':
      return probeCredentialLocally(request, context)
    case 'env': {
      // Presence only: the value is never read into a result.
      const present = isEnvPresent(context.env, request.name, context.platform)
      return { id: request.id, outcome: present ? 'found' : 'absent', present }
    }
    case 'platform':
      return { id: request.id, outcome: 'found' }
  }
}

export async function measureRequirementsLocally(input: {
  requirements: EnvironmentRequirement[]
  workspacePath: string
  hostKey: string
  wslTarget?: WslPreflightTarget | null
  deps?: Partial<LocalProbeDeps>
}): Promise<HostMeasurement> {
  const deps = buildDeps(input.deps)
  const { accepted, overflow } = splitByRequestCap(toProbeRequests(input.requirements))
  if (input.wslTarget) {
    const wsl = await measureRequestsInWsl({
      requests: accepted,
      workspacePath: input.workspacePath,
      target: input.wslTarget
    })
    return {
      status: 'measured',
      at: deps.now(),
      hostKey: input.hostKey,
      platform: wsl.platform,
      probes: [...wsl.probes, ...overflow]
    }
  }
  const hostPlatform: MeasuredPlatform = { os: deps.platform, arch: deps.arch }
  const workspaceRealPath = await deps.realpath(input.workspacePath).catch(() => null)
  const context: LocalProbeContext = {
    platform: deps.platform,
    hostPlatform,
    env: deps.env,
    deps,
    resolveForProbe: async (name) => {
      const resolved = await deps.resolveCommand(name)
      if (!resolved) {
        return { kind: 'absent' }
      }
      if (!workspaceRealPath) {
        return { kind: 'failed', reason: 'workspace-unreadable' }
      }
      try {
        return { kind: 'ok', realPath: await deps.realpath(resolved), workspaceRealPath }
      } catch {
        return { kind: 'failed', reason: 'resolve-failed' }
      }
    }
  }
  const probes = await mapWithConcurrency(accepted, PROBE_CONCURRENCY, (request) =>
    probeOne(request, context)
  )
  return {
    status: 'measured',
    at: deps.now(),
    hostKey: input.hostKey,
    platform: hostPlatform,
    probes: [...probes, ...overflow]
  }
}
