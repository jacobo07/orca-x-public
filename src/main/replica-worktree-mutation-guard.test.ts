import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'

let root: string
let a: string
let b: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-mutation-guard-'))
  a = join(root, 'a')
  b = join(root, 'b')
  mkdirSync(a)
  mkdirSync(b)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

// A pending operation the test releases by hand, with a signal for "fn has started".
function gate(): { started: Promise<void>; release: () => void; fn: () => Promise<string> } {
  let release!: () => void
  let started!: () => void
  const startedPromise = new Promise<void>((r) => (started = r))
  const hold = new Promise<void>((r) => (release = r))
  return {
    started: startedPromise,
    release,
    fn: async () => {
      started()
      await hold
      return 'held'
    }
  }
}

describe('createReplicaWorktreeMutationGuard', () => {
  it('runs fn and reports done with its value; the guard is idle afterwards', async () => {
    const guard = createReplicaWorktreeMutationGuard()
    await expect(guard.run(a, async () => 7)).resolves.toEqual({ kind: 'done', value: 7 })
    expect(guard.activeCount()).toBe(0)
  })

  it('answers busy for a second run on the same path without calling its fn, then serves it after release', async () => {
    const guard = createReplicaWorktreeMutationGuard()
    const first = gate()
    const pending = guard.run(a, first.fn)
    await first.started
    const second = vi.fn(async () => 'second')
    await expect(guard.run(a, second)).resolves.toEqual({ kind: 'busy' })
    expect(second).not.toHaveBeenCalled()
    expect(guard.activeCount()).toBe(1)
    first.release()
    await expect(pending).resolves.toEqual({ kind: 'done', value: 'held' })
    // Control: once released the same path is served.
    await expect(guard.run(a, second)).resolves.toEqual({ kind: 'done', value: 'second' })
    expect(second).toHaveBeenCalledTimes(1)
    expect(guard.activeCount()).toBe(0)
  })

  it('treats a symlink to a worktree as the same worktree', async () => {
    const link = join(root, 'link-to-a')
    symlinkSync(a, link)
    const guard = createReplicaWorktreeMutationGuard()
    const first = gate()
    const pending = guard.run(a, first.fn)
    await first.started
    const viaLink = vi.fn(async () => 'x')
    await expect(guard.run(link, viaLink)).resolves.toEqual({ kind: 'busy' })
    expect(viaLink).not.toHaveBeenCalled()
    first.release()
    await pending
  })

  it('does not make different worktrees contend', async () => {
    const guard = createReplicaWorktreeMutationGuard()
    const first = gate()
    const pending = guard.run(a, first.fn)
    await first.started
    await expect(guard.run(b, async () => 'b')).resolves.toEqual({ kind: 'done', value: 'b' })
    first.release()
    await pending
  })

  it('releases the key when fn throws and rethrows the error; the next run succeeds', async () => {
    const guard = createReplicaWorktreeMutationGuard()
    await expect(
      guard.run(a, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(guard.activeCount()).toBe(0)
    await expect(guard.run(a, async () => 'again')).resolves.toEqual({
      kind: 'done',
      value: 'again'
    })
  })

  it('rejects for a path that does not exist and holds no key', async () => {
    const guard = createReplicaWorktreeMutationGuard()
    await expect(guard.run(join(root, 'missing'), async () => 1)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(guard.activeCount()).toBe(0)
  })

  it('starts no timer', async () => {
    vi.useFakeTimers()
    const guard = createReplicaWorktreeMutationGuard()
    const first = gate()
    const pending = guard.run(a, first.fn)
    await first.started
    expect(vi.getTimerCount()).toBe(0)
    first.release()
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })
})
