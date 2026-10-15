import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

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
    json: false
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
