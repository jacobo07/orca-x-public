import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_DISCARD_OBSERVED_STATE_REQUIRED_CODE,
  GIT_DISCARD_STALE_STATE_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

/**
 * A discard that cannot say what it is destroying must not reach a host.
 *
 * The precondition the desktop now sends closes the race for every row that carries an identity, and
 * says nothing at all about the rows that do not. Those exist: a status listing past its entry cap is
 * stamped with nothing, and a file the host could not read is left unstamped deliberately, because a
 * guess would be worse than an absence. The huge-repository state is a banner rather than a replacement
 * for the list, so those rows still render with a working discard button.
 *
 * Left alone, that is a silent bypass of the whole protection -- the ordinary path is fenced and the
 * degraded path is not, which is the shape of every gate that gets added next to a hole instead of in
 * front of one. So the refusal lives at the transport rather than in the hook that happens to call it
 * today: the next caller inherits it without having to remember.
 *
 * The refusal reuses the code mobile already uses for the same situation, because one vocabulary across
 * clients is worth more than a locally convenient name.
 */

const rpcMocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn(),
  assertRuntimeEnvironmentCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => rpcMocks)
vi.mock('./runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => ({ id })
}))

const localDiscard = vi.fn()

function useLocalTarget(): void {
  rpcMocks.getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
}

function useRemoteRuntimeTarget(): void {
  rpcMocks.getActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
}

const context = {
  settings: null,
  worktreeId: 'repo-1:wt-1',
  worktreePath: '/repo',
  connectionId: undefined
}

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = { api: { git: { discard: localDiscard } } }
  rpcMocks.assertRuntimeEnvironmentCapability.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

async function discard(precondition?: { expectedContent?: string | null }): Promise<void> {
  const { discardRuntimeGitPath } = await import('./runtime-git-client')
  await discardRuntimeGitPath(context as never, 'note.txt', precondition)
}

describe('a discard that cannot describe what it destroys', () => {
  it('is refused before any host is asked', async () => {
    useLocalTarget()

    await expect(discard(undefined)).rejects.toMatchObject({
      code: GIT_DISCARD_OBSERVED_STATE_REQUIRED_CODE
    })
    expect(localDiscard).not.toHaveBeenCalled()
  })

  it('is refused when the stated content is empty rather than missing', async () => {
    // An empty string is not a content identity. Treating it as one would let the guard be defeated by
    // a falsy value travelling through a hop that turns undefined into ''.
    useLocalTarget()

    await expect(discard({ expectedContent: '' })).rejects.toMatchObject({
      code: GIT_DISCARD_OBSERVED_STATE_REQUIRED_CODE
    })
    expect(localDiscard).not.toHaveBeenCalled()
  })

  it('is refused on the remote transport too, without a round trip', async () => {
    // The bypass must not be reachable by switching hosts. And nothing should be dispatched, because a
    // request that arrives is a request that can be executed.
    useRemoteRuntimeTarget()

    await expect(discard(null as never)).rejects.toMatchObject({
      code: GIT_DISCARD_OBSERVED_STATE_REQUIRED_CODE
    })
    expect(rpcMocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})

describe('a discard that can describe what it destroys', () => {
  it('reaches the local host carrying the observed content', async () => {
    useLocalTarget()

    await discard({ expectedContent: 'sha256:abc' })

    expect(localDiscard).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'note.txt', expectedContent: 'sha256:abc' })
    )
  })

  it('asks whether a remote runtime enforces the check before sending anything', async () => {
    // Order is the whole point. An older runtime parses the field and ignores it, so a request that
    // went out first and asked afterwards would learn the file was destroyed. No response can undo it.
    useRemoteRuntimeTarget()
    const order: string[] = []
    rpcMocks.assertRuntimeEnvironmentCapability.mockImplementation(async () => {
      order.push('asked')
    })
    rpcMocks.callRuntimeRpc.mockImplementation(async () => {
      order.push('sent')
    })

    await discard({ expectedContent: 'sha256:abc' })

    expect(order).toEqual(['asked', 'sent'])
    expect(rpcMocks.assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      GIT_DISCARD_STALE_STATE_RUNTIME_CAPABILITY,
      expect.any(String)
    )
  })

  it('does not send the discard when the runtime cannot enforce the check', async () => {
    // Fail-closed: the operation is lost, not silently downgraded to the unprotected one.
    useRemoteRuntimeTarget()
    rpcMocks.assertRuntimeEnvironmentCapability.mockRejectedValue(new Error('host too old'))

    await expect(discard({ expectedContent: 'sha256:abc' })).rejects.toThrow('host too old')
    expect(rpcMocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
