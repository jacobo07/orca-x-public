import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  measureRequirementsLocally,
  type LocalProbeDeps
} from './environment-requirement-local-probe'
import { resolveCommandOnLocalPath } from './ipc/command-path-resolver'
import { buildLocalPreflightEnv } from './ipc/preflight-local-env'
import type {
  EnvironmentRequirement,
  HostMeasurement,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

type ExecCall = { file: string; args: string[]; options: Record<string, unknown> }

function fakeDeps(options: {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  resolve?: Record<string, string>
  exec?: (call: ExecCall) => Promise<{ stdout: string; stderr: string }>
  workspaceReal?: string | Error
}): { deps: Partial<LocalProbeDeps>; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const workspace = '/work/project'
  const deps: Partial<LocalProbeDeps> = {
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    env: options.env ?? {},
    now: () => 1_700_000_000_000,
    resolveCommand: async (name) => options.resolve?.[name] ?? null,
    realpath: async (target) => {
      if (target === workspace) {
        if (options.workspaceReal instanceof Error) {
          throw options.workspaceReal
        }
        return options.workspaceReal ?? workspace
      }
      return target
    },
    execFile: async (file, args, execOptions) => {
      const call = { file, args, options: execOptions as Record<string, unknown> }
      calls.push(call)
      if (!options.exec) {
        return { stdout: 'tool 1.2.3\n', stderr: '' }
      }
      return options.exec(call)
    }
  }
  return { deps, calls }
}

async function measure(
  requirements: EnvironmentRequirement[],
  options: Parameters<typeof fakeDeps>[0] = {}
): Promise<{ result: Extract<HostMeasurement, { status: 'measured' }>; calls: ExecCall[] }> {
  const { deps, calls } = fakeDeps(options)
  const result = await measureRequirementsLocally({
    requirements,
    workspacePath: '/work/project',
    hostKey: 'local@abc',
    deps
  })
  if (result.status !== 'measured') {
    throw new Error(`not measured: ${JSON.stringify(result)}`)
  }
  return { result, calls }
}

const gitWithVersion: EnvironmentRequirement = {
  id: 'git',
  kind: 'command',
  name: 'git',
  versionArg: '--version',
  versionRange: {
    status: 'supported',
    raw: '>=1',
    comparators: [{ op: '>=', version: [1, 0, 0] }]
  }
}

function byId(probes: RequirementProbeResult[], id: string): RequirementProbeResult {
  const probe = probes.find((candidate) => candidate.id === id)
  if (!probe) {
    throw new Error(`no probe ${id}`)
  }
  return probe
}

describe('measureRequirementsLocally', () => {
  it('reports a measured host with its platform and key', async () => {
    const { result } = await measure([], { platform: 'darwin', arch: 'arm64' })
    expect(result).toMatchObject({
      status: 'measured',
      at: 1_700_000_000_000,
      hostKey: 'local@abc',
      platform: { os: 'darwin', arch: 'arm64' },
      probes: []
    })
  })

  it('skips a platform-excluded requirement without executing anything', async () => {
    const { result, calls } = await measure([{ ...gitWithVersion, platforms: [{ os: 'win32' }] }], {
      resolve: { git: '/usr/bin/git' }
    })
    expect(byId(result.probes, 'git')).toEqual({ id: 'git', outcome: 'skipped-platform' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a path inside the workspace and never executes it', async () => {
    const { result, calls } = await measure([gitWithVersion], {
      resolve: { git: '/work/project/node_modules/.bin/git' }
    })
    expect(byId(result.probes, 'git')).toEqual({
      id: 'git',
      outcome: 'refused',
      reason: 'resolves-inside-workspace'
    })
    expect(calls).toHaveLength(0)
  })

  it('refuses when a symlink target lands inside the workspace', async () => {
    const { deps, calls } = fakeDeps({ resolve: { git: '/usr/local/bin/git' } })
    deps.realpath = async (target) =>
      target === '/usr/local/bin/git' ? '/work/project/vendor/git' : target
    const result = await measureRequirementsLocally({
      requirements: [gitWithVersion],
      workspacePath: '/work/project',
      hostKey: 'local@abc',
      deps
    })
    expect(result.status === 'measured' && byId(result.probes, 'git').outcome).toBe('refused')
    expect(calls).toHaveLength(0)
  })

  it('runs the resolved real path with no shell, a 5 s timeout and hidden window', async () => {
    const { result, calls } = await measure([gitWithVersion], {
      resolve: { git: '/usr/bin/git' },
      exec: async () => ({ stdout: 'git version 2.45.1\n', stderr: '' })
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/usr/bin/git')
    expect(calls[0].args).toEqual(['--version'])
    expect('shell' in calls[0].options).toBe(false)
    expect(calls[0].options.timeout).toBe(5000)
    expect(calls[0].options.windowsHide).toBe(true)
    expect(byId(result.probes, 'git')).toEqual({
      id: 'git',
      outcome: 'found',
      resolvedPath: '/usr/bin/git',
      version: '2.45.1'
    })
  })

  it('uses the declared version argument', async () => {
    const { calls } = await measure([{ ...gitWithVersion, versionArg: 'version' }], {
      resolve: { git: '/usr/bin/git' }
    })
    expect(calls[0].args).toEqual(['version'])
  })

  it('reports presence without executing when no version is wanted', async () => {
    const { result, calls } = await measure(
      [{ id: 'node', kind: 'command', name: 'node', versionArg: '--version' }],
      { resolve: { node: '/usr/bin/node' } }
    )
    expect(byId(result.probes, 'node')).toEqual({
      id: 'node',
      outcome: 'found',
      resolvedPath: '/usr/bin/node'
    })
    expect(calls).toHaveLength(0)
  })

  it('reports absent when the command is not on PATH', async () => {
    const { result } = await measure([gitWithVersion])
    expect(byId(result.probes, 'git')).toEqual({ id: 'git', outcome: 'absent' })
  })

  it('names an exec failure probe-failed, never absent', async () => {
    const { result } = await measure([gitWithVersion], {
      resolve: { git: '/usr/bin/git' },
      exec: async () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
      }
    })
    expect(byId(result.probes, 'git')).toMatchObject({ outcome: 'failed', reason: 'probe-failed' })
  })

  it('names output without a version unparseable-version', async () => {
    const { result } = await measure([gitWithVersion], {
      resolve: { git: '/usr/bin/git' },
      exec: async () => ({ stdout: 'hello\n', stderr: '' })
    })
    expect(byId(result.probes, 'git')).toMatchObject({
      outcome: 'failed',
      reason: 'unparseable-version'
    })
  })

  it('does not run a binary for a version range it cannot evaluate', async () => {
    const { result, calls } = await measure(
      [{ ...gitWithVersion, versionRange: { status: 'unsupported', raw: '^2' } }],
      { resolve: { git: '/usr/bin/git' } }
    )
    expect(byId(result.probes, 'git')).toMatchObject({
      outcome: 'failed',
      reason: 'unsupported-version-range'
    })
    expect(calls).toHaveLength(0)
  })

  it('fails every resolved command with workspace-unreadable when the workspace cannot be resolved', async () => {
    const { result, calls } = await measure([gitWithVersion], {
      resolve: { git: '/usr/bin/git' },
      workspaceReal: new Error('ENOENT')
    })
    expect(byId(result.probes, 'git')).toMatchObject({
      outcome: 'failed',
      reason: 'workspace-unreadable'
    })
    expect(calls).toHaveLength(0)
  })

  it('never executes a cmd shim and reports presence-only as found', async () => {
    const shim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\pnpm.cmd'
    const { deps, calls } = fakeDeps({ platform: 'win32', resolve: { pnpm: shim } })
    deps.realpath = async (target) => (target === '/work/project' ? 'C:\\work\\project' : target)
    const withVersion = await measureRequirementsLocally({
      requirements: [{ ...gitWithVersion, id: 'pnpm', name: 'pnpm' }],
      workspacePath: '/work/project',
      hostKey: 'local@abc',
      deps
    })
    const withoutVersion = await measureRequirementsLocally({
      requirements: [{ id: 'pnpm', kind: 'command', name: 'pnpm', versionArg: '--version' }],
      workspacePath: '/work/project',
      hostKey: 'local@abc',
      deps
    })
    expect(withVersion.status === 'measured' && byId(withVersion.probes, 'pnpm')).toMatchObject({
      outcome: 'failed',
      reason: 'version-probe-needs-shell'
    })
    expect(
      withoutVersion.status === 'measured' && byId(withoutVersion.probes, 'pnpm')
    ).toMatchObject({ outcome: 'found', resolvedPath: shim })
    expect(calls).toHaveLength(0)
  })

  it('reads env presence and never returns the value', async () => {
    const { result } = await measure(
      [
        { id: 'tok', kind: 'env', name: 'ORCA_TEST_SENTINEL' },
        { id: 'nope', kind: 'env', name: 'ORCA_NOT_SET' }
      ],
      { env: { ORCA_TEST_SENTINEL: 'zz-sentinel-zz' } }
    )
    expect(byId(result.probes, 'tok')).toEqual({ id: 'tok', outcome: 'found', present: true })
    expect(byId(result.probes, 'nope')).toEqual({ id: 'nope', outcome: 'absent', present: false })
    expect(JSON.stringify(result)).not.toContain('zz-sentinel-zz')
  })

  it('reads env names case-insensitively on win32 only', async () => {
    const win = await measure([{ id: 'tok', kind: 'env', name: 'ORCA_X' }], {
      platform: 'win32',
      env: { Orca_X: 'v' }
    })
    expect(byId(win.result.probes, 'tok').present).toBe(true)
    const posix = await measure([{ id: 'tok', kind: 'env', name: 'ORCA_X' }], {
      env: { Orca_X: 'v' }
    })
    expect(byId(posix.result.probes, 'tok').present).toBe(false)
  })

  describe('credential', () => {
    const gh: EnvironmentRequirement = { id: 'gh', kind: 'credential', provider: 'gh' }

    it('is absent with its own reason when the CLI is not installed', async () => {
      const { result } = await measure([gh])
      expect(byId(result.probes, 'gh')).toEqual({
        id: 'gh',
        outcome: 'absent',
        reason: 'credential-cli-absent'
      })
    })

    it('reports authenticated from the exit status only', async () => {
      const { result, calls } = await measure([gh], {
        resolve: { gh: '/usr/bin/gh' },
        exec: async () => ({ stdout: 'token zz-out-zz', stderr: 'zz-err-zz' })
      })
      expect(calls[0].args).toEqual(['auth', 'status'])
      expect(byId(result.probes, 'gh')).toEqual({ id: 'gh', outcome: 'found', authenticated: true })
      expect(JSON.stringify(result)).not.toContain('zz-out-zz')
    })

    it('reads a non-zero exit as not authenticated, using the CLI own marker on the host', async () => {
      const { result } = await measure([gh], {
        resolve: { gh: '/usr/bin/gh' },
        exec: async () => {
          throw Object.assign(new Error('exit 1'), {
            code: 1,
            stdout: '',
            stderr: 'You are not logged into any GitHub hosts zz-out-zz'
          })
        }
      })
      expect(byId(result.probes, 'gh')).toEqual({
        id: 'gh',
        outcome: 'found',
        authenticated: false
      })
      expect(JSON.stringify(result)).not.toContain('zz-out-zz')
    })

    it('treats a CLI that could not run as failed, not unauthenticated', async () => {
      const { result } = await measure([gh], {
        resolve: { gh: '/usr/bin/gh' },
        exec: async () => {
          throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
        }
      })
      expect(byId(result.probes, 'gh')).toMatchObject({ outcome: 'failed', reason: 'probe-failed' })
    })

    it('refuses a CLI that resolves inside the workspace', async () => {
      const { result, calls } = await measure([gh], { resolve: { gh: '/work/project/bin/gh' } })
      expect(byId(result.probes, 'gh')).toMatchObject({ outcome: 'refused' })
      expect(calls).toHaveLength(0)
    })
  })

  describe('agent', () => {
    const claude: EnvironmentRequirement = { id: 'claude', kind: 'agent', provider: 'claude' }

    it('is found when the provider command resolves outside the workspace', async () => {
      const { result, calls } = await measure([claude], { resolve: { claude: '/usr/bin/claude' } })
      expect(byId(result.probes, 'claude')).toEqual({ id: 'claude', outcome: 'found' })
      expect(calls).toHaveLength(0)
    })

    it('is absent when no detection command resolves', async () => {
      const { result } = await measure([claude])
      expect(byId(result.probes, 'claude')).toEqual({ id: 'claude', outcome: 'absent' })
    })

    it('is refused when the only match is inside the workspace', async () => {
      const { result } = await measure([claude], {
        resolve: { claude: '/work/project/bin/claude' }
      })
      expect(byId(result.probes, 'claude')).toMatchObject({ outcome: 'refused' })
    })
  })

  it('answers a platform requirement from the measured platform', async () => {
    const { result } = await measure(
      [
        { id: 'os', kind: 'platform', os: 'linux' },
        { id: 'mac', kind: 'platform', os: 'darwin' }
      ],
      { platform: 'linux' }
    )
    expect(byId(result.probes, 'os').outcome).toBe('found')
    expect(byId(result.probes, 'mac').outcome).toBe('skipped-platform')
  })

  it('keeps unsupported and malformed rows out of the probes', async () => {
    const { result } = await measure([
      { id: 'gpu', kind: 'gpu', unsupportedByThisOrca: true },
      { id: 'bad', kind: 'command', malformed: true }
    ])
    expect(result.probes).toEqual([])
  })

  it('measures at most 64 requirements and names the rest', async () => {
    const rows: EnvironmentRequirement[] = Array.from({ length: 66 }, (_, i) => ({
      id: `e${i}`,
      kind: 'env',
      name: 'ORCA_X'
    }))
    const { result } = await measure(rows)
    expect(result.probes).toHaveLength(66)
    expect(byId(result.probes, 'e63').outcome).toBe('absent')
    expect(byId(result.probes, 'e64')).toMatchObject({
      outcome: 'failed',
      reason: 'too-many-requirements'
    })
  })

  it('probes with a concurrency of at most four', async () => {
    let active = 0
    let peak = 0
    const { deps } = fakeDeps({})
    deps.resolveCommand = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return null
    }
    const rows: EnvironmentRequirement[] = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      kind: 'command',
      name: 'x',
      versionArg: '--version'
    }))
    await measureRequirementsLocally({
      requirements: rows,
      workspacePath: '/work/project',
      hostKey: 'local@abc',
      deps
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })
})

describe.runIf(process.env.ORCA_ENV_PROBE_REAL === '1')('real laptop', () => {
  it('measures real binaries on this laptop', async () => {
    const workspace = process.cwd()
    const env = buildLocalPreflightEnv() ?? process.env
    const result = await measureRequirementsLocally({
      requirements: [
        {
          ...gitWithVersion,
          versionRange: {
            status: 'supported',
            raw: '>=0.0.1',
            comparators: [{ op: '>=', version: [0, 0, 1] }]
          }
        },
        { id: 'absent', kind: 'command', name: 'orca-hwf-p20-absent', versionArg: '--version' }
      ],
      workspacePath: workspace,
      hostKey: 'local@real'
    })
    expect(result.status).toBe('measured')
    if (result.status !== 'measured') {
      return
    }
    const git = byId(result.probes, 'git')
    const absent = byId(result.probes, 'absent')
    expect(git.outcome).toBe('found')
    expect(path.isAbsolute(git.resolvedPath ?? '')).toBe(true)
    expect(git.version).toMatch(/^\d+\.\d+/)
    expect(
      path
        .resolve(git.resolvedPath ?? '')
        .toLowerCase()
        .startsWith(workspace.toLowerCase())
    ).toBe(false)
    expect(absent.outcome).toBe('absent')

    let shimName = 'none'
    let shimLine = 'none:n/a'
    for (const candidate of ['pnpm', 'npm', 'corepack']) {
      const resolved = await resolveCommandOnLocalPath(candidate, {
        env,
        searchCurrentDirectory: false
      })
      if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
        shimName = candidate
        const withVersion = await measureRequirementsLocally({
          requirements: [{ ...gitWithVersion, id: 'shim', name: candidate }],
          workspacePath: workspace,
          hostKey: 'local@real'
        })
        const without = await measureRequirementsLocally({
          requirements: [{ id: 'shim', kind: 'command', name: candidate, versionArg: '--version' }],
          workspacePath: workspace,
          hostKey: 'local@real'
        })
        const a = withVersion.status === 'measured' ? byId(withVersion.probes, 'shim') : null
        const b = without.status === 'measured' ? byId(without.probes, 'shim') : null
        expect(a).toMatchObject({ outcome: 'failed', reason: 'version-probe-needs-shell' })
        expect(b?.outcome).toBe('found')
        shimLine = `${shimName}:${a?.outcome}/${a?.reason}`
        break
      }
    }
    if (process.platform === 'win32') {
      expect(shimName).not.toBe('none')
    }
    // Why: the verifier reads this with \S+, so spaces in the path are percent-encoded.
    console.log(
      `ENV_PROBE_REAL git=${(git.resolvedPath ?? '').replace(/ /g, '%20')} version=${git.version} absent=${absent.outcome} cmdShim=${shimLine}`
    )
    console.log(
      `ENV_PROBE_REAL_RAW git=${git.resolvedPath} platform=${JSON.stringify(result.platform)}`
    )

    const distro = process.env.ORCA_ENV_PROBE_WSL_DISTRO
    if (!distro) {
      console.log('WSL_LEG=NOT_RUN reason=no-distro')
      return
    }
    const wsl = await measureRequirementsLocally({
      requirements: [{ id: 'git', kind: 'command', name: 'git', versionArg: '--version' }],
      workspacePath: '/tmp',
      hostKey: 'local@real-wsl',
      wslTarget: { distro }
    })
    expect(wsl.status).toBe('measured')
    if (wsl.status === 'measured') {
      expect(wsl.platform.os).toBe('linux')
      console.log(`WSL_LEG=run os=linux git=${byId(wsl.probes, 'git').outcome}`)
    }
  })
})
