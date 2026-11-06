import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { withCurrentOrchestrationContract } from '../runtime-rpc-test-harness'
import { RpcDispatcher } from './dispatcher'

const H = 'headless:sidecar'
const RESET = 'orchestration.runResetCoordinator'
const ABANDON = 'orchestration.runAbandon'
const token = (): string => randomBytes(32).toString('hex')

type Reply = { ok: boolean; result?: Record<string, unknown>; error?: { code: string } }

describe('headless Run recovery (K4c-2)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatcher: RpcDispatcher
  let seq = 0
  let secret = ''
  let runId = ''

  beforeEach(async () => {
    runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime })
    secret = token()
    const created = await local(
      'orchestration.runCreate',
      { objective: 'Sidecar dispatch', from: H },
      { orchestrationCoordinatorToken: secret }
    )
    runId = (created.result!.run as { id: string }).id
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  function request(
    method: string,
    params: Record<string, unknown>,
    envelope: Record<string, unknown>
  ): never {
    seq += 1
    return withCurrentOrchestrationContract({
      id: `req-${seq}`,
      authToken: 'local',
      method,
      params,
      orchestrationRequestId: `k4c2-request-${seq}`,
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
    return (await dispatcher.dispatch(request(method, params, envelope), {
      authenticatedCallerFingerprint: 'paired-device'
    })) as unknown as Reply
  }

  const owner = (): Record<string, unknown> => ({ orchestrationCoordinatorToken: secret })
  const replacement = (value: string): Record<string, unknown> => ({
    orchestrationNewCoordinatorToken: value
  })
  const confirmWith = (answer: boolean) => {
    const confirmer = vi.fn(async () => answer)
    runtime.setCoordinatorRecoveryConfirmer(confirmer)
    return confirmer
  }
  const reset = (envelope: Record<string, unknown>, name = 'sidecar'): Promise<Reply> =>
    local(RESET, { run: runId, headless: name }, envelope)

  function liveDispatch(): { taskId: string; dispatchId: string } {
    const task = db.createTask({ spec: 'work', runId } as never)
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    return { taskId: task.id, dispatchId: dispatch.id }
  }

  it.each([
    [RESET, { run: 'x', headless: 'sidecar' }],
    [ABANDON, { run: 'x' }]
  ])('refuses %s from a paired caller before asking anyone', async (method, params) => {
    const confirmer = confirmWith(true)

    const refused = await paired(
      method,
      { ...params, run: runId },
      { ...owner(), ...replacement(token()) }
    )

    expect(refused).toMatchObject({ ok: false, error: { code: 'remote_caller_refused' } })
    expect(confirmer).not.toHaveBeenCalled()
    expect(db.getRun(runId)?.coordinator_handle).toBe(H)
  })

  it('refuses a reset on a host with no desktop confirmation', async () => {
    const before = db.getCoordinatorTokenHash(runId)

    const refused = await reset(replacement(token()))

    expect(refused).toMatchObject({ ok: false, error: { code: 'confirmation_unavailable' } })
    expect(db.getCoordinatorTokenHash(runId)).toBe(before)
  })

  it('applies nothing when the Owner declines the reset', async () => {
    const confirmer = confirmWith(false)
    const before = db.getRun(runId)?.consumer_generation

    const refused = await reset(replacement(token()))

    expect(refused).toMatchObject({ ok: false, error: { code: 'confirmation_declined' } })
    expect(confirmer).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reset-coordinator',
        runId,
        objective: 'Sidecar dispatch',
        coordinatorHandle: H,
        newCoordinatorHandle: H
      }),
      undefined
    )
    expect(db.getRun(runId)?.consumer_generation).toBe(before)
    expect(db.listRunEvents(runId)).toEqual([])
  })

  it.each([[{}], [{ orchestrationNewCoordinatorToken: 'short' }]])(
    'refuses a reset without a well-formed replacement token: %j',
    async (envelope) => {
      const confirmer = confirmWith(true)

      const refused = await reset(envelope)

      expect(refused).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
      expect(confirmer).not.toHaveBeenCalled()
    }
  )

  it('moves the Run to the new token, keeps its mail and fences the old delivery', async () => {
    confirmWith(true)
    const mail = db.insertMessage({ runId, from: 'term_worker', to: `run:${runId}`, subject: 'd' })
    const generation = db.getRun(runId)!.consumer_generation
    const delivery = db.getOrCreateRunDelivery({ runId, consumerGeneration: generation })!
    const next = token()

    const done = await reset(replacement(next))

    expect(done).toMatchObject({ ok: true, result: { run: { id: runId } } })
    expect(db.getRun(runId)?.consumer_generation).toBe(generation + 1)
    expect(db.hasOutstandingRunDelivery(runId)).toBe(false)
    expect(delivery.messages.map((message) => message.id)).toContain(mail.id)
    const stale = await local('orchestration.runCurrent', { from: H }, owner())
    expect(stale).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    const fresh = await local(
      'orchestration.runCurrent',
      { from: H },
      { orchestrationCoordinatorToken: next }
    )
    expect(fresh).toMatchObject({ ok: true, result: { run: { id: runId } } })
    expect(db.getMessageById(mail.id)?.read).toBeFalsy()
  })

  it('records the reset as a Run event that carries no token or hash', async () => {
    confirmWith(true)
    const next = token()

    await reset(replacement(next))

    const shown = await local('orchestration.runShow', { id: runId })
    const serialized = JSON.stringify(shown.result)
    expect(shown.result!.events).toEqual([
      expect.objectContaining({ subject: 'run_coordinator_reset' })
    ])
    expect(serialized).not.toContain(next)
    expect(serialized).not.toContain(db.getCoordinatorTokenHash(runId))
  })

  it('replays a retried reset only with the same replacement secret', async () => {
    confirmWith(true)
    const next = token()
    const retry = { orchestrationRequestId: 'k4c2-fixed-reset' }

    await reset({ ...replacement(next), ...retry })
    const hash = db.getCoordinatorTokenHash(runId)
    const same = await reset({ ...replacement(next), ...retry })
    const different = await reset({ ...replacement(token()), ...retry })

    expect(same).toMatchObject({ ok: true })
    expect(different).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(db.getCoordinatorTokenHash(runId)).toBe(hash)
    expect(db.listRunEvents(runId)).toHaveLength(1)
  })

  it('does not act on a Yes that lands after the caller left', async () => {
    const caller = new AbortController()
    runtime.setCoordinatorRecoveryConfirmer(async () => {
      caller.abort()
      return true
    })
    const before = db.getCoordinatorTokenHash(runId)

    const refused = (await dispatcher.dispatch(
      request(RESET, { run: runId, headless: 'sidecar' }, replacement(token())),
      { signal: caller.signal }
    )) as unknown as Reply

    expect(refused).toMatchObject({ ok: false, error: { code: 'confirmation_declined' } })
    expect(db.getCoordinatorTokenHash(runId)).toBe(before)
  })

  it('refuses a reset onto a name another Run holds', async () => {
    confirmWith(true)
    const other = token()
    await local(
      'orchestration.runCreate',
      { objective: 'Other', from: 'headless:other' },
      { orchestrationCoordinatorToken: other }
    )
    const before = db.getCoordinatorTokenHash(runId)

    const refused = await reset(replacement(token()), 'other')

    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(db.getCoordinatorTokenHash(runId)).toBe(before)
  })

  it('refuses a reset when the Run moved while the dialog was open', async () => {
    runtime.setCoordinatorRecoveryConfirmer(async () => {
      db.rotateCoordinatorTokenHash(runId, 'a'.repeat(64))
      db.bindRun({
        runId,
        coordinatorHandle: 'headless:moved',
        coordinatorPaneKey: 'headless:moved',
        coordinatorTokenHash: 'a'.repeat(64)
      })
      return true
    })

    const refused = await reset(replacement(token()))

    expect(refused).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(db.getCoordinatorTokenHash(runId)).toBe('a'.repeat(64))
  })

  it.each([RESET, ABANDON])('refuses %s on a Run with a terminal coordinator', async (method) => {
    const confirmer = confirmWith(true)
    const terminalRun = db.createRun({
      objective: 'Terminal',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: 'tab_c:leaf_c'
    })

    const refused = await local(
      method,
      { run: terminalRun.id, headless: 'sidecar' },
      replacement(token())
    )

    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(confirmer).not.toHaveBeenCalled()
  })

  it('lets the token holder abandon its Run without a dialog and keeps processes alive', async () => {
    const confirmer = confirmWith(false)
    const { taskId, dispatchId } = liveDispatch()

    const done = await local(ABANDON, { run: runId, from: H }, owner())

    expect(done).toMatchObject({
      ok: true,
      result: { runId, processAction: 'none', dispatches: [{ dispatchId }] }
    })
    expect(confirmer).not.toHaveBeenCalled()
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('failed')
    expect(db.getDispatchContext(taskId)?.id).toBe(dispatchId)
    expect(db.getRun(runId)?.coordinator_handle).toBeNull()
    expect(db.listRunEvents(runId)).toEqual([expect.objectContaining({ subject: 'run_abandoned' })])
  })

  it('replays an owner abandon retried after the Run lost its binding', async () => {
    const retry = { ...owner(), orchestrationRequestId: 'k4c2-fixed-abandon' }

    await local(ABANDON, { run: runId, from: H }, retry)
    const again = await local(ABANDON, { run: runId, from: H }, retry)

    expect(again).toMatchObject({ ok: true, result: { runId } })
    expect(db.listRunEvents(runId)).toHaveLength(1)
  })

  it('makes every other caller go through the dialog', async () => {
    const { dispatchId } = liveDispatch()
    const declined = confirmWith(false)

    const refused = await local(ABANDON, { run: runId, from: 'term_worker' })

    expect(refused).toMatchObject({ ok: false, error: { code: 'confirmation_declined' } })
    expect(declined).toHaveBeenCalledOnce()
    expect(db.getDispatchContextById(dispatchId)?.status).not.toBe('failed')
    expect(db.getRun(runId)?.coordinator_handle).toBe(H)
    confirmWith(true)
    expect(await local(ABANDON, { run: runId })).toMatchObject({ ok: true })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('failed')
  })

  it('does not treat the token of a different Run as ownership', async () => {
    const otherToken = token()
    await local(
      'orchestration.runCreate',
      { objective: 'Other', from: 'headless:other' },
      { orchestrationCoordinatorToken: otherToken }
    )
    const confirmer = confirmWith(false)

    const refused = await local(
      ABANDON,
      { run: runId, from: 'headless:other' },
      { orchestrationCoordinatorToken: otherToken }
    )

    expect(refused).toMatchObject({ ok: false, error: { code: 'confirmation_declined' } })
    expect(confirmer).toHaveBeenCalledOnce()
  })

  it('refuses an abandon with no owner and no desktop confirmation', async () => {
    const refused = await local(ABANDON, { run: runId })

    expect(refused).toMatchObject({ ok: false, error: { code: 'confirmation_unavailable' } })
    expect(db.getRun(runId)?.coordinator_handle).toBe(H)
  })

  it('keeps an abandoned Run mailbox guarded and frees the headless name', async () => {
    const mail = db.insertMessage({ runId, from: 'term_worker', to: `run:${runId}`, subject: 'd' })
    const generation = db.getRun(runId)!.consumer_generation
    db.getOrCreateRunDelivery({ runId, consumerGeneration: generation })
    await local(ABANDON, { run: runId, from: H }, owner())

    expect(db.hasOutstandingRunDelivery(runId)).toBe(false)
    const inbox = await local('orchestration.inbox', {})
    const taken = await local('orchestration.runUse', { id: runId, from: 'term_x' })
    const fresh = await local(
      'orchestration.runCreate',
      { objective: 'Next', from: H },
      { orchestrationCoordinatorToken: token() }
    )

    expect(JSON.stringify(inbox.result)).not.toContain(mail.id)
    expect(taken).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(fresh).toMatchObject({ ok: true })
  })
})
