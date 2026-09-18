import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc, RuntimeRpcCallError } from './runtime-rpc-client'
import { requestRemoteWorktreeSleep } from './remote-worktree-sleep'
import { resetRuntimeHostQueueForTests, runOnRuntimeHost } from './runtime-host-query-queue'

vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: vi.fn()
}))

const callRuntimeRpcMock = vi.mocked(callRuntimeRpc)

const ENVIRONMENT_ID = 'windows-2'
const WORKTREE_ID = 'repo::C:\\wt-a'

/** What an old runtime answers when it has never heard of host-authoritative sleep. */
function methodNotFound() {
  return new RuntimeRpcCallError({
    ok: false,
    error: { code: 'method_not_found', message: 'terminal.sleep' }
  } as never)
}

describe('legacy remote worktree sleep against a busy host', () => {
  beforeEach(() => {
    resetRuntimeHostQueueForTests()
    callRuntimeRpcMock.mockReset()
  })

  it('waits its turn instead of superseding another consumer of the same host', async () => {
    let listsStarted = 0
    let maxInFlight = 0
    let inFlight = 0
    const released: (() => void)[] = []

    callRuntimeRpcMock.mockImplementation(async (_selector, method) => {
      if (method === 'terminal.sleep') {
        throw methodNotFound()
      }
      if (method === 'terminal.stop') {
        return {} as never
      }
      listsStarted += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => released.push(resolve))
      inFlight -= 1
      // Why: no live terminal left, so convergence is reached on the first answer.
      return { terminals: [], totalCount: 0, truncated: false } as never
    })

    // Why: someone else already holds this host — the liveness sampler, say.
    let releaseOther: () => void = () => undefined
    const other = runOnRuntimeHost(
      ENVIRONMENT_ID,
      Date.now() + 60_000,
      () => new Promise<string>((resolve) => (releaseOther = () => resolve('other')))
    )

    const sleeping = requestRemoteWorktreeSleep({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(listsStarted).toBe(0)

    releaseOther()
    await other
    await vi.waitFor(() => expect(listsStarted).toBe(1))
    expect(maxInFlight).toBe(1)

    released.forEach((release) => release())
    await expect(sleeping).resolves.toBeUndefined()
  })

  it('still issues its own listing rather than reusing an earlier answer', async () => {
    const methods: string[] = []
    callRuntimeRpcMock.mockImplementation(async (_selector, method) => {
      methods.push(method)
      if (method === 'terminal.sleep') {
        throw methodNotFound()
      }
      if (method === 'terminal.stop') {
        return {} as never
      }
      return { terminals: [], totalCount: 0, truncated: false } as never
    })

    // Why: an answer taken before the stop cannot verify the stop, so queueing must not
    // turn into sharing — this caller lists again even though the host was just asked.
    await runOnRuntimeHost(ENVIRONMENT_ID, Date.now() + 60_000, async () => 'someone else asked')
    await requestRemoteWorktreeSleep({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID
    })

    expect(methods).toEqual(['terminal.sleep', 'terminal.stop', 'terminal.list'])
  })
})
