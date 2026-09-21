import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// Why: pins the host contract that renderer liveness samplers rely on — every
// inventory refresh supersedes the one before it, so a caller that needs fresh
// liveness for several worktrees on one host must not overlap its requests.

const WORKTREE_A = 'repo-1::/tmp/overlap-a'
const WORKTREE_B = 'repo-1::/tmp/overlap-b'

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      { id: 'repo-1', path: '/tmp/overlap-a', displayName: 'o', badgeColor: '#000', addedAt: 0 }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

type Session = { id: string; cwd: string }

function makeRuntime(listProcesses: () => Promise<Session[]>): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId: 'tab-a', worktreeId: WORKTREE_A, title: '', activeLeafId: 'leaf-a', layout: null },
      { tabId: 'tab-b', worktreeId: WORKTREE_B, title: '', activeLeafId: 'leaf-b', layout: null }
    ],
    leaves: [
      {
        tabId: 'tab-a',
        worktreeId: WORKTREE_A,
        leafId: 'leaf-a',
        paneRuntimeId: 1,
        ptyId: 'pty-a',
        paneTitle: null,
        title: ''
      },
      {
        tabId: 'tab-b',
        worktreeId: WORKTREE_B,
        leafId: 'leaf-b',
        paneRuntimeId: 2,
        ptyId: 'pty-b',
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

const SESSIONS: Session[] = [
  { id: 'pty-a', cwd: '/tmp/overlap-a' },
  { id: 'pty-b', cwd: '/tmp/overlap-b' }
]

function listFresh(runtime: OrcaRuntimeService, worktreeId: string) {
  return runtime.listTerminals(`id:${worktreeId}`, undefined, { requireFreshPtyLiveness: true })
}

describe('fresh terminal liveness under overlapping requests', () => {
  it('answers each worktree when the requests do not overlap', async () => {
    const runtime = makeRuntime(async () => SESSIONS)

    const a = await listFresh(runtime, WORKTREE_A)
    const b = await listFresh(runtime, WORKTREE_B)

    expect(a.terminals.map((t) => t.ptyId)).toEqual(['pty-a'])
    expect(b.terminals.map((t) => t.ptyId)).toEqual(['pty-b'])
  })

  it('fails the earlier request closed when a later one overlaps it', async () => {
    const pending: ((sessions: Session[]) => void)[] = []
    const runtime = makeRuntime(() => new Promise<Session[]>((resolve) => pending.push(resolve)))

    const a = listFresh(runtime, WORKTREE_A)
    const b = listFresh(runtime, WORKTREE_B)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    for (const resolve of pending) {
      resolve(SESSIONS)
    }

    await expect(a).rejects.toThrow('terminal_liveness_unavailable')
    await expect(b).resolves.toMatchObject({ terminals: [{ ptyId: 'pty-b' }] })
  })
})
