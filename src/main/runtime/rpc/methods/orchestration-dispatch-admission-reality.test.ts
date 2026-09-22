// Product Reality for W4: the real orchestration.dispatch method, a real OrcaRuntimeService, a real
// file-backed SQLite database through its real migration, and a REAL host memory reading.
//
// What is stubbed and why: a test has no PTY, so the executor identity (hostScope) is supplied --
// without it every case refuses as executor-unknown and the positive control could not exist. The
// NUMBER is not supplied: collectHostMemory runs against this machine, and the two cases sit either
// side of anything it can return.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'

const PANE_KEY = 'tab_w:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKER = 'term_worker'

// No real machine has this, and none has less than one byte. TB not PB: the parser knows no
// petabyte unit, so `1024PB` refused as malformed -- the right verdict for the wrong reason, which
// the "nothing starts" case could not see and only the reason assertion caught. 8000TB is also the
// largest round value that stays under the safe-integer ceiling the parser enforces.
const MORE_THAN_ANY_HOST = '8000TB'
const LESS_THAN_ANY_HOST = '1B'

describe('orchestration.dispatch admission, against a real database and a real host reading', () => {
  let dir: string
  let dbPath: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let prompts: string[]
  let runId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-w4-reality-'))
    dbPath = join(dir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    prompts = []

    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === WORKER ? PANE_KEY : 'tab_coord:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(`pty_w:${WORKER}:1`)
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      runtimeId: 'runtime_test',
      terminalHandle: WORKER,
      ptyId: 'pty_w',
      worktreeId: 'wt1',
      processIncarnation: `pty_w:${WORKER}:1`,
      paneKey: PANE_KEY,
      launchTokenHash: 'launch-token-hash',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (_handle, prompt) => {
      prompts.push(prompt)
      return { handle: WORKER, accepted: true, bytesWritten: prompt.length }
    })

    ctx = { runtime }
    runId = db.createRun({
      objective: 'W4 product reality',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }).id
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      db.close()
    } catch {
      // already closed by a test that reopened the file
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function dispatch(spec: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === 'orchestration.dispatch')!
    const task = db.createTask({ spec, runId })
    const params = method.params!.parse({
      task: task.id,
      to: WORKER,
      from: 'term_coord',
      run: runId,
      inject: true
    })
    return { task, call: () => method.handler(params, ctx) }
  }

  it('refuses a requirement no real host can meet, and nothing starts', async () => {
    const { task, call } = await dispatch(`do the work\nmin-available-memory: ${MORE_THAN_ANY_HOST}`)

    await expect(call()).rejects.toBeInstanceOf(OrchestrationError)

    // Negative-effect proof: no reservation, no prompt, task still dispatchable.
    expect(db.getDispatchContext(task.id)).toBeUndefined()
    expect(prompts).toEqual([])
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('names the refusal so a caller learns what to fix', async () => {
    const { call } = await dispatch(`work\nmin-available-memory: ${MORE_THAN_ANY_HOST}`)

    const error = await call().catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OrchestrationError)
    expect((error as OrchestrationError).code).toBe('resource_admission_refused')
    expect((error as OrchestrationError).data).toMatchObject({
      reason: 'insufficient-available-memory'
    })
  })

  // Without this, "refuses everything" would pass every assertion above.
  it('positive control: admits what this host can meet and really does start it', async () => {
    const { task, call } = await dispatch(`do the work\nmin-available-memory: ${LESS_THAN_ANY_HOST}`)

    await call()

    expect(db.getDispatchContext(task.id)).toBeTruthy()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('do the work')
    expect(prompts[0]).not.toContain('min-available-memory')
  })

  it('the envelope survives closing and reopening the database', async () => {
    const { task, call } = await dispatch(`work\nmin-available-memory: ${LESS_THAN_ANY_HOST}`)
    await call()
    db.close()

    const reopened = new OrchestrationDb(dbPath)
    const envelope = JSON.parse(reopened.getDispatchContext(task.id)!.admission_envelope!)
    reopened.close()

    expect(envelope).toMatchObject({
      schema: 'orca.dispatch-admission/1',
      reason: 'requirement-satisfied',
      requirement: { minAvailableMemoryBytes: 1 }
    })
    // The number came from this machine, not from the test.
    expect(envelope.observation.availableMemoryBytes).toBeGreaterThan(0)
    expect(['memory-pressure', 'proc-meminfo', 'free-memory']).toContain(
      envelope.observation.source
    )
  })
})
