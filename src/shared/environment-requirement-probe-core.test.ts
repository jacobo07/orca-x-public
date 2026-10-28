import { describe, expect, it } from 'vitest'
import {
  capProbeOutput,
  COMMAND_NAME_PATTERN,
  decideProbeExecution,
  ENV_NAME_PATTERN,
  isCredentialAuthenticated,
  isPathInsideWorkspace,
  mapMeasuredArch,
  mapWithConcurrency,
  MAX_PROBE_OUTPUT_CHARS,
  MAX_REQUIREMENTS_PER_REQUEST,
  platformGateResult,
  resultFromVersionOutput,
  splitByRequestCap,
  VERSION_ARGS
} from './environment-requirement-probe-core'
import {
  parseProbeRequests,
  REQUIREMENT_ID_PATTERN,
  toProbeRequests
} from './environment-requirement-probe-request'
import { ORCA_VM_RECIPE_ID_PATTERN } from './orca-yaml'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from './tui-agent-detection-commands'
import type {
  EnvironmentRequirement,
  RequirementProbeRequest
} from './environment-requirement-types'

describe('isPathInsideWorkspace', () => {
  it('refuses a path inside the workspace', () => {
    expect(isPathInsideWorkspace('/w/node_modules/.bin/tool', '/w', 'linux')).toBe(true)
    expect(isPathInsideWorkspace('/w/tool', '/w/', 'linux')).toBe(true)
    expect(isPathInsideWorkspace('/w', '/w', 'linux')).toBe(true)
  })

  it('does not treat a sibling that shares a name prefix as inside', () => {
    expect(isPathInsideWorkspace('/w2/tool', '/w', 'linux')).toBe(false)
    expect(isPathInsideWorkspace('C:\\Work2\\tool.exe', 'C:\\Work', 'win32')).toBe(false)
  })

  it('is case-sensitive on posix', () => {
    expect(isPathInsideWorkspace('/W/tool', '/w', 'linux')).toBe(false)
    expect(isPathInsideWorkspace('/W/tool', '/w', 'darwin')).toBe(false)
  })

  it('folds case and slash direction on win32', () => {
    expect(isPathInsideWorkspace('c:\\work\\proj\\bin\\x.exe', 'C:\\Work\\Proj', 'win32')).toBe(
      true
    )
    expect(isPathInsideWorkspace('C:/Work/Proj/bin/x.exe', 'C:\\Work\\Proj', 'win32')).toBe(true)
    expect(isPathInsideWorkspace('D:\\Work\\Proj\\x.exe', 'C:\\Work\\Proj', 'win32')).toBe(false)
  })

  it('judges by the host platform path semantics, not the machine running the test', () => {
    expect(isPathInsideWorkspace('/other/tool', 'C:\\w', 'win32')).toBe(true)
    expect(isPathInsideWorkspace('C:\\w\\tool', 'C:\\w', 'linux')).toBe(true)
    expect(isPathInsideWorkspace('/other/tool', '/w', 'linux')).toBe(false)
  })

  it('fails closed on a path that is not absolute for the platform', () => {
    expect(isPathInsideWorkspace('tool', '/w', 'linux')).toBe(true)
    expect(isPathInsideWorkspace('/w/tool', 'w', 'linux')).toBe(true)
  })
})

describe('decideProbeExecution', () => {
  const base = { workspaceRealPath: '/w', platform: 'linux' as const, wantsVersion: true }

  it('refuses a path inside the workspace', () => {
    expect(decideProbeExecution({ ...base, resolvedRealPath: '/w/bin/git' })).toEqual({
      execute: false,
      outcome: 'refused',
      reason: 'resolves-inside-workspace'
    })
  })

  it('refuses before it considers presence-only', () => {
    expect(
      decideProbeExecution({
        resolvedRealPath: 'C:\\w\\bin\\x.cmd',
        workspaceRealPath: 'C:\\w',
        platform: 'win32',
        wantsVersion: false
      })
    ).toMatchObject({ execute: false, outcome: 'refused' })
  })

  it('never executes a cmd shim', () => {
    for (const shim of [
      'C:\\npm\\pnpm.cmd',
      'C:\\npm\\PNPM.CMD',
      'C:\\npm\\tool.bat',
      'C:\\npm\\Tool.Bat'
    ]) {
      expect(
        decideProbeExecution({
          resolvedRealPath: shim,
          workspaceRealPath: 'C:\\w',
          platform: 'win32',
          wantsVersion: true
        })
      ).toEqual({ execute: false, outcome: 'failed', reason: 'version-probe-needs-shell' })
    }
  })

  it('reports a cmd shim as found by presence when no version is wanted', () => {
    expect(
      decideProbeExecution({
        resolvedRealPath: 'C:\\npm\\pnpm.cmd',
        workspaceRealPath: 'C:\\w',
        platform: 'win32',
        wantsVersion: false
      })
    ).toEqual({ execute: false, outcome: 'found' })
  })

  it('executes only when a version is wanted', () => {
    expect(decideProbeExecution({ ...base, resolvedRealPath: '/usr/bin/git' })).toEqual({
      execute: true
    })
    expect(
      decideProbeExecution({ ...base, wantsVersion: false, resolvedRealPath: '/usr/bin/git' })
    ).toEqual({ execute: false, outcome: 'found' })
    expect(
      decideProbeExecution({
        resolvedRealPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
        workspaceRealPath: 'C:\\w',
        platform: 'win32',
        wantsVersion: true
      })
    ).toEqual({ execute: true })
  })

  it('does not apply the shim rule off win32', () => {
    expect(decideProbeExecution({ ...base, resolvedRealPath: '/usr/bin/tool.cmd' })).toEqual({
      execute: true
    })
  })
})

describe('probe vocabulary', () => {
  it('allows exactly four version arguments', () => {
    expect([...VERSION_ARGS]).toEqual(['--version', '-v', '-V', 'version'])
  })

  it('caps output at 4096 chars', () => {
    expect(MAX_PROBE_OUTPUT_CHARS).toBe(4096)
    expect(capProbeOutput('x'.repeat(10000))).toHaveLength(4096)
    expect(capProbeOutput('short')).toBe('short')
  })

  it('exports the name patterns the parser uses', () => {
    expect(COMMAND_NAME_PATTERN.test('git')).toBe(true)
    expect(COMMAND_NAME_PATTERN.test('../git')).toBe(false)
    expect(ENV_NAME_PATTERN.test('ORCA_X')).toBe(true)
    expect(ENV_NAME_PATTERN.test('orca_x')).toBe(false)
  })
})

describe('toProbeRequests', () => {
  const rows: EnvironmentRequirement[] = [
    {
      id: 'git',
      kind: 'command',
      name: 'git',
      versionArg: '--version',
      versionRange: {
        status: 'supported',
        raw: '>=2',
        comparators: [{ op: '>=', version: [2, 0, 0] }]
      }
    },
    { id: 'node', kind: 'command', name: 'node', versionArg: '-v' },
    {
      id: 'odd',
      kind: 'command',
      name: 'odd',
      versionArg: '--version',
      versionRange: { status: 'unsupported', raw: '^1' }
    },
    { id: 'claude', kind: 'agent', provider: 'claude' },
    { id: 'tok', kind: 'env', name: 'ORCA_X' },
    { id: 'gh', kind: 'credential', provider: 'gh' },
    { id: 'os', kind: 'platform', os: 'linux' },
    { id: 'gpu', kind: 'gpu', unsupportedByThisOrca: true },
    { id: 'bad', kind: 'command', malformed: true }
  ]

  it('reduces evaluated rows and drops unsupported and malformed ones', () => {
    const requests = toProbeRequests(rows)
    expect(requests.map((r) => r.id)).toEqual(['git', 'node', 'odd', 'claude', 'tok', 'gh', 'os'])
  })

  it('maps the version demand', () => {
    const byId = new Map(toProbeRequests(rows).map((r) => [r.id, r]))
    expect(byId.get('git')).toMatchObject({ version: 'wanted', versionArg: '--version' })
    expect(byId.get('node')).toMatchObject({ version: 'none', versionArg: '-v' })
    expect(byId.get('odd')).toMatchObject({ version: 'unsupported' })
  })

  it('sends only the one provider detection commands for an agent', () => {
    const agent = toProbeRequests(rows).find((r) => r.id === 'claude')
    expect(agent?.kind).toBe('agent')
    if (agent?.kind === 'agent') {
      expect(agent.commands.length).toBeGreaterThan(0)
      expect(agent.commands.every((c) => c.id === 'claude')).toBe(true)
    }
  })

  it('never copies a prepare text or a description into a request', () => {
    const withText = toProbeRequests([
      {
        id: 'git',
        kind: 'command',
        name: 'git',
        versionArg: '--version',
        prepare: 'rm -rf /sentinel-prepare',
        description: 'sentinel-description'
      }
    ])
    expect(JSON.stringify(withText)).not.toContain('sentinel')
  })
})

describe('parseProbeRequests', () => {
  const good: RequirementProbeRequest[] = [
    { id: 'git', kind: 'command', name: 'git', versionArg: '--version', version: 'wanted' },
    { id: 'tok', kind: 'env', name: 'ORCA_X' },
    { id: 'gh', kind: 'credential', provider: 'gh' },
    { id: 'os', kind: 'platform', os: 'linux', arch: 'x64', platforms: [{ os: 'linux' }] }
  ]

  it('accepts the shapes it produces and strips unknown fields', () => {
    const noisy = good.map((r) => ({ ...r, extra: 'x' }))
    expect(parseProbeRequests(noisy)).toEqual(good)
  })

  it('accepts an agent request', () => {
    const agent = toProbeRequests([{ id: 'claude', kind: 'agent', provider: 'claude' }])
    expect(parseProbeRequests(agent)).toEqual(agent)
  })

  const command = { id: 'a', kind: 'command', versionArg: '--version', version: 'none' }
  it.each([
    ['non-array', { not: 'a list' }],
    ['null', null],
    ['unknown kind', [{ id: 'a', kind: 'gpu' }]],
    ['path as a command name', [{ ...command, name: '../git' }]],
    ['shell metacharacters', [{ ...command, name: 'a;b' }]],
    ['unlisted version argument', [{ ...command, name: 'git', versionArg: '--help' }]],
    ['lowercase env name', [{ id: 'a', kind: 'env', name: 'orca_x' }]],
    ['unknown credential provider', [{ id: 'a', kind: 'credential', provider: 'bitbucket' }]],
    ['missing id', [{ kind: 'env', name: 'ORCA_X' }]],
    ['bad platform os', [{ id: 'a', kind: 'env', name: 'ORCA_X', platforms: [{ os: 'beos' }] }]],
    [
      'agent command with a shell',
      [{ id: 'a', kind: 'agent', provider: 'x', commands: [{ id: 'x', cmd: 'a b;c' }] }]
    ]
  ])('rejects %s', (_label, value) => {
    expect(parseProbeRequests(value)).toBeNull()
  })

  it('rejects more than the per-request cap', () => {
    const many = Array.from({ length: MAX_REQUIREMENTS_PER_REQUEST + 1 }, (_, i) => ({
      id: `e${i}`,
      kind: 'env',
      name: 'ORCA_X'
    }))
    expect(parseProbeRequests(many)).toBeNull()
    expect(parseProbeRequests(many.slice(0, MAX_REQUIREMENTS_PER_REQUEST))).not.toBeNull()
  })
})

describe('platformGateResult', () => {
  const host = { os: 'linux', arch: 'x64' }

  it('skips a request whose platforms exclude the host', () => {
    const request: RequirementProbeRequest = {
      id: 'a',
      kind: 'env',
      name: 'ORCA_X',
      platforms: [{ os: 'darwin' }]
    }
    expect(platformGateResult(request, host)).toEqual({ id: 'a', outcome: 'skipped-platform' })
  })

  it('lets a request through when any platforms entry matches', () => {
    const request: RequirementProbeRequest = {
      id: 'a',
      kind: 'env',
      name: 'ORCA_X',
      platforms: [{ os: 'darwin' }, { os: 'linux', arch: 'x64' }]
    }
    expect(platformGateResult(request, host)).toBeNull()
  })

  it('does not gate a request without platforms', () => {
    expect(platformGateResult({ id: 'a', kind: 'env', name: 'ORCA_X' }, host)).toBeNull()
  })

  it('answers a platform request directly from the measured platform', () => {
    expect(platformGateResult({ id: 'p', kind: 'platform', os: 'linux' }, host)).toEqual({
      id: 'p',
      outcome: 'found'
    })
    expect(platformGateResult({ id: 'p', kind: 'platform', os: 'darwin' }, host)).toEqual({
      id: 'p',
      outcome: 'skipped-platform',
      reason: 'platform-mismatch'
    })
    expect(platformGateResult({ id: 'p', kind: 'platform', arch: 'arm64' }, host)).toMatchObject({
      outcome: 'skipped-platform'
    })
  })

  it('does not guess when the host platform is unknown', () => {
    const unknown = { os: 'unknown', arch: 'unknown' }
    expect(
      platformGateResult(
        { id: 'a', kind: 'env', name: 'ORCA_X', platforms: [{ os: 'linux' }] },
        unknown
      )
    ).toEqual({ id: 'a', outcome: 'failed', reason: 'platform-unknown' })
    expect(platformGateResult({ id: 'p', kind: 'platform', os: 'linux' }, unknown)).toEqual({
      id: 'p',
      outcome: 'failed',
      reason: 'platform-unknown'
    })
  })
})

describe('resultFromVersionOutput', () => {
  it('keeps the version and the resolved path only', () => {
    expect(
      resultFromVersionOutput('git', '/usr/bin/git', 'git version 2.45.1\nsecret-banner-line')
    ).toEqual({ id: 'git', outcome: 'found', resolvedPath: '/usr/bin/git', version: '2.45.1' })
  })

  it('fails with unparseable-version when the output has no version token', () => {
    expect(resultFromVersionOutput('git', '/usr/bin/git', 'hello')).toEqual({
      id: 'git',
      outcome: 'failed',
      reason: 'unparseable-version',
      resolvedPath: '/usr/bin/git'
    })
  })
})

describe('catalog and id grammar', () => {
  it('keeps the request id grammar equal to the recipe id grammar', () => {
    expect(REQUIREMENT_ID_PATTERN.source).toBe(ORCA_VM_RECIPE_ID_PATTERN.source)
  })

  it('accepts every agent in the catalog as a probe request', () => {
    const providers = [...new Set(KNOWN_TUI_AGENT_DETECTION_COMMANDS.map((command) => command.id))]
    expect(providers.length).toBeGreaterThan(5)
    for (const provider of providers) {
      const requests = toProbeRequests([{ id: 'a', kind: 'agent', provider }])
      expect(parseProbeRequests(requests), provider).toEqual(requests)
    }
  })

  it('splits the requests beyond the cap into named failures', () => {
    const requests: RequirementProbeRequest[] = Array.from(
      { length: MAX_REQUIREMENTS_PER_REQUEST + 2 },
      (_, i) => ({ id: `e${i}`, kind: 'env', name: 'ORCA_X' })
    )
    const { accepted, overflow } = splitByRequestCap(requests)
    expect(accepted).toHaveLength(MAX_REQUIREMENTS_PER_REQUEST)
    expect(overflow).toEqual([
      {
        id: `e${MAX_REQUIREMENTS_PER_REQUEST}`,
        outcome: 'failed',
        reason: 'too-many-requirements'
      },
      {
        id: `e${MAX_REQUIREMENTS_PER_REQUEST + 1}`,
        outcome: 'failed',
        reason: 'too-many-requirements'
      }
    ])
  })
})

describe('small helpers', () => {
  it('maps uname architectures', () => {
    expect(mapMeasuredArch('x86_64')).toBe('x64')
    expect(mapMeasuredArch('aarch64')).toBe('arm64')
    expect(mapMeasuredArch('riscv64')).toBe('unknown')
  })

  it('reads authenticated from exit status, then from the CLI own success marker', () => {
    expect(isCredentialAuthenticated('gh', { exitedZero: true, output: '' })).toBe(true)
    expect(
      isCredentialAuthenticated('gh', { exitedZero: false, output: 'Logged in to github.com' })
    ).toBe(true)
    expect(
      isCredentialAuthenticated('gh', { exitedZero: false, output: 'Active account: true' })
    ).toBe(true)
    expect(isCredentialAuthenticated('gh', { exitedZero: false, output: 'not logged' })).toBe(false)
    expect(
      isCredentialAuthenticated('glab', { exitedZero: false, output: 'Active account: true' })
    ).toBe(false)
    expect(
      isCredentialAuthenticated('glab', { exitedZero: false, output: 'Logged in to gitlab.com' })
    ).toBe(true)
  })

  it('maps with bounded concurrency and keeps order', async () => {
    let active = 0
    let peak = 0
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })
})
