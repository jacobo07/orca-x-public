import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { printResult } from '../format'
import { normalizeCommandPositionals, parseArgs, specPaths, validateCommandAndFlags } from '../args'
import { COMMAND_SPECS } from '../specs'
import { ORCHESTRATION_HANDLERS } from './orchestration'

const MB = 1024 * 1024
const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

const emptyPlan = {
  result: {
    runId: 'run_1',
    hostCount: 1,
    placements: [{ task_id: 't1', address: 'local', label: 'this pc' }],
    unplaced: [],
    rejected: [],
    notDispatchable: []
  }
}

// Why: the same path the shipped binary takes, argv -> parser -> spec validator -> handler.
async function runMissionPlace(argv: string[]): Promise<void> {
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, COMMAND_PATHS))
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  await ORCHESTRATION_HANDLERS['orchestration mission-place']({
    flags: parsed.flags,
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: parsed.flags.has('json')
  } as never)
}

describe('orca orchestration mission-place argv to RPC', () => {
  beforeEach(() => {
    callMock.mockReset()
    callMock.mockResolvedValue(emptyPlan)
  })

  it('carries --min-vram-mb as the exact byte figure in the recorded call', async () => {
    await runMissionPlace([
      'orchestration',
      'mission-place',
      '--tasks',
      't1',
      '--min-vram-mb',
      '8192',
      '--from',
      'term_coord'
    ])
    expect(callMock).toHaveBeenCalledTimes(1)
    const [method, params] = callMock.mock.calls[0]
    expect(method).toBe('orchestration.missionPlace')
    expect(params.tasks).toEqual(['t1'])
    expect(params.from).toBe('term_coord')
    expect(params.requirement).toStrictEqual({ vram: { minFreeBytes: 8192 * MB } })
    expect(params.requirement).not.toHaveProperty('memory')
    expect(params.requirement).not.toHaveProperty('disk')
  })

  it('maps all three flags to one requirement object', async () => {
    await runMissionPlace([
      'orchestration',
      'mission-place',
      '--tasks',
      't1,t2',
      '--min-available-mb',
      '4096',
      '--min-vram-mb',
      '8192',
      '--min-disk-mb',
      '2048',
      '--from',
      'term_coord'
    ])
    const params = callMock.mock.calls[0][1]
    expect(params.tasks).toEqual(['t1', 't2'])
    expect(params.requirement).toStrictEqual({
      memory: { minAvailableBytes: 4096 * MB },
      disk: { minAvailableBytes: 2048 * MB },
      vram: { minFreeBytes: 8192 * MB }
    })
  })

  it('sends the pre-change params when no resource flag is given', async () => {
    await runMissionPlace([
      'orchestration',
      'mission-place',
      '--tasks',
      't1',
      '--from',
      'term_coord'
    ])
    const params = callMock.mock.calls[0][1]
    expect(params).toStrictEqual({ tasks: ['t1'], run: undefined, from: 'term_coord' })
    expect('requirement' in params).toBe(false)
  })

  it('refuses a bad value before any RPC', async () => {
    await expect(
      runMissionPlace([
        'orchestration',
        'mission-place',
        '--tasks',
        't1',
        '--min-vram-mb',
        '1.5',
        '--from',
        'term_coord'
      ])
    ).rejects.toThrow(/--min-vram-mb/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('still rejects a flag the spec does not list', async () => {
    await expect(
      runMissionPlace([
        'orchestration',
        'mission-place',
        '--tasks',
        't1',
        '--min-gpu-mb',
        '5',
        '--from',
        'term_coord'
      ])
    ).rejects.toThrow(/Unknown flag --min-gpu-mb/)
    expect(callMock).not.toHaveBeenCalled()
  })
})

const GB = 1024 ** 3

type Plan = typeof emptyPlan.result & Record<string, unknown>

// Why: the text a pre-04-04 CLI printed for every result, kept literal so a drift shows as a diff.
const legacyText = (plan: Plan): string =>
  [
    `Mission placed on ${plan.hostCount} host(s) in ${plan.runId}`,
    ...(plan.placements as { task_id: string; label: string; address: string }[]).map(
      (p) => `  ${p.task_id} -> ${p.label} (${p.address})`
    ),
    ...(plan.unplaced as { jobId: string; reason: string }[]).map(
      (u) => `  ${u.jobId}: ${u.reason}`
    )
  ].join('\n')

async function textFor(plan: Plan, extraArgv: string[] = []): Promise<string> {
  vi.mocked(printResult).mockReset()
  callMock.mockResolvedValue({ result: plan })
  await runMissionPlace([
    'orchestration',
    'mission-place',
    '--tasks',
    't1,t2',
    '--from',
    'term_coord',
    ...extraArgv
  ])
  const [response, json, format] = vi.mocked(printResult).mock.calls[0] as unknown as [
    { result: Plan },
    boolean,
    (value: Plan) => string
  ]
  expect(json).toBe(false)
  return format(response.result)
}

const unplacedPlan = (): Plan =>
  ({
    runId: 'run_1',
    hostCount: 3,
    placements: [{ task_id: 't1', address: 'local', label: 'this pc' }],
    unplaced: [{ jobId: 't2', reason: 'no-eligible-host' }],
    rejected: [],
    notDispatchable: [{ address: 'ssh:box', label: 'relay box' }],
    rejectedByJob: [
      {
        jobId: 't2',
        rejected: [
          {
            key: 'runtime:small',
            fingerprint: 'fp-small',
            addresses: ['runtime:small'],
            reasons: [{ reason: 'insufficient-memory', availableMemory: GB, required: 4 * GB }]
          },
          {
            key: 'runtime:mute',
            fingerprint: 'fp-mute',
            addresses: ['runtime:mute'],
            reasons: [
              {
                reason: 'resource-unknown',
                family: 'vram',
                cause: 'unmeasured',
                detail: 'no gpu probe'
              }
            ]
          }
        ]
      }
    ]
  }) as unknown as Plan

describe('mission-place text output', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  it('says why a task is unplaced, per host, with both memory figures and the unmeasured VRAM', async () => {
    const text = await textFor(unplacedPlan())
    const lines = text.split('\n')
    const at = lines.findIndex((line) => line === '  t2: no-eligible-host')
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toMatch(
      /^ {4}x runtime:small: 1(\.0)? GB available, 4(\.0)? GB required$/
    )
    expect(lines[at + 2]).toBe('    x runtime:mute: vram unknown (unmeasured: no gpu probe)')
    expect(text).toContain('relay box (ssh:box)')
    expect(process.exitCode).toBe(1)
  })

  it('prints exactly the old lines when the host sent no rejectedByJob', async () => {
    const plan = unplacedPlan()
    delete (plan as Record<string, unknown>).rejectedByJob
    expect(await textFor(plan)).toBe(legacyText(plan))
    expect(process.exitCode).toBe(1)
  })

  it('leaves the exit code alone when everything is placed', async () => {
    const text = await textFor(emptyPlan.result as Plan)
    expect(text).toBe(legacyText(emptyPlan.result as Plan))
    expect(process.exitCode).toBeUndefined()
  })

  it('passes the result through for --json', async () => {
    vi.mocked(printResult).mockReset()
    const plan = {
      ...unplacedPlan(),
      locality: [{ taskId: 't1', hostKey: 'local', hydrated: true }]
    }
    callMock.mockResolvedValue({ result: plan })
    await runMissionPlace([
      'orchestration',
      'mission-place',
      '--tasks',
      't1,t2',
      '--from',
      'term_coord',
      '--json'
    ])
    const [response, json] = vi.mocked(printResult).mock.calls[0] as unknown as [
      { result: Plan },
      boolean
    ]
    expect(json).toBe(true)
    expect(response.result).toBe(plan)
  })

  it('marks a placement whose locality entry says hydrated, and only that one', async () => {
    const plan = {
      runId: 'run_1',
      hostCount: 2,
      placements: [
        { task_id: 't1', address: 'runtime:gex', label: 'gex44' },
        { task_id: 't2', address: 'local', label: 'this pc' }
      ],
      unplaced: [],
      rejected: [],
      notDispatchable: [],
      locality: [
        { taskId: 't1', hostKey: 'fp-gex', hydrated: true },
        { taskId: 't2', hostKey: 'local', hydrated: false }
      ]
    } as unknown as Plan
    const lines = (await textFor(plan)).split('\n')
    expect(lines.find((line) => line.includes('t1 ->'))).toBe(
      '  t1 -> gex44 (runtime:gex) [project already there]'
    )
    expect(lines.find((line) => line.includes('t2 ->'))).toBe('  t2 -> this pc (local)')
  })

  it('prints the old text when the result has no locality list', async () => {
    const plan = {
      runId: 'run_1',
      hostCount: 2,
      placements: [
        { task_id: 't1', address: 'runtime:gex', label: 'gex44' },
        { task_id: 't2', address: 'local', label: 'this pc' }
      ],
      unplaced: [],
      rejected: [],
      notDispatchable: []
    } as unknown as Plan
    expect(await textFor(plan)).toBe(legacyText(plan))
  })
})

const USAGE_PREFIX = 'orca orchestration mission-place'

// Why: __dirname works under both Vitest and the CommonJS tsc emit that type-checks this file.
const SPEC_DOC = join(__dirname, '..', '..', '..', 'docs', 'cross-host-mission-dispatch-spec.md')

function documentedUsageLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .flatMap((line) => line.match(/`orca orchestration mission-place[^`]*`/g) ?? [])
    .map((span) => span.slice(1, -1))
}

// Why: placeholders become fixed values and optional brackets are dropped, so the line runs as typed.
function runnableForm(usage: string): string[] {
  return usage
    .replace(/<n>/g, '1024')
    .replace(/<[^>]+>/g, 'x1')
    .replace(/[[\]]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(1)
}

function validateUsage(usage: string): void {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(runnableForm(usage), COMMAND_PATHS)
  )
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  expect(parsed.commandPath).toEqual(['orchestration', 'mission-place'])
  expect(parsed.flags.get('tasks')).toEqual(expect.any(String))
}

describe('cross-host dispatch spec usage lines', () => {
  const lines = documentedUsageLines(readFileSync(SPEC_DOC, 'utf8'))

  it('documents the plain command and the resource flags, and the parser accepts each', () => {
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.some((line) => line.includes('--min-vram-mb'))).toBe(true)
    for (const line of lines) {
      validateUsage(line)
    }
  })

  it('station control: a usage line with an unknown flag or the old repeated form is refused', () => {
    expect(() => validateUsage(`${USAGE_PREFIX} --tasks <a,b> --min-gpu-mb <n>`)).toThrow(
      /Unknown flag/
    )
    expect(() => validateUsage(`${USAGE_PREFIX} --task <a> --task <b>`)).toThrow()
  })
})
// Why: a host that predates a verb answers method-not-found; the CLI must surface it, not invent a plan.
describe('old host without the mission verbs', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockClear()
    process.exitCode = undefined
  })

  it('mission-place surfaces the host refusal and prints no placement', async () => {
    callMock.mockRejectedValue(new Error('method_not_found: orchestration.missionPlace'))
    await expect(
      runMissionPlace(['orchestration', 'mission-place', '--tasks', 't1', '--from', 'term_coord'])
    ).rejects.toThrow('method_not_found')
    expect(printResult).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('mission-results surfaces the host refusal and prints no results', async () => {
    callMock.mockRejectedValue(new Error('method_not_found: orchestration.missionResults'))
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['orchestration', 'mission-results', '--run', 'run_1'], COMMAND_PATHS)
    )
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    await expect(
      ORCHESTRATION_HANDLERS['orchestration mission-results']({
        flags: parsed.flags,
        client: { call: callMock },
        cwd: '/tmp/repo',
        json: false
      } as never)
    ).rejects.toThrow('method_not_found')
    expect(printResult).not.toHaveBeenCalled()
  })
})
