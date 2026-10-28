import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayCommandEnv } from './relay-command-env'
import { buildCommandLookupSpecs, resolveCommandPathForRelay } from './preflight-handler'
import { buildEnvPresenceScript, hasEnvPresentMarker } from './environment-requirements-env-script'
import {
  probeCredential,
  relayExecOptions,
  type ProbeContext
} from './environment-requirements-credential-probe'
import {
  COMMAND_NAME_PATTERN,
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  decideProbeExecution,
  mapWithConcurrency,
  platformGateResult,
  resultFromVersionOutput
} from '../shared/environment-requirement-probe-core'
import { parseProbeRequests } from '../shared/environment-requirement-probe-request'
import {
  getTuiAgentDetectionProbeCommands,
  resolveDetectedTuiAgentIds
} from '../shared/tui-agent-detection-commands'
import type {
  MeasuredPlatform,
  RequirementProbeRequest,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

const execFileAsync = promisify(execFile)

export const ENVIRONMENT_REQUIREMENTS_RELAY_CAPABILITY = 'environment.requirements.v1'
export const ENVIRONMENT_REQUIREMENTS_RELAY_CAPABILITIES = [
  ENVIRONMENT_REQUIREMENTS_RELAY_CAPABILITY
] as const

const MAX_WORKSPACE_PATH_LENGTH = 4096

export type EnvironmentRequirementsDeps = {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  accountLoginShell?: string | null
  resolveCommand: (name: string) => Promise<string | null>
  realpath: (target: string) => Promise<string>
  execFile: (
    file: string,
    args: string[],
    options: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>
}

type Request<K extends RequirementProbeRequest['kind']> = Extract<
  RequirementProbeRequest,
  { kind: K }
>

function invalidParams(message: string): Error {
  return Object.assign(new Error(`Invalid params: ${message}`), { code: -32602 })
}

function buildDeps(overrides: Partial<EnvironmentRequirementsDeps> | undefined) {
  const platform = overrides?.platform ?? process.platform
  const env = overrides?.env ?? process.env
  const accountLoginShell = overrides?.accountLoginShell
  const deps: EnvironmentRequirementsDeps = {
    platform,
    arch: process.arch,
    env,
    accountLoginShell,
    resolveCommand: (name) =>
      resolveCommandPathForRelay(name, { platform, env, accountLoginShell }),
    realpath: (target) => realpath(target),
    execFile: (file, args, options) =>
      execFileAsync(file, args, options) as Promise<{ stdout: string; stderr: string }>,
    ...overrides
  }
  return deps
}

async function probeCommand(
  request: Request<'command'>,
  context: ProbeContext
): Promise<RequirementProbeResult> {
  const { id } = request
  if (!COMMAND_NAME_PATTERN.test(request.name)) {
    return { id, outcome: 'failed', reason: 'invalid-name' }
  }
  const resolved = await context.resolve(request.name)
  if (resolved.kind === 'absent') {
    return { id, outcome: 'absent' }
  }
  if (resolved.kind === 'failed') {
    return { id, outcome: 'failed', reason: resolved.reason }
  }
  const decision = decideProbeExecution({
    resolvedRealPath: resolved.realPath,
    workspaceRealPath: resolved.workspaceRealPath,
    platform: context.deps.platform,
    wantsVersion: request.version === 'wanted'
  })
  if (!decision.execute) {
    if (decision.outcome === 'refused') {
      return { id, outcome: 'refused', reason: decision.reason }
    }
    if (decision.outcome === 'failed') {
      return { id, outcome: 'failed', reason: decision.reason, resolvedPath: resolved.realPath }
    }
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
    const { stdout, stderr } = await context.deps.execFile(
      resolved.realPath,
      [request.versionArg],
      relayExecOptions(context.deps)
    )
    return resultFromVersionOutput(id, resolved.realPath, `${stdout}\n${stderr}`)
  } catch {
    return { id, outcome: 'failed', reason: 'probe-failed' }
  }
}

async function probeAgent(
  request: Request<'agent'>,
  context: ProbeContext
): Promise<RequirementProbeResult> {
  const { id } = request
  const found = new Set<string>()
  for (const name of getTuiAgentDetectionProbeCommands(request.commands, context.deps.platform)) {
    const resolved = await context.resolve(name)
    if (resolved.kind === 'absent') {
      continue
    }
    if (resolved.kind === 'failed') {
      return { id, outcome: 'failed', reason: resolved.reason }
    }
    const decision = decideProbeExecution({
      resolvedRealPath: resolved.realPath,
      workspaceRealPath: resolved.workspaceRealPath,
      platform: context.deps.platform,
      wantsVersion: false
    })
    if (!decision.execute && decision.outcome === 'refused') {
      return { id, outcome: 'refused', reason: decision.reason }
    }
    found.add(name)
  }
  return resolveDetectedTuiAgentIds(request.commands, found, context.deps.platform).length > 0
    ? { id, outcome: 'found' }
    : { id, outcome: 'absent' }
}

// Presence in the environment a terminal here would get: the trusted login shell, falling back to
// the next shell spec only when a shell could not run. Null means no shell could answer.
async function readEnvPresence(
  name: string,
  deps: EnvironmentRequirementsDeps
): Promise<boolean | null> {
  if (deps.platform === 'win32') {
    const lower = name.toLowerCase()
    return Object.keys(deps.env).some(
      (key) => key.toLowerCase() === lower && deps.env[key] !== undefined
    )
  }
  for (const spec of buildCommandLookupSpecs(
    'x',
    deps.platform,
    deps.env,
    deps.accountLoginShell
  )) {
    try {
      const { stdout } = await deps.execFile(
        spec.file,
        [spec.args[0], buildEnvPresenceScript(spec.file, name)],
        {
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS,
          env: buildRelayCommandEnv(deps.env, deps.platform)
        }
      )
      return hasEnvPresentMarker(stdout)
    } catch {
      // Try the next shell spec; only "no shell could run" is a lookup failure.
    }
  }
  return null
}

async function probeOne(
  request: RequirementProbeRequest,
  context: ProbeContext
): Promise<RequirementProbeResult> {
  const gated = platformGateResult(request, context.host)
  if (gated) {
    return gated
  }
  switch (request.kind) {
    case 'command':
      return probeCommand(request, context)
    case 'credential':
      return probeCredential(request, context)
    case 'agent':
      return probeAgent(request, context)
    case 'env': {
      const present = await readEnvPresence(request.name, context.deps)
      return present === null
        ? { id: request.id, outcome: 'failed', reason: 'lookup-failed' }
        : { id: request.id, outcome: present ? 'found' : 'absent', present }
    }
    case 'platform':
      return { id: request.id, outcome: 'found' }
  }
}

export class EnvironmentRequirementsHandler {
  private readonly deps: EnvironmentRequirementsDeps

  constructor(dispatcher: RelayDispatcher, deps?: Partial<EnvironmentRequirementsDeps>) {
    this.deps = buildDeps(deps)
    dispatcher.onRequest('environment.measureRequirements', (params) => this.measure(params))
  }

  private async measure(
    params: Record<string, unknown>
  ): Promise<{ platform: MeasuredPlatform; probes: RequirementProbeResult[] }> {
    const { workspacePath } = params
    const requests = parseProbeRequests(params.requirements)
    if (
      typeof workspacePath !== 'string' ||
      workspacePath.length === 0 ||
      workspacePath.length > MAX_WORKSPACE_PATH_LENGTH ||
      workspacePath.includes('\0')
    ) {
      throw invalidParams('workspacePath')
    }
    if (!requests) {
      throw invalidParams('requirements')
    }
    const { deps } = this
    const host: MeasuredPlatform = { os: deps.platform, arch: deps.arch }
    const workspaceRealPath = await deps.realpath(workspacePath).catch(() => null)
    const context: ProbeContext = {
      deps,
      host,
      resolve: async (name) => {
        let resolved: string | null
        try {
          resolved = await deps.resolveCommand(name)
        } catch {
          return { kind: 'failed', reason: 'lookup-failed' }
        }
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
    const probes = await mapWithConcurrency(requests, PROBE_CONCURRENCY, (request) =>
      probeOne(request, context)
    )
    return { platform: host, probes }
  }
}
