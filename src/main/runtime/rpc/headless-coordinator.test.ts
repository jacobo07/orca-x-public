import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { withCurrentOrchestrationContract } from '../runtime-rpc-test-harness'
import { RpcDispatcher } from './dispatcher'

const H = 'headless:sidecar'
const token = (): string => randomBytes(32).toString('hex')

type Reply = { ok: boolean; result?: Record<string, unknown>; error?: { code: string } }

describe('headless coordinator (K4a)', () => {
  let db: OrchestrationDb
  let dispatcher: RpcDispatcher
  let seq = 0

  beforeEach(() => {
    const runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime })
  })

  afterEach(() => {
    db.close()
  })

  function request(
    method: string,
    params: Record<string, unknown>,
    envelope: Record<string, unknown> = {}
  ) {
    seq += 1
    return withCurrentOrchestrationContract({
      id: `req-${seq}`,
      authToken: 'local',
      method,
      params,
      orchestrationRequestId: `k4a-request-${seq}`,
      ...envelope
    }) as never
  }

  async function local(
    method: string,
    params: Record<string, unknown>,
    envelope: Record<string, unknown> = {}
  ): Promise<Reply> {
    return (await dispatcher.dispatch(request(method, params, envelope))) as unknown as Reply
  }

  async function paired(
    method: string,
    params: Record<string, unknown>,
    envelope: Record<string, unknown> = {}
  ): Promise<Reply> {
    const replies: Reply[] = []
    await dispatcher.dispatchStreaming(
      request(method, params, envelope),
      (raw) => replies.push(JSON.parse(raw) as Reply),
      { pairedDeviceId: 'device-1' } as never
    )
    return replies[0]!
  }

  async function createHeadlessRun(secret: string): Promise<string> {
    const created = await local(
      'orchestration.runCreate',
      { objective: 'Sidecar dispatch', from: H },
      { orchestrationCoordinatorToken: secret }
    )
    expect(created).toMatchObject({ ok: true })
    return (created.result!.run as { id: string }).id
  }

  function storedText(): string {
    const sqlite = db['db']
    return JSON.stringify([
      sqlite.prepare('SELECT * FROM mutation_receipts').all(),
      sqlite.prepare('SELECT id, objective, coordinator_handle FROM runs').all()
    ])
  }

  it('creates a headless Run locally and never returns or stores the token', async () => {
    const secret = token()
    const runId = await createHeadlessRun(secret)

    const shown = await local('orchestration.runShow', { id: runId })
    const listed = await local('orchestration.runList', {})

    expect(shown.result!.run).toMatchObject({ coordinator_handle: H })
    for (const reply of [shown, listed]) {
      expect(JSON.stringify(reply)).not.toContain('coordinator_token_hash')
      expect(JSON.stringify(reply)).not.toContain(secret)
    }
    expect(storedText()).not.toContain(secret)
    expect(db.getCoordinatorTokenHash(runId)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses headless identity from a paired remote, without a token, or with a bad name', async () => {
    const secret = token()
    expect(
      await paired(
        'orchestration.runCreate',
        { objective: 'x', from: H },
        { orchestrationCoordinatorToken: secret }
      )
    ).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(await local('orchestration.runCreate', { objective: 'x', from: H })).toMatchObject({
      ok: false,
      error: { code: 'coordinator_auth_failed' }
    })
    expect(
      await local(
        'orchestration.runCreate',
        { objective: 'x', from: 'headless:0f8fad5b-d9cb-469f-a165-70867728950e' },
        { orchestrationCoordinatorToken: secret }
      )
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    // Why filter: a fresh database already holds the built-in legacy Run.
    expect(db.listRuns().runs.filter((run) => run.legacy === 0)).toHaveLength(0)
  })

  it('keeps a bound name for its owner', async () => {
    const secret = token()
    const runId = await createHeadlessRun(secret)

    const hijack = await local(
      'orchestration.runCreate',
      { objective: 'hijack', from: H },
      { orchestrationCoordinatorToken: token() }
    )

    expect(hijack).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(db.getCurrentRunForPane(H)?.id).toBe(runId)
  })

  it.each([
    ['orchestration.check', { terminal: H }],
    ['orchestration.check', { terminal: 'term_unknown', terminalPaneKey: H }],
    ['orchestration.send', { from: H, to: 'term_other', subject: 'hi' }],
    ['orchestration.send', { from: 'term_x', senderPaneKey: H, to: 'term_other', subject: 'hi' }],
    ['orchestration.taskCreate', { spec: 'work', callerTerminalHandle: H }]
  ])('refuses %s with a headless identity and a wrong token', async (method, params) => {
    const secret = token()
    const runId = await createHeadlessRun(secret)
    db.insertMessage({ runId, from: 'dispatch:ctx_1', to: `run:${runId}`, subject: 'done' })
    const tasksBefore = db.listTasks().length

    const refused = await local(method, params, { orchestrationCoordinatorToken: token() })
    const noToken = await local(method, params)

    expect(refused).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(noToken).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(db.listTasks()).toHaveLength(tasksBefore)
    // Why: the refused calls must not have consumed the mail; the owner still reads it.
    const owner = await local(
      'orchestration.check',
      { terminal: H },
      { orchestrationCoordinatorToken: secret }
    )
    expect(JSON.stringify(owner.result)).toContain('done')
  })

  it('lets the owner create tasks and read its Run mailbox', async () => {
    const secret = token()
    const runId = await createHeadlessRun(secret)
    db.insertMessage({ runId, from: 'dispatch:ctx_1', to: `run:${runId}`, subject: 'worker done' })
    const auth = { orchestrationCoordinatorToken: secret }

    const task = await local(
      'orchestration.taskCreate',
      { spec: 'work', callerTerminalHandle: H },
      auth
    )
    const check = await local('orchestration.check', { terminal: H }, auth)

    expect(task).toMatchObject({ ok: true })
    expect(db.listTasks()[0]).toMatchObject({ run_id: runId })
    expect(check).toMatchObject({ ok: true })
    expect(JSON.stringify(check.result)).toContain('worker done')
  })

  it('rotates the token on run-use, after which the old token fails', async () => {
    const oldSecret = token()
    const newSecret = token()
    const runId = await createHeadlessRun(oldSecret)

    const rebound = await local(
      'orchestration.runUse',
      { id: runId, from: H },
      { orchestrationCoordinatorToken: oldSecret, orchestrationNewCoordinatorToken: newSecret }
    )
    const withOld = await local(
      'orchestration.check',
      { terminal: H },
      { orchestrationCoordinatorToken: oldSecret }
    )
    const withNew = await local(
      'orchestration.check',
      { terminal: H },
      { orchestrationCoordinatorToken: newSecret }
    )

    expect(rebound).toMatchObject({ ok: true })
    expect(withOld).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(withNew).toMatchObject({ ok: true })
  })

  it('accepts a retried rotation that presents the new token', async () => {
    const oldSecret = token()
    const newSecret = token()
    const runId = await createHeadlessRun(oldSecret)
    const rotation = request(
      'orchestration.runUse',
      { id: runId, from: H },
      { orchestrationCoordinatorToken: oldSecret, orchestrationNewCoordinatorToken: newSecret }
    )

    const first = (await dispatcher.dispatch(rotation)) as unknown as Reply
    const retry = (await dispatcher.dispatch(rotation)) as unknown as Reply

    expect(first).toMatchObject({ ok: true })
    expect(retry).toMatchObject({ ok: true })
  })

  it('refuses a terminal run-use of a headless Run and keeps the owner in charge', async () => {
    const secret = token()
    const runId = await createHeadlessRun(secret)

    const takeover = await local('orchestration.runUse', { id: runId, from: 'term_intruder' })

    expect(takeover).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(db.getCoordinatorTokenHash(runId)).not.toBeNull()
    expect(db.getCurrentRunForPane(H)?.id).toBe(runId)
    expect(
      await local('orchestration.check', { terminal: H }, { orchestrationCoordinatorToken: secret })
    ).toMatchObject({ ok: true })
  })

  it('refuses reading a headless Run mailbox by its address without the token', async () => {
    const secret = token()
    const runId = await createHeadlessRun(secret)
    db.insertMessage({ runId, from: 'dispatch:ctx_1', to: `run:${runId}`, subject: 'kept' })

    const byAddress = await local('orchestration.check', { terminal: `run:${runId}` })
    const inbox = await local('orchestration.inbox', { terminal: `run:${runId}` })

    expect(byAddress).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(inbox).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    const owner = await local(
      'orchestration.check',
      { terminal: H },
      { orchestrationCoordinatorToken: secret }
    )
    expect(JSON.stringify(owner.result)).toContain('kept')
  })

  it('refuses binding a name that another headless Run holds, without that Run token', async () => {
    const secretA = token()
    const secretB = token()
    const runA = await createHeadlessRun(secretA)
    const other = 'headless:other'
    const createdB = await local(
      'orchestration.runCreate',
      { objective: 'B', from: other },
      { orchestrationCoordinatorToken: secretB }
    )
    const runB = (createdB.result!.run as { id: string }).id

    const steal = await local(
      'orchestration.runUse',
      { id: runA, from: other },
      { orchestrationCoordinatorToken: secretA }
    )

    expect(steal).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(db.getCurrentRunForPane(other)?.id).toBe(runB)
  })
})
