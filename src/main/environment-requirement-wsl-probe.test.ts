import { describe, expect, it } from 'vitest'
import { measureRequestsInWsl } from './environment-requirement-wsl-probe'
import { toProbeRequests } from '../shared/environment-requirement-probe-request'
import type {
  RequirementProbeRequest,
  RequirementProbeResult
} from '../shared/environment-requirement-types'

const P = '__ORCA_ENVPROBE__'

type Exec = (script: string) => Promise<{ stdout: string; stderr: string }>

function run(
  requests: RequirementProbeRequest[],
  scripts: { lookup: string; others?: Record<string, { stdout?: string; error?: Error }> }
): Promise<{ platform: { os: string; arch: string }; probes: RequirementProbeResult[] }> & {
  log: string[]
} {
  const log: string[] = []
  const exec: Exec = async (script) => {
    log.push(script)
    if (log.length === 1) {
      return { stdout: scripts.lookup, stderr: '' }
    }
    const hit = Object.entries(scripts.others ?? {}).find(([needle]) => script.includes(needle))
    if (hit?.[1].error) {
      throw hit[1].error
    }
    return { stdout: hit?.[1].stdout ?? '', stderr: '' }
  }
  const promise = measureRequestsInWsl({
    requests,
    workspacePath: '/home/u/project',
    target: { distro: 'Ubuntu' },
    deps: { exec: async (_target, script) => exec(script) }
  }) as Promise<{ platform: { os: string; arch: string }; probes: RequirementProbeResult[] }> & {
    log: string[]
  }
  promise.log = log
  return promise
}

const baseLookup = [
  `${P}U\tx86_64`,
  `${P}W\t/home/u/project`,
  'unrelated shell chatter /usr/bin/spoof'
]

const gitWanted: RequirementProbeRequest = {
  id: 'git',
  kind: 'command',
  name: 'git',
  versionArg: '--version',
  version: 'wanted'
}

function byId(probes: RequirementProbeResult[], id: string): RequirementProbeResult {
  const probe = probes.find((candidate) => candidate.id === id)
  if (!probe) {
    throw new Error(`no probe ${id}`)
  }
  return probe
}

describe('measureRequestsInWsl', () => {
  it('reads linux and the mapped architecture', async () => {
    const result = await run([], { lookup: baseLookup.join('\n') })
    expect(result.platform).toEqual({ os: 'linux', arch: 'x64' })
  })

  it('puts only validated names into the lookup script', async () => {
    const hostile: RequirementProbeRequest = {
      id: 'bad',
      kind: 'command',
      name: "x'; touch /tmp/pwn; echo '",
      versionArg: '--version',
      version: 'none'
    }
    const pending = run([gitWanted, hostile], { lookup: baseLookup.join('\n') })
    const result = await pending
    expect(pending.log[0]).toContain("'git'")
    expect(pending.log[0]).not.toContain('pwn')
    expect(byId(result.probes, 'bad')).toMatchObject({ outcome: 'failed', reason: 'invalid-name' })
  })

  it('finds a command and runs its real path once with the declared argument', async () => {
    const pending = run([gitWanted], {
      lookup: [...baseLookup, `${P}C\tgit\t/usr/bin/git\t/usr/lib/git-core/git`].join('\n'),
      others: { "'/usr/lib/git-core/git'": { stdout: 'git version 2.43.0\n' } }
    })
    const result = await pending
    expect(byId(result.probes, 'git')).toEqual({
      id: 'git',
      outcome: 'found',
      resolvedPath: '/usr/lib/git-core/git',
      version: '2.43.0'
    })
    expect(pending.log).toHaveLength(2)
    expect(pending.log[1]).toBe("'/usr/lib/git-core/git' '--version'")
  })

  it('reports absent only when the lookup ran and printed nothing for the name', async () => {
    const result = await run([gitWanted], { lookup: baseLookup.join('\n') })
    expect(byId(result.probes, 'git')).toEqual({ id: 'git', outcome: 'absent' })
  })

  it('refuses a real path inside the workspace without executing it', async () => {
    const pending = run([gitWanted], {
      lookup: [...baseLookup, `${P}C\tgit\t/home/u/project/bin/git\t/home/u/project/bin/git`].join(
        '\n'
      )
    })
    const result = await pending
    expect(byId(result.probes, 'git')).toEqual({
      id: 'git',
      outcome: 'refused',
      reason: 'resolves-inside-workspace'
    })
    expect(pending.log).toHaveLength(1)
  })

  it('ignores a spoofed non-absolute path', async () => {
    const result = await run([gitWanted], {
      lookup: [...baseLookup, `${P}C\tgit\tC:\\Windows\\git.exe\tC:\\Windows\\git.exe`].join('\n')
    })
    expect(byId(result.probes, 'git')).toEqual({ id: 'git', outcome: 'absent' })
  })

  it('names a failed exec probe-failed', async () => {
    const result = await run([gitWanted], {
      lookup: [...baseLookup, `${P}C\tgit\t/usr/bin/git\t/usr/bin/git`].join('\n'),
      others: { "'/usr/bin/git'": { error: Object.assign(new Error('x'), { code: 1 }) } }
    })
    expect(byId(result.probes, 'git')).toMatchObject({ outcome: 'failed', reason: 'probe-failed' })
  })

  it('reads env presence from marker lines and never asks for a value', async () => {
    const pending = run(
      [
        { id: 'tok', kind: 'env', name: 'ORCA_TOK' },
        { id: 'nope', kind: 'env', name: 'ORCA_NOPE' }
      ],
      { lookup: [...baseLookup, `${P}E\tORCA_TOK`].join('\n') }
    )
    const result = await pending
    expect(byId(result.probes, 'tok')).toEqual({ id: 'tok', outcome: 'found', present: true })
    expect(byId(result.probes, 'nope')).toEqual({ id: 'nope', outcome: 'absent', present: false })
    expect(pending.log[0]).toContain('ORCA_TOK')
    expect(pending.log[0]).not.toMatch(/printf[^\n]*\$ORCA_TOK/)
  })

  it('reads authenticated as a boolean and discards output', async () => {
    const result = await run([{ id: 'gh', kind: 'credential', provider: 'gh' }], {
      lookup: [...baseLookup, `${P}C\tgh\t/usr/bin/gh\t/usr/bin/gh`].join('\n'),
      others: { 'auth status': { stdout: 'token zz-out-zz' } }
    })
    expect(byId(result.probes, 'gh')).toEqual({ id: 'gh', outcome: 'found', authenticated: true })
    expect(JSON.stringify(result)).not.toContain('zz-out-zz')
  })

  it('reports an unauthenticated CLI that exits non-zero', async () => {
    const result = await run([{ id: 'gh', kind: 'credential', provider: 'gh' }], {
      lookup: [...baseLookup, `${P}C\tgh\t/usr/bin/gh\t/usr/bin/gh`].join('\n'),
      others: {
        'auth status': {
          error: Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'nope' })
        }
      }
    })
    expect(byId(result.probes, 'gh')).toEqual({ id: 'gh', outcome: 'found', authenticated: false })
  })

  it('finds an agent from its detection commands', async () => {
    const requests = toProbeRequests([{ id: 'claude', kind: 'agent', provider: 'claude' }])
    const result = await run(requests, {
      lookup: [...baseLookup, `${P}C\tclaude\t/usr/bin/claude\t/usr/bin/claude`].join('\n')
    })
    expect(byId(result.probes, 'claude')).toEqual({ id: 'claude', outcome: 'found' })
  })

  it('gates by platform before anything else', async () => {
    const result = await run(
      [{ id: 'mac', kind: 'env', name: 'ORCA_X', platforms: [{ os: 'darwin' }] }],
      { lookup: baseLookup.join('\n') }
    )
    expect(byId(result.probes, 'mac')).toEqual({ id: 'mac', outcome: 'skipped-platform' })
  })

  it('fails every probe with lookup-failed when the lookup script itself fails', async () => {
    const result = await measureRequestsInWsl({
      requests: [gitWanted],
      workspacePath: '/home/u/project',
      target: {},
      deps: {
        exec: async () => {
          throw new Error('wsl.exe timed out')
        }
      }
    })
    expect(result.platform).toEqual({ os: 'unknown', arch: 'unknown' })
    expect(byId(result.probes, 'git')).toMatchObject({ outcome: 'failed', reason: 'lookup-failed' })
  })

  it('fails with workspace-unreadable when the workspace real path is not reported', async () => {
    const result = await run([gitWanted], {
      lookup: [`${P}U\tx86_64`, `${P}C\tgit\t/usr/bin/git\t/usr/bin/git`].join('\n')
    })
    expect(byId(result.probes, 'git')).toMatchObject({
      outcome: 'failed',
      reason: 'workspace-unreadable'
    })
  })
})
