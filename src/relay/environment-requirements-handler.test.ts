import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_REQUIREMENTS_RELAY_CAPABILITIES,
  ENVIRONMENT_REQUIREMENTS_RELAY_CAPABILITY,
  EnvironmentRequirementsHandler,
  type EnvironmentRequirementsDeps
} from './environment-requirements-handler'
import { ENV_PRESENT_MARKER } from './environment-requirements-env-script'
import { SKILL_RELAY_CAPABILITIES } from './skill-install-handler'
import { toProbeRequests } from '../shared/environment-requirement-probe-request'
import type {
  RequirementProbeRequest,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

type ExecCall = { file: string; args: string[]; options: Record<string, unknown> }
type Response = {
  platform: { os: string; arch: string }
  probes: RequirementProbeResult[]
}

function setup(options: {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  resolve?: Record<string, string | Error>
  realpath?: Record<string, string>
  exec?: (call: ExecCall) => Promise<{ stdout: string; stderr: string }>
}): {
  call: (params: unknown) => Promise<Response>
  calls: ExecCall[]
  methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>>
} {
  const calls: ExecCall[] = []
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const dispatcher = {
    onRequest: (name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      methods.set(name, handler)
    }
  }
  const deps: Partial<EnvironmentRequirementsDeps> = {
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    env: options.env ?? { SHELL: '/bin/bash', PATH: '/usr/bin' },
    // Why: pin the shell trust decision so it does not depend on the account running the test.
    accountLoginShell: null,
    resolveCommand: async (name) => {
      const hit = options.resolve?.[name]
      if (hit instanceof Error) {
        throw hit
      }
      return hit ?? null
    },
    realpath: async (target) => options.realpath?.[target] ?? target,
    execFile: async (file, args, execOptions) => {
      const entry = { file, args, options: execOptions as Record<string, unknown> }
      calls.push(entry)
      return options.exec ? options.exec(entry) : { stdout: 'tool 1.2.3\n', stderr: '' }
    }
  }
  new EnvironmentRequirementsHandler(dispatcher as never, deps)
  const handler = methods.get('environment.measureRequirements')
  if (!handler) {
    throw new Error('method not registered')
  }
  return {
    call: (params) => handler(params as Record<string, unknown>) as Promise<Response>,
    calls,
    methods
  }
}

const git: RequirementProbeRequest = {
  id: 'git',
  kind: 'command',
  name: 'git',
  versionArg: '--version',
  version: 'wanted'
}

function byId(response: Response, id: string): RequirementProbeResult {
  const probe = response.probes.find((candidate) => candidate.id === id)
  if (!probe) {
    throw new Error(`no probe ${id}`)
  }
  return probe
}

describe('capability', () => {
  it('advertises exactly the environment capability beside the pinned skill list', () => {
    expect(ENVIRONMENT_REQUIREMENTS_RELAY_CAPABILITY).toBe('environment.requirements.v1')
    expect([...ENVIRONMENT_REQUIREMENTS_RELAY_CAPABILITIES]).toEqual([
      'environment.requirements.v1'
    ])
    for (const capability of SKILL_RELAY_CAPABILITIES) {
      expect(capability).not.toBe(ENVIRONMENT_REQUIREMENTS_RELAY_CAPABILITY)
    }
  })

  it('registers environment.measureRequirements', () => {
    expect(setup({}).methods.has('environment.measureRequirements')).toBe(true)
  })
})

describe('parameter validation', () => {
  it.each([
    ['requirements is not an array', { workspacePath: '/w', requirements: {} }],
    ['no workspacePath', { requirements: [] }],
    ['an empty workspacePath', { workspacePath: '', requirements: [] }],
    [
      'a command name that is a path',
      {
        workspacePath: '/w',
        requirements: [{ ...git, name: '../git' }]
      }
    ],
    [
      'more than 64 entries',
      {
        workspacePath: '/w',
        requirements: Array.from({ length: 65 }, (_, i) => ({
          id: `e${i}`,
          kind: 'env',
          name: 'ORCA_X'
        }))
      }
    ]
  ])('rejects %s with -32602 and runs nothing', async (_label, params) => {
    const { call, calls } = setup({ resolve: { git: '/usr/bin/git' } })
    await expect(call(params)).rejects.toMatchObject({ code: -32602 })
    expect(calls).toHaveLength(0)
  })
})

describe('measurement', () => {
  it('reports the host platform', async () => {
    const response = await setup({ platform: 'linux', arch: 'arm64' }).call({
      workspacePath: '/w',
      requirements: []
    })
    expect(response).toEqual({ platform: { os: 'linux', arch: 'arm64' }, probes: [] })
  })

  it('skips a platform-excluded requirement and executes nothing', async () => {
    const { call, calls } = setup({ resolve: { git: '/usr/bin/git' } })
    const response = await call({
      workspacePath: '/w',
      requirements: [{ ...git, platforms: [{ os: 'win32' }] }]
    })
    expect(byId(response, 'git')).toEqual({ id: 'git', outcome: 'skipped-platform' })
    expect(calls).toHaveLength(0)
  })

  it('runs the real path with no shell, 5 s and the relay env, and keeps the version only', async () => {
    const { call, calls } = setup({
      resolve: { git: '/usr/bin/git' },
      realpath: { '/usr/bin/git': '/usr/lib/git-core/git' },
      exec: async () => ({ stdout: 'git version 2.43.0\nsecret-banner', stderr: '' })
    })
    const response = await call({ workspacePath: '/w', requirements: [git] })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/usr/lib/git-core/git')
    expect(calls[0].args).toEqual(['--version'])
    expect('shell' in calls[0].options).toBe(false)
    expect(calls[0].options.timeout).toBe(5000)
    expect(calls[0].options.env).toEqual(expect.objectContaining({ PATH: expect.any(String) }))
    expect(byId(response, 'git')).toEqual({
      id: 'git',
      outcome: 'found',
      resolvedPath: '/usr/lib/git-core/git',
      version: '2.43.0'
    })
    expect(JSON.stringify(response)).not.toContain('secret-banner')
  })

  it('is absent when the lookup ran and printed nothing', async () => {
    const response = await setup({}).call({ workspacePath: '/w', requirements: [git] })
    expect(byId(response, 'git')).toEqual({ id: 'git', outcome: 'absent' })
  })

  it('is failed lookup-failed, never absent, when every lookup spec failed', async () => {
    const lookupError = Object.assign(new Error('all specs failed'), {
      name: 'RelayCommandLookupFailedError'
    })
    const response = await setup({ resolve: { git: lookupError } }).call({
      workspacePath: '/w',
      requirements: [git]
    })
    expect(byId(response, 'git')).toMatchObject({ outcome: 'failed', reason: 'lookup-failed' })
  })

  it('refuses a path inside the workspace and never executes it', async () => {
    const { call, calls } = setup({
      resolve: { git: '/usr/bin/git' },
      realpath: { '/usr/bin/git': '/srv/project/bin/git' }
    })
    const response = await call({ workspacePath: '/srv/project', requirements: [git] })
    expect(byId(response, 'git')).toEqual({
      id: 'git',
      outcome: 'refused',
      reason: 'resolves-inside-workspace'
    })
    expect(calls).toHaveLength(0)
  })

  it('never executes a cmd shim on a win32 host', async () => {
    const shim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\pnpm.cmd'
    const { call, calls } = setup({
      platform: 'win32',
      resolve: { pnpm: shim },
      realpath: { 'C:\\work': 'C:\\work' }
    })
    const response = await call({
      workspacePath: 'C:\\work',
      requirements: [{ ...git, id: 'pnpm', name: 'pnpm' }]
    })
    expect(byId(response, 'pnpm')).toMatchObject({
      outcome: 'failed',
      reason: 'version-probe-needs-shell'
    })
    expect(calls).toHaveLength(0)
  })

  it('names a failed version exec probe-failed', async () => {
    const response = await setup({
      resolve: { git: '/usr/bin/git' },
      exec: async () => {
        throw new Error('timed out')
      }
    }).call({ workspacePath: '/w', requirements: [git] })
    expect(byId(response, 'git')).toMatchObject({ outcome: 'failed', reason: 'probe-failed' })
  })
})

describe('workspace resolution failure', () => {
  it('names workspace-unreadable', async () => {
    const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    new EnvironmentRequirementsHandler(
      { onRequest: (n: string, h: never) => methods.set(n, h) } as never,
      {
        platform: 'linux',
        arch: 'x64',
        env: {},
        resolveCommand: async () => '/usr/bin/git',
        realpath: async (target) => {
          if (target === '/missing') {
            throw new Error('ENOENT')
          }
          return target
        },
        execFile: async () => ({ stdout: '1.0.0', stderr: '' })
      }
    )
    const response = (await methods.get('environment.measureRequirements')!({
      workspacePath: '/missing',
      requirements: [git]
    })) as Response
    expect(byId(response, 'git')).toMatchObject({
      outcome: 'failed',
      reason: 'workspace-unreadable'
    })
  })
})

describe('env presence', () => {
  const env = { SHELL: '/bin/bash', PATH: '/usr/bin', ORCA_TEST_SENTINEL: 'zz-sentinel-zz' }

  it('asks the trusted login shell and returns presence only', async () => {
    const { call, calls } = setup({
      env,
      exec: async () => ({ stdout: `banner\n${ENV_PRESENT_MARKER}\n`, stderr: '' })
    })
    const response = await call({
      workspacePath: '/w',
      requirements: [{ id: 'tok', kind: 'env', name: 'ORCA_TEST_SENTINEL' }]
    })
    expect(byId(response, 'tok')).toEqual({ id: 'tok', outcome: 'found', present: true })
    expect(calls[0].file).toBe('/bin/bash')
    expect(calls[0].args[0]).toBe('-ilc')
    expect(calls[0].args[1]).toContain('ORCA_TEST_SENTINEL')
    expect(JSON.stringify(response)).not.toContain('zz-sentinel-zz')
  })

  it('is absent when the login shell printed no marker', async () => {
    const { call } = setup({ env, exec: async () => ({ stdout: 'banner\n', stderr: '' }) })
    const response = await call({
      workspacePath: '/w',
      requirements: [{ id: 'tok', kind: 'env', name: 'ORCA_NOT_SET' }]
    })
    expect(byId(response, 'tok')).toEqual({ id: 'tok', outcome: 'absent', present: false })
  })

  it('falls back to the next shell spec when the login shell fails to run', async () => {
    let n = 0
    const { call, calls } = setup({
      env,
      exec: async () => {
        n++
        if (n === 1) {
          throw new Error('startup failed')
        }
        return { stdout: `${ENV_PRESENT_MARKER}\n`, stderr: '' }
      }
    })
    const response = await call({
      workspacePath: '/w',
      requirements: [{ id: 'tok', kind: 'env', name: 'ORCA_TEST_SENTINEL' }]
    })
    expect(byId(response, 'tok').present).toBe(true)
    expect(calls.map((c) => c.file)).toEqual(['/bin/bash', '/bin/sh'])
  })

  it('is failed lookup-failed, not absent, when no shell could run', async () => {
    const { call } = setup({
      env,
      exec: async () => {
        throw new Error('no shell')
      }
    })
    const response = await call({
      workspacePath: '/w',
      requirements: [{ id: 'tok', kind: 'env', name: 'ORCA_TEST_SENTINEL' }]
    })
    expect(byId(response, 'tok')).toMatchObject({ outcome: 'failed', reason: 'lookup-failed' })
  })

  it('reads the process env case-insensitively on a win32 relay without a shell', async () => {
    const { call, calls } = setup({ platform: 'win32', env: { Orca_X: 'v' } })
    const response = await call({
      workspacePath: 'C:\\w',
      requirements: [{ id: 'tok', kind: 'env', name: 'ORCA_X' }]
    })
    expect(byId(response, 'tok').present).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('credential', () => {
  const gh: RequirementProbeRequest = { id: 'gh', kind: 'credential', provider: 'gh' }

  it('returns a boolean and drops the output, planting a sentinel in env and output', async () => {
    const { call, calls } = setup({
      env: { SHELL: '/bin/bash', PATH: '/usr/bin', ORCA_TEST_SENTINEL: 'zz-sentinel-zz' },
      resolve: { gh: '/usr/bin/gh' },
      exec: async () => ({ stdout: 'token zz-out-zz', stderr: '' })
    })
    const response = await call({ workspacePath: '/w', requirements: [gh] })
    expect(calls[0].args).toEqual(['auth', 'status'])
    expect(byId(response, 'gh')).toEqual({ id: 'gh', outcome: 'found', authenticated: true })
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain('zz-out-zz')
    expect(serialized).not.toContain('zz-sentinel-zz')
  })

  it('reads a non-zero exit as unauthenticated and a launch failure as failed', async () => {
    const unauth = await setup({
      resolve: { gh: '/usr/bin/gh' },
      exec: async () => {
        throw Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'no' })
      }
    }).call({ workspacePath: '/w', requirements: [gh] })
    expect(byId(unauth, 'gh')).toEqual({ id: 'gh', outcome: 'found', authenticated: false })
    const failed = await setup({
      resolve: { gh: '/usr/bin/gh' },
      exec: async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
      }
    }).call({ workspacePath: '/w', requirements: [gh] })
    expect(byId(failed, 'gh')).toMatchObject({ outcome: 'failed', reason: 'probe-failed' })
  })

  it('is absent with its own reason when the CLI is not installed', async () => {
    const response = await setup({}).call({ workspacePath: '/w', requirements: [gh] })
    expect(byId(response, 'gh')).toEqual({
      id: 'gh',
      outcome: 'absent',
      reason: 'credential-cli-absent'
    })
  })
})

describe('agent', () => {
  it('resolves the detection commands the client sent', async () => {
    const requests = toProbeRequests([{ id: 'claude', kind: 'agent', provider: 'claude' }])
    const found = await setup({ resolve: { claude: '/usr/bin/claude' } }).call({
      workspacePath: '/w',
      requirements: requests
    })
    expect(byId(found, 'claude')).toEqual({ id: 'claude', outcome: 'found' })
    const missing = await setup({}).call({ workspacePath: '/w', requirements: requests })
    expect(byId(missing, 'claude')).toEqual({ id: 'claude', outcome: 'absent' })
  })
})

describe('platform request', () => {
  it('is answered from the host platform', async () => {
    const response = await setup({ platform: 'linux' }).call({
      workspacePath: '/w',
      requirements: [
        { id: 'os', kind: 'platform', os: 'linux' },
        { id: 'mac', kind: 'platform', os: 'darwin' }
      ]
    })
    expect(byId(response, 'os').outcome).toBe('found')
    expect(byId(response, 'mac').outcome).toBe('skipped-platform')
  })
})
