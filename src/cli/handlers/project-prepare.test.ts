import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EnvironmentRequirementsMeasurement } from '../../shared/environment-requirements-measurement'
import { RuntimeClientError } from '../runtime-client'
import { PROJECT_HANDLERS } from './project'

// Same fixture as src/shared/environment-prepare-hash.test.ts, whose digest was computed outside
// the code under test.
const KAT_SHA256 = '8dff3ebaa86b6b64d9317074f2dfc2af2b53e8b7fdc5451993ebb7c523944635'
const KAT_HOST = 'ssh:t1@0123456789abcdef'
const KAT_BYTES = '  mkdir -p "$HOME/p20-bin"\n  printf \'x\' > "$HOME/p20-bin/s"  \n'

function measurement(
  overrides: Partial<EnvironmentRequirementsMeasurement> = {}
): EnvironmentRequirementsMeasurement {
  return {
    contractSource: { hostKey: KAT_HOST, path: '/work/orca.yaml', contentHash: 'c'.repeat(64) },
    contract: 'parsed',
    diagnostics: [],
    requirements: [
      { id: 'shim', kind: 'command', name: 'shim', versionArg: '--version', prepare: KAT_BYTES },
      { id: 'git', kind: 'command', name: 'git', versionArg: '--version' }
    ],
    measurement: {
      status: 'measured',
      at: 1,
      hostKey: KAT_HOST,
      platform: { os: 'linux', arch: 'x64' },
      probes: [
        { id: 'shim', outcome: 'absent' },
        { id: 'git', outcome: 'found', version: '2.52.0' }
      ]
    },
    ...overrides
  }
}

type Call = { method: string; params: Record<string, unknown> }

async function run(
  flagEntries: [string, string | boolean][],
  answers: { measure?: unknown; run?: unknown } = {},
  calls: Call[] = []
): Promise<{ calls: Call[]; output: string }> {
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      const result =
        method === 'environment.measureRequirements'
          ? (answers.measure ?? measurement())
          : answers.run
      return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt-1' } }
    }
  }
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => void lines.push(args.join(' '))
  try {
    await PROJECT_HANDLERS['project prepare']({
      client: client as never,
      flags: new Map(flagEntries),
      cwd: '.',
      json: flagEntries.some(([name]) => name === 'json')
    })
  } finally {
    console.log = original
  }
  return { calls, output: lines.join('\n') }
}

let savedExitCode: typeof process.exitCode

beforeEach(() => {
  savedExitCode = process.exitCode
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = savedExitCode
})

describe('orca project prepare --plan', () => {
  it('prints the exact bytes, the labels and the hash to approve, and runs nothing', async () => {
    const { calls, output } = await run([
      ['repo', 'path:/work/app'],
      ['plan', true]
    ])
    expect(calls.map((call) => call.method)).toEqual(['environment.measureRequirements'])
    expect(calls[0].params).toEqual({ repo: 'path:/work/app' })
    expect(output).toContain(KAT_BYTES)
    expect(output).toContain(JSON.stringify(KAT_BYTES))
    expect(output).toContain(`approval hash: ${KAT_SHA256}`)
    expect(output).toContain(
      `orca project prepare --repo path:/work/app --requirement shim --approve ${KAT_SHA256}`
    )
    expect(output).not.toContain('requirement git')
  })

  it('labels a step that asks for elevation or runs a repository script', async () => {
    const { output } = await run(
      [
        ['repo', 'id:r1'],
        ['plan', true]
      ],
      {
        measure: measurement({
          requirements: [
            {
              id: 'shim',
              kind: 'command',
              name: 'shim',
              versionArg: '--version',
              prepare: 'sudo apt-get install -y shim'
            },
            {
              id: 'git',
              kind: 'command',
              name: 'git',
              versionArg: '--version',
              prepare: './scripts/setup.sh'
            }
          ]
        })
      }
    )
    expect(output).toContain('asks for elevated privileges')
    expect(output).toContain('repository script')
  })

  it('--json prints the plan and the approvals', async () => {
    const { output } = await run([
      ['repo', 'id:r1'],
      ['plan', true],
      ['json', true]
    ])
    const parsed = JSON.parse(output) as {
      result: {
        plan: { steps: { requirementId: string; bytes: string }[] }
        approvals: { requirementId: string; hash: string; hostKey: string }[]
      }
    }
    expect(parsed.result.approvals).toEqual([
      { requirementId: 'shim', hash: KAT_SHA256, hostKey: KAT_HOST }
    ])
    expect(parsed.result.plan.steps[0].bytes).toBe(KAT_BYTES)
  })

  it('says so when no step is declared and when the contract cannot be read', async () => {
    const none = await run(
      [
        ['repo', 'id:r1'],
        ['plan', true]
      ],
      {
        measure: measurement({ requirements: [] })
      }
    )
    expect(none.output).toContain('No prepare steps declared')
    const unreadable = await run(
      [
        ['repo', 'id:r1'],
        ['plan', true]
      ],
      {
        measure: measurement({ contract: 'unreadable', contractSource: null, requirements: [] })
      }
    )
    expect(unreadable.output).toContain('UNREADABLE')
    expect(unreadable.output).not.toContain('No prepare steps declared')
  })
})

describe('orca project prepare --requirement --approve', () => {
  it('runs one approved step by id and hash, without command text, and exits 0 when started', async () => {
    const { calls, output } = await run(
      [
        ['repo', 'path:/work/app'],
        ['requirement', 'shim'],
        ['approve', KAT_SHA256]
      ],
      { run: { status: 'started', terminal: { handle: 'h' } } }
    )
    expect(calls.map((call) => call.method)).toEqual([
      'environment.measureRequirements',
      'environment.runPrepareStep'
    ])
    expect(calls[1].params).toEqual({
      repo: 'path:/work/app',
      requirementId: 'shim',
      approvedContentHash: KAT_SHA256,
      approvedHostKey: KAT_HOST
    })
    expect(Object.keys(calls[1].params)).not.toContain('command')
    expect(output).toBe('started')
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('prints the refusal and exits 1', async () => {
    const { output } = await run(
      [
        ['repo', 'id:r1'],
        ['requirement', 'shim'],
        ['approve', KAT_SHA256]
      ],
      { run: { status: 'refused', reason: 'contract-changed' } }
    )
    expect(output).toBe('refused: contract-changed')
    expect(process.exitCode).toBe(1)
  })

  it('rejects a malformed hash before any call', async () => {
    const calls: Call[] = []
    await expect(
      run(
        [
          ['repo', 'id:r1'],
          ['requirement', 'shim'],
          ['approve', 'ABC']
        ],
        {},
        calls
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(calls).toEqual([])
  })
})

describe('orca project prepare usage', () => {
  it('needs exactly one of --plan and --approve', async () => {
    await expect(run([['repo', 'id:r1']])).rejects.toBeInstanceOf(RuntimeClientError)
    await expect(
      run([
        ['repo', 'id:r1'],
        ['plan', true],
        ['requirement', 'shim'],
        ['approve', KAT_SHA256]
      ])
    ).rejects.toBeInstanceOf(RuntimeClientError)
  })

  it('needs --requirement with --approve and refuses it with --plan', async () => {
    await expect(
      run([
        ['repo', 'id:r1'],
        ['approve', KAT_SHA256]
      ])
    ).rejects.toBeInstanceOf(RuntimeClientError)
    await expect(
      run([
        ['repo', 'id:r1'],
        ['plan', true],
        ['requirement', 'shim']
      ])
    ).rejects.toBeInstanceOf(RuntimeClientError)
  })
})
