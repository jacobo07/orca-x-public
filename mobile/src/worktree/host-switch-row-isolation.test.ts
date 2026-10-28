import { describe, expect, it, vi } from 'vitest'
import { getCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import { WorktreeCatalogSnapshotClient } from './worktree-catalog-snapshot-client'
import type { Worktree } from './workspace-list-sections'

type Deferred = { resolve: (rows: Worktree[]) => void }

/** A host whose worktree.ps answers only when the test releases it, so a response can arrive late. */
function deferredHost(): { client: RpcClient; release: Deferred['resolve']; methods: string[] } {
  const methods: string[] = []
  let release: Deferred['resolve'] = () => {}
  const client = {
    sendRequest: vi.fn(async (method: string) => {
      methods.push(method)
      const rows = await new Promise<Worktree[]>((resolve) => {
        release = resolve
      })
      return { id: 'r', ok: true, result: { worktrees: rows, snapshotId: `snap-${rows.length}` } }
    })
  } as unknown as RpcClient
  return { client, release: (rows) => release(rows), methods }
}

const row = (worktreeId: string) => ({ worktreeId }) as unknown as Worktree

// Mirrors fetchWorktrees on mobile/app/h/[hostId]/index.tsx: fetch, admit, then cache under the request's host.
async function homeFetch(
  catalog: WorktreeCatalogSnapshotClient,
  client: RpcClient,
  hostId: string
): Promise<Worktree[] | null> {
  const fetched = await catalog.fetch(client, hostId)
  const confirmed = catalog.admit(fetched.kind === 'response' ? fetched.pending : null)
  if (confirmed) {
    setCachedWorktrees(hostId, confirmed, { proven: true })
  }
  return confirmed
}

describe('switching host A to B on one reused home screen', () => {
  it('shows only B rows, drops A late response, and sends nothing but reads to A', async () => {
    const catalog = new WorktreeCatalogSnapshotClient()
    const hostA = deferredHost()
    const hostB = deferredHost()

    const inFlightA = homeFetch(catalog, hostA.client, 'host-a-iso')
    const visibleB = homeFetch(catalog, hostB.client, 'host-b-iso')
    hostB.release([row('b-1'), row('b-2')])
    // Host A answers only after the screen already switched to B.
    hostA.release([row('a-1')])

    expect(await visibleB).toEqual([row('b-1'), row('b-2')])
    expect(await inFlightA).toBeNull()
    expect(getCachedWorktrees('host-b-iso')).toEqual([row('b-1'), row('b-2')])
    expect(JSON.stringify(getCachedWorktrees('host-b-iso'))).not.toContain('a-1')
    // A late A answer never writes A rows under any key the B screen reads.
    expect(getCachedWorktrees('host-a-iso')).toBeNull()
    // Switching mutates nothing on A: its only traffic was the one read issued before the switch.
    expect(hostA.methods).toEqual(['worktree.ps'])
  })

  it('control: the same A response is admitted when no switch happened', async () => {
    const catalog = new WorktreeCatalogSnapshotClient()
    const hostA = deferredHost()

    const fetching = homeFetch(catalog, hostA.client, 'host-a-ctl')
    hostA.release([row('a-1')])

    expect(await fetching).toEqual([row('a-1')])
    expect(getCachedWorktrees('host-a-ctl')).toEqual([row('a-1')])
  })
})
