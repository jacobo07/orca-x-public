import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  computeInstallationTag,
  measureEnvironmentRequirements,
  type EnvironmentMeasurementDeps
} from './environment-requirement-measurement'
import type {
  EnvironmentRequirement,
  HostMeasurement
} from '../shared/environment-requirement-types'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

const YAML = [
  'requirements:',
  '  - id: git',
  '    kind: command',
  '    name: git',
  '    version: ">=2"',
  '    prepare: winget install Git.Git',
  ''
].join('\n')

const measured = (hostKey: string): HostMeasurement => ({
  status: 'measured',
  at: 1,
  hostKey,
  platform: { os: 'linux', arch: 'x64' },
  probes: []
})

type LocalCall = {
  requirements: EnvironmentRequirement[]
  workspacePath: string
  hostKey: string
  wslTarget?: { distro?: string } | null
}
type SshCall = {
  connectionId: string
  hostKey: string
  workspacePath: string
  requirements: EnvironmentRequirement[]
}

function setup(options: {
  files?: Record<string, string | Buffer | Error>
  ssh?: 'none' | { files: Record<string, string | Error | { binary: true }> }
  projectRuntime?: ProjectExecutionRuntimeResolution
  hostname?: string
  userDataPath?: string
}): {
  run: (
    repo: Parameters<typeof measureEnvironmentRequirements>[0]
  ) => ReturnType<typeof measureEnvironmentRequirements>
  localCalls: LocalCall[]
  sshCalls: SshCall[]
} {
  const localCalls: LocalCall[] = []
  const sshCalls: SshCall[] = []
  const deps: EnvironmentMeasurementDeps = {
    hostname: options.hostname ?? 'laptop',
    userDataPath: options.userDataPath ?? '/userdata',
    projectRuntime: options.projectRuntime,
    readLocalFile: async (filePath) => {
      const hit = options.files?.[filePath]
      if (hit === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      if (hit instanceof Error) {
        throw hit
      }
      return Buffer.from(hit)
    },
    getSshFilesystemProvider: (connectionId) => {
      if (options.ssh === undefined || options.ssh === 'none') {
        return undefined
      }
      const files = options.ssh.files
      return {
        readFile: async (filePath: string) => {
          const hit = files[filePath]
          if (hit === undefined) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          }
          if (hit instanceof Error) {
            throw hit
          }
          if (typeof hit === 'object') {
            return { content: '\u0000\u0001', isBinary: true }
          }
          void connectionId
          return { content: hit, isBinary: false }
        }
      } as never
    },
    measureLocally: async (input) => {
      localCalls.push(input as LocalCall)
      return measured(input.hostKey)
    },
    measureOverSsh: async (input) => {
      sshCalls.push(input as SshCall)
      return measured(input.hostKey)
    },
    now: () => 1
  }
  return {
    run: (repo) => measureEnvironmentRequirements(repo, deps),
    localCalls,
    sshCalls
  }
}

const localRepo = { path: '/work/project' }

describe('installation tag and host key', () => {
  it('is the first 16 hex of sha256(hostname NUL userData)', () => {
    expect(computeInstallationTag('laptop', '/userdata')).toBe(
      sha256('laptop\u0000/userdata').slice(0, 16)
    )
    expect(computeInstallationTag('laptop', '/userdata')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs between hosts and between installations on one host', () => {
    expect(computeInstallationTag('laptop', '/a')).not.toBe(computeInstallationTag('gex44', '/a'))
    expect(computeInstallationTag('laptop', '/a')).not.toBe(computeInstallationTag('laptop', '/b'))
  })

  it('keys a local repo as local@tag and an ssh repo as ssh:<id>@tag', async () => {
    const { run } = setup({ files: { '/work/project/orca.yaml': YAML } })
    const local = await run(localRepo)
    expect(local.measurement.hostKey).toBe(`local@${computeInstallationTag('laptop', '/userdata')}`)
    const ssh = setup({ ssh: { files: { '/srv/p/orca.yaml': YAML } } })
    const remote = await ssh.run({ path: '/srv/p', connectionId: 'target 1' })
    expect(remote.measurement.hostKey).toBe(
      `ssh:target%201@${computeInstallationTag('laptop', '/userdata')}`
    )
  })
})

describe('local contract read', () => {
  it('parses the contract and names its source with the hash of the exact bytes', async () => {
    const { run, localCalls } = setup({ files: { '/work/project/orca.yaml': YAML } })
    const result = await run(localRepo)
    const hostKey = `local@${computeInstallationTag('laptop', '/userdata')}`
    expect(result.contract).toBe('parsed')
    expect(result.contractSource).toEqual({
      hostKey,
      path: '/work/project/orca.yaml',
      contentHash: sha256(Buffer.from(YAML))
    })
    expect(result.requirements).toHaveLength(1)
    expect(result.diagnostics).toEqual([])
    expect(localCalls).toHaveLength(1)
    expect(localCalls[0].workspacePath).toBe('/work/project')
    expect(localCalls[0].hostKey).toBe(hostKey)
    expect(localCalls[0].requirements).toHaveLength(1)
  })

  it('returns the prepare text so the plan can show it', async () => {
    const { run } = setup({ files: { '/work/project/orca.yaml': YAML } })
    const result = await run(localRepo)
    expect((result.requirements[0] as { prepare?: string }).prepare).toBe('winget install Git.Git')
  })

  it('hashes identical bytes identically on a different host', async () => {
    const a = await setup({ files: { '/work/project/orca.yaml': YAML } }).run(localRepo)
    const b = await setup({
      files: { '/srv/p/orca.yaml': YAML },
      hostname: 'gex44',
      userDataPath: '/other'
    }).run({ path: '/srv/p' })
    expect(a.contractSource?.contentHash).toBe(b.contractSource?.contentHash)
    expect(a.contractSource?.hostKey).not.toBe(b.contractSource?.hostKey)
  })

  it('a missing file is absent with zero requirements, stated, and the host is still measured', async () => {
    const { run, localCalls } = setup({})
    const result = await run(localRepo)
    expect(result.contract).toBe('absent')
    expect(result.contractSource).toBeNull()
    expect(result.requirements).toEqual([])
    expect(result.measurement.status).toBe('measured')
    expect(localCalls[0].requirements).toEqual([])
  })

  it('unreadable contract is not absent', async () => {
    for (const code of ['EACCES', 'EISDIR', 'EIO']) {
      const { run } = setup({
        files: { '/work/project/orca.yaml': Object.assign(new Error(code), { code }) }
      })
      const result = await run(localRepo)
      expect(result.contract, code).toBe('unreadable')
      expect(result.contractSource).toBeNull()
    }
  })

  it('a binary file is unreadable', async () => {
    const { run } = setup({
      files: { '/work/project/orca.yaml': Buffer.from([0x72, 0, 0x73, 0xff]) }
    })
    expect((await run(localRepo)).contract).toBe('unreadable')
  })

  it('an unparseable file is unparseable, never absent, and keeps its source', async () => {
    const { run } = setup({ files: { '/work/project/orca.yaml': 'requirements: [unclosed\n' } })
    const result = await run(localRepo)
    expect(result.contract).toBe('unparseable')
    expect(result.contractSource?.contentHash).toBe(
      sha256(Buffer.from('requirements: [unclosed\n'))
    )
    expect(result.requirements).toEqual([])
  })

  it('a file with hooks only has no requirements section and reads as absent', async () => {
    const { run } = setup({ files: { '/work/project/orca.yaml': 'scripts:\n  setup: pnpm i\n' } })
    const result = await run(localRepo)
    expect(result.contract).toBe('absent')
    expect(result.contractSource).not.toBeNull()
  })

  it('reads a folder workspace like any other', async () => {
    const { run } = setup({ files: { '/work/project/orca.yaml': YAML } })
    const result = await run({ ...localRepo, kind: 'folder' })
    expect(result.contract).toBe('parsed')
  })
})

describe('ssh contract read', () => {
  const remote = { path: '/srv/p', connectionId: 'c1' }

  it('reads through the SSH filesystem provider and dispatches the SSH client', async () => {
    const { run, sshCalls, localCalls } = setup({ ssh: { files: { '/srv/p/orca.yaml': YAML } } })
    const result = await run(remote)
    expect(result.contract).toBe('parsed')
    expect(result.contractSource?.path).toBe('/srv/p/orca.yaml')
    expect(sshCalls).toHaveLength(1)
    expect(sshCalls[0]).toMatchObject({ connectionId: 'c1', workspacePath: '/srv/p' })
    expect(localCalls).toHaveLength(0)
  })

  it('no provider is unreadable, not absent', async () => {
    const result = await setup({ ssh: 'none' }).run(remote)
    expect(result.contract).toBe('unreadable')
  })

  it('ENOENT is absent; any other read error is unreadable', async () => {
    expect((await setup({ ssh: { files: {} } }).run(remote)).contract).toBe('absent')
    const result = await setup({
      ssh: { files: { '/srv/p/orca.yaml': Object.assign(new Error('x'), { code: 'EACCES' }) } }
    }).run(remote)
    expect(result.contract).toBe('unreadable')
  })

  it('a binary result is unreadable', async () => {
    const result = await setup({ ssh: { files: { '/srv/p/orca.yaml': { binary: true } } } }).run(
      remote
    )
    expect(result.contract).toBe('unreadable')
  })
})

describe('WSL project runtime', () => {
  const wsl: ProjectExecutionRuntimeResolution = {
    status: 'resolved',
    runtime: {
      kind: 'wsl',
      hostPlatform: 'wsl',
      projectId: 'p',
      distro: 'Ubuntu',
      reason: 'project-override',
      cacheKey: 'k'
    }
  }

  it('measures inside the distro with a linux workspace path', async () => {
    const { run, localCalls } = setup({
      files: { 'C:\\work\\project\\orca.yaml': YAML },
      projectRuntime: wsl
    })
    await run({ path: 'C:\\work\\project' })
    expect(localCalls[0].wslTarget).toEqual({ distro: 'Ubuntu' })
    expect(localCalls[0].workspacePath).toBe('/mnt/c/work/project')
  })

  it('refuses with project-runtime-repair-required instead of measuring', async () => {
    const { run, localCalls } = setup({
      files: { '/work/project/orca.yaml': YAML },
      projectRuntime: {
        status: 'repair-required',
        repair: {
          projectId: 'p',
          preferredRuntime: { kind: 'wsl', distro: null },
          reason: 'wsl-distro-required',
          source: 'global-default',
          cacheKey: 'k'
        }
      }
    })
    const result = await run(localRepo)
    expect(result.measurement).toMatchObject({
      status: 'refused',
      detail: 'project-runtime-repair-required'
    })
    expect(localCalls).toHaveLength(0)
    expect(result.contract).toBe('parsed')
  })
})
