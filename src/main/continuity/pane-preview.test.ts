import { describe, expect, it, vi } from 'vitest'
import { renderPanePreview, type PanePreviewDeps } from './pane-preview'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ColdRestoreDetection } from '../daemon/history-reader'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const REF = 'v1-0123456789abcdef0123456789abcdef'

function session(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {
      wt1: [
        {
          id: 'single',
          ptyId: 'pty-1',
          worktreeId: 'wt1',
          title: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        },
        {
          id: 'split',
          ptyId: null,
          worktreeId: 'wt1',
          title: 'split',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      split: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_A },
          second: { type: 'leaf', leafId: LEAF_B }
        },
        activeLeafId: LEAF_A,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [LEAF_A]: REF },
        ptyIdsByLeafId: { [LEAF_B]: '..' }
      }
    }
  }
}

function restored(ansi: string): ColdRestoreDetection {
  return {
    status: 'restored',
    sessionId: 'pty-1',
    hasUnreadableRecovery: false,
    restoreInfo: {
      snapshotAnsi: ansi,
      scrollbackAnsi: '',
      rehydrateSequences: '',
      cwd: '/',
      cols: 80,
      rows: 10,
      modes: {} as never
    }
  }
}

function deps(overrides: Partial<PanePreviewDeps> = {}): PanePreviewDeps {
  return {
    getWorkspaceSession: () => session(),
    readScrollbackRef: () => null,
    detectHistory: async () => ({ status: 'none' }),
    createEmulator: (size) => new HeadlessEmulator({ ...size, scrollback: 100 }),
    ...overrides
  }
}

describe('renderPanePreview', () => {
  it('refuses a request that does not name a pane', async () => {
    for (const bad of [
      null,
      { hostId: 'nowhere', tabId: 'single', leafId: null },
      { hostId: 'local', tabId: '', leafId: null },
      { hostId: 'local', tabId: 'single', leafId: '../etc' }
    ]) {
      expect(await renderPanePreview(bad, deps())).toEqual({ status: 'invalid-request' })
    }
  })

  it('says not-found for a tab or leaf the saved desk does not have', async () => {
    expect(
      await renderPanePreview({ hostId: 'local', tabId: 'gone', leafId: null }, deps())
    ).toEqual({
      status: 'not-found'
    })
    const foreignLeaf = '33333333-3333-4333-8333-333333333333'
    expect(
      await renderPanePreview({ hostId: 'local', tabId: 'split', leafId: foreignLeaf }, deps())
    ).toEqual({ status: 'not-found' })
  })

  it('renders the daemon history screen through a real headless emulator', async () => {
    const result = await renderPanePreview(
      { hostId: 'local', tabId: 'single', leafId: null },
      deps({ detectHistory: async () => restored('build ok\r\nnext line') })
    )
    expect(result).toMatchObject({
      status: 'rendered',
      source: 'daemon-history',
      cols: 80,
      rows: 10
    })
    expect(result.status === 'rendered' && result.lines).toEqual(['build ok', 'next line'])
  })

  it('renders a session scrollback ref, and says unreadable when the ref cannot be read', async () => {
    const readScrollbackRef = vi.fn((ref: string) => (ref === REF ? 'hello from ref' : null))
    const result = await renderPanePreview(
      { hostId: 'local', tabId: 'split', leafId: LEAF_A },
      deps({ readScrollbackRef })
    )
    expect(result.status === 'rendered' && result.lines).toEqual(['hello from ref'])
    expect(
      await renderPanePreview({ hostId: 'local', tabId: 'split', leafId: LEAF_A }, deps())
    ).toEqual({ status: 'unreadable', source: 'session-ref' })
  })

  it('keeps "nothing recorded" apart from "recorded but unreadable"', async () => {
    const request = { hostId: 'local', tabId: 'single', leafId: null }
    expect(await renderPanePreview(request, deps())).toEqual({ status: 'none' })
    expect(
      await renderPanePreview(
        request,
        deps({ detectHistory: async () => ({ status: 'unreadable', sessionId: 'pty-1' }) })
      )
    ).toEqual({ status: 'unreadable', source: 'daemon-history' })
  })

  it('never reads local history for a remote host, nor a session id that is a path segment', async () => {
    const detectHistory = vi.fn(async () => restored('secret'))
    expect(
      await renderPanePreview(
        { hostId: 'ssh:box', tabId: 'single', leafId: null },
        deps({ detectHistory })
      )
    ).toEqual({ status: 'none' })
    expect(
      await renderPanePreview(
        { hostId: 'local', tabId: 'split', leafId: LEAF_B },
        deps({ detectHistory })
      )
    ).toEqual({ status: 'unreadable', source: 'daemon-history' })
    expect(detectHistory).not.toHaveBeenCalled()
  })

  it('disposes the emulator even when a write fails', async () => {
    const dispose = vi.fn()
    await expect(
      renderPanePreview(
        { hostId: 'local', tabId: 'single', leafId: null },
        deps({
          detectHistory: async () => restored('x'),
          createEmulator: () => ({
            write: async () => {
              throw new Error('parser')
            },
            getVisibleLines: () => [],
            dispose
          })
        })
      )
    ).rejects.toThrow('parser')
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
