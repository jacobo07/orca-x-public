import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { withCurrentOrchestrationContract } from '../runtime-rpc-test-harness'
import { RpcDispatcher } from './dispatcher'

const H = 'headless:sidecar'
const token = (): string => randomBytes(32).toString('hex')

type Reply = { ok: boolean; result?: Record<string, unknown>; error?: { code: string } }

describe('headless coordinator worker start and mail (K4c)', () => {
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

  async function local(
    method: string,
    params: Record<string, unknown>,
    envelope: Record<string, unknown> = {}
  ): Promise<Reply> {
    seq += 1
    const request = withCurrentOrchestrationContract({
      id: `req-${seq}`,
      authToken: 'local',
      method,
      params,
      orchestrationRequestId: `k4c-request-${seq}`,
      ...envelope
    }) as never
    return (await dispatcher.dispatch(request)) as unknown as Reply
  }

  const owner = (): Record<string, unknown> => ({ orchestrationCoordinatorToken: secret })

  async function ownerTask(): Promise<string> {
    const task = await local(
      'orchestration.taskCreate',
      { spec: 'work', callerTerminalHandle: H },
      owner()
    )
    expect(task).toMatchObject({ ok: true })
    return (task.result!.task as { id: string }).id
  }

  function mockExistingWorktreeStart(): void {
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal')
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({ id: 'repo::wt' } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::wt',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
  }

  it.each([
    [{}, 'headless_coordinator_has_no_worktree'],
    [{ worktree: 'current' }, 'headless_coordinator_has_no_worktree'],
    [{ worktree: 'new-child', name: 'child' }, 'headless_coordinator_has_no_worktree'],
    // Why no agent: --terminal with --agent is refused by an older rule; this row must reach K4c's.
    [{ worktree: 'id:repo::wt', terminal: 'term_other', agent: undefined }, 'invalid_argument'],
    [{ worktree: 'new-top-level', name: 'fresh' }, 'invalid_argument']
  ])('refuses a headless worker-start placed by %j before any effect', async (placement, code) => {
    const taskId = await ownerTask()
    const statusBefore = db.getTask(taskId)?.status
    const showTerminal = vi.spyOn(runtime, 'showTerminal')

    const refused = await local(
      'orchestration.workerStart',
      { task: taskId, from: H, agent: 'claude', ...placement },
      owner()
    )

    expect(refused).toMatchObject({ ok: false, error: { code } })
    expect(showTerminal).not.toHaveBeenCalled()
    expect(db.getTask(taskId)?.status).toBe(statusBefore)
  })

  it('starts a headless worker in an exact worktree and names the coordinator as headless', async () => {
    const taskId = await ownerTask()
    mockExistingWorktreeStart()

    const started = await local(
      'orchestration.workerStart',
      { task: taskId, from: H, agent: 'claude', worktree: 'id:repo::wt' },
      owner()
    )

    expect(started).toMatchObject({ ok: true, result: { state: 'ready' } })
    expect(runtime.showTerminal).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_worker',
      expect.stringContaining(`headless coordinator with no terminal: ${H}`)
    )
  })

  it('creates a new top-level worktree from the exact repo with no caller terminal in lineage', async () => {
    const taskId = await ownerTask()
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo-1', path: '/r' } as never)
    const create = vi
      .spyOn(runtime, 'createManagedWorktree')
      .mockRejectedValue(new Error('stop after the creation request'))

    await local(
      'orchestration.workerStart',
      {
        task: taskId,
        from: H,
        agent: 'claude',
        worktree: 'new-top-level',
        repo: 'id:repo-1',
        name: 'fresh'
      },
      owner()
    )

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'id:repo-1',
        lineage: { parentWorktree: undefined, noParent: true, callerTerminalHandle: undefined }
      })
    )
  })

  it('hides a headless Run mailbox from the unscoped inbox and keeps other mail', async () => {
    db.insertMessage({ runId, from: 'dispatch:ctx_1', to: `run:${runId}`, subject: 'secret-done' })
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'plain-mail' })

    const inbox = await local('orchestration.inbox', {})

    expect(JSON.stringify(inbox.result)).not.toContain('secret-done')
    expect(JSON.stringify(inbox.result)).toContain('plain-mail')
  })

  it('refuses a terminal reply to the headless mailbox and leaves the mail unread', async () => {
    const mail = db.insertMessage({
      runId,
      from: 'term_worker',
      to: `run:${runId}`,
      subject: 'done'
    })

    const stolen = await local('orchestration.reply', { id: mail.id, body: 'x', from: 'term_x' })
    const anonymous = await local('orchestration.reply', { id: mail.id, body: 'x' })

    expect(stolen).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(anonymous).toMatchObject({ ok: false, error: { code: 'coordinator_auth_failed' } })
    expect(db.getMessageById(mail.id)?.read).toBeFalsy()
    const replied = await local(
      'orchestration.reply',
      { id: mail.id, body: 'ok', from: H },
      owner()
    )
    expect(replied).toMatchObject({ ok: true })
  })

  it('still lets a worker reply to mail its headless coordinator sent it', async () => {
    const mail = db.insertMessage({ runId, from: H, to: 'term_worker', subject: 'question' })

    const replied = await local('orchestration.reply', {
      id: mail.id,
      body: 'answer',
      from: 'term_worker'
    })

    expect(replied).toMatchObject({ ok: true })
  })
})
