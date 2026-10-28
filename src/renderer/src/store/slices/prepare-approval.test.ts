import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedTrustedOrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { approvePrepareStepInStore, readPrepareApprovals } from './prepare-approval'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

type Slice = { trustedOrcaHooks: PersistedTrustedOrcaHooks }

function makeStore(initial: PersistedTrustedOrcaHooks): {
  get: () => Slice
  set: (partial: Partial<Slice>) => void
  state: Slice
} {
  const state: Slice = { trustedOrcaHooks: initial }
  return {
    state,
    get: () => state,
    set: (partial) => Object.assign(state, partial)
  }
}

let uiSet: ReturnType<typeof vi.fn>

beforeEach(() => {
  uiSet = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { ui: { set: uiSet } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('approvePrepareStepInStore', () => {
  it('resolves after the write', async () => {
    let release!: () => void
    uiSet.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)))
    const store = makeStore({})
    let resolved = false
    const pending = approvePrepareStepInStore(store.get, store.set, 'r1', 'node', HASH_A).then(
      () => {
        resolved = true
      }
    )
    await Promise.resolve()
    expect(uiSet).toHaveBeenCalledTimes(1)
    expect(resolved).toBe(false)
    expect(store.state.trustedOrcaHooks).toEqual({})
    release()
    await pending
    expect(resolved).toBe(true)
    expect(store.state.trustedOrcaHooks.r1.prepare?.node.contentHash).toBe(HASH_A)
  })

  it('writes only the prepare map and keeps every other kind', async () => {
    const store = makeStore({
      r1: {
        all: { approvedAt: 1 },
        setup: { contentHash: HASH_B, approvedAt: 2 },
        archive: { contentHash: HASH_B, approvedAt: 3 },
        issueCommand: { contentHash: HASH_B, approvedAt: 4 },
        vmRecipe: { contentHash: HASH_B, approvedAt: 5 },
        prepare: { other: { contentHash: HASH_B, approvedAt: 6 } }
      }
    })
    await approvePrepareStepInStore(store.get, store.set, 'r1', 'node', HASH_A)
    const repo = store.state.trustedOrcaHooks.r1
    expect(repo.all).toEqual({ approvedAt: 1 })
    expect(repo.setup).toEqual({ contentHash: HASH_B, approvedAt: 2 })
    expect(repo.archive).toEqual({ contentHash: HASH_B, approvedAt: 3 })
    expect(repo.issueCommand).toEqual({ contentHash: HASH_B, approvedAt: 4 })
    expect(repo.vmRecipe).toEqual({ contentHash: HASH_B, approvedAt: 5 })
    expect(repo.prepare?.other.contentHash).toBe(HASH_B)
    expect(repo.prepare?.node.contentHash).toBe(HASH_A)
    expect(Number.isFinite(repo.prepare?.node.approvedAt)).toBe(true)
  })

  it('rejects with the store unchanged when the write rejects', async () => {
    uiSet.mockRejectedValueOnce(new Error('disk'))
    const store = makeStore({ r1: { setup: { contentHash: HASH_B, approvedAt: 2 } } })
    const before = store.state.trustedOrcaHooks
    await expect(
      approvePrepareStepInStore(store.get, store.set, 'r1', 'node', HASH_A)
    ).rejects.toThrow('disk')
    expect(store.state.trustedOrcaHooks).toBe(before)
  })

  it('keeps a concurrent trust write and still records the approval in main', async () => {
    let release!: () => void
    uiSet.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)))
    const store = makeStore({})
    const pending = approvePrepareStepInStore(store.get, store.set, 'r1', 'node', HASH_A)
    await Promise.resolve()
    store.state.trustedOrcaHooks = { r1: { setup: { contentHash: HASH_B, approvedAt: 9 } } }
    release()
    await pending
    const repo = store.state.trustedOrcaHooks.r1
    expect(repo.setup?.contentHash).toBe(HASH_B)
    expect(repo.prepare?.node.contentHash).toBe(HASH_A)
    const lastWrite = uiSet.mock.calls.at(-1)?.[0] as {
      trustedOrcaHooks: PersistedTrustedOrcaHooks
    }
    expect(lastWrite.trustedOrcaHooks.r1.prepare?.node.contentHash).toBe(HASH_A)
    expect(lastWrite.trustedOrcaHooks.r1.setup?.contentHash).toBe(HASH_B)
  })
})

describe('readPrepareApprovals', () => {
  it('returns only well-formed entries and ignores repo-wide trust', () => {
    const hooks = {
      r1: {
        all: { approvedAt: 1 },
        prepare: {
          good: { contentHash: HASH_A, approvedAt: 5 },
          shortHash: { contentHash: 'abc', approvedAt: 5 },
          upper: { contentHash: 'A'.repeat(64), approvedAt: 5 },
          noTime: { contentHash: HASH_A },
          nanTime: { contentHash: HASH_A, approvedAt: Number.NaN }
        }
      }
    } as unknown as PersistedTrustedOrcaHooks
    expect(readPrepareApprovals(hooks, 'r1')).toEqual({ good: HASH_A })
  })

  it('reads nothing for an unknown repo, a missing map or inherited keys', () => {
    expect(readPrepareApprovals({}, 'r1')).toEqual({})
    expect(readPrepareApprovals({ r1: { all: { approvedAt: 1 } } }, 'r1')).toEqual({})
    expect(readPrepareApprovals({}, 'constructor')).toEqual({})
  })
})
