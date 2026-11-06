import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

const NAME_ENV = 'ORCA_HEADLESS_COORDINATOR'
const SECRET_ENV = 'ORCA_HEADLESS_COORDINATOR_TOKEN'
const REPLACEMENT_ENV = 'ORCA_HEADLESS_COORDINATOR_NEW_TOKEN'
const REPLACEMENT = 'b'.repeat(64)

function run(command: string, flags: [string, string][], json = true): Promise<unknown> {
  return ORCHESTRATION_HANDLERS[`orchestration ${command}`]({
    flags: new Map<string, string | boolean>(flags),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json
  } as never) as Promise<unknown>
}

describe('Run recovery CLI handlers', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    delete process.env[NAME_ENV]
    delete process.env[SECRET_ENV]
    delete process.env[REPLACEMENT_ENV]
  })

  afterEach(() => {
    delete process.env[NAME_ENV]
    delete process.env[SECRET_ENV]
    delete process.env[REPLACEMENT_ENV]
  })

  it('sends a reset with a long timeout and no secret in its params or output', async () => {
    process.env[NAME_ENV] = 'sidecar'
    process.env[REPLACEMENT_ENV] = REPLACEMENT
    callMock.mockResolvedValue({ result: { run: { id: 'run_1', objective: 'Work' } } })

    await run('run-reset-coordinator', [
      ['run', 'run_1'],
      ['headless', 'sidecar']
    ])

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.runResetCoordinator',
      { run: 'run_1', headless: 'sidecar' },
      { timeoutMs: 300_000 }
    )
    expect(JSON.stringify(callMock.mock.calls)).not.toContain(REPLACEMENT)
    const format = vi.mocked(printResult).mock.calls[0][2] as (value: unknown) => string
    expect(format({ run: { id: 'run_1' } })).toBe('Run run_1 now answers to headless:sidecar.')
  })

  it.each([
    ['no replacement secret', { [NAME_ENV]: 'sidecar' }],
    ['another name', { [NAME_ENV]: 'other', [REPLACEMENT_ENV]: REPLACEMENT }]
  ])('refuses a reset locally with %s', async (_label, env) => {
    Object.assign(process.env, env)

    await expect(
      run('run-reset-coordinator', [
        ['run', 'run_1'],
        ['headless', 'sidecar']
      ])
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('names the coordinator on abandon only when it holds the token', async () => {
    callMock.mockResolvedValue({ result: { runId: 'run_1', warning: 'w', dispatches: [] } })
    process.env[NAME_ENV] = 'sidecar'

    await run('run-abandon', [['run', 'run_1']])
    process.env[SECRET_ENV] = 'a'.repeat(64)
    await run('run-abandon', [['run', 'run_1']])

    expect(callMock.mock.calls[0][1]).toEqual({ run: 'run_1' })
    expect(callMock.mock.calls[1][1]).toEqual({ run: 'run_1', from: 'headless:sidecar' })
  })

  it('lists the terminals an abandon left running', async () => {
    callMock.mockResolvedValue({ result: {} })
    await run('run-abandon', [['run', 'run_1']])

    const format = vi.mocked(printResult).mock.calls[0][2] as (value: unknown) => string

    expect(
      format({
        runId: 'run_1',
        warning: 'Left running.',
        dispatches: [{ dispatchId: 'ctx_1', state: 'abandoned', terminalHandle: 'term_w' }]
      })
    ).toBe('Run run_1 abandoned. Left running.\nctx_1 abandoned terminal=term_w')
  })
})
