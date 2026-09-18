import { describe, expect, it } from 'vitest'
import {
  resolveTaskbarPreviewSubject,
  type TaskbarPreviewSessionView
} from './taskbar-preview-subject'

/**
 * The taskbar asks a window for a picture, so the window is where the subject has to start.
 *
 * The case worth the whole file is the second one: session state holds a single profile-global
 * active tab, and a resolver that reached for it would be right whenever one window is open and
 * wrong whenever two are — which is the failure mode that ships, because it passes every
 * single-window test.
 */

const SESSION: TaskbarPreviewSessionView = {
  activeTabIdByWorktree: { 'worktree-a': 'tab-a', 'worktree-b': 'tab-b' },
  terminalLayoutsByTabId: {
    'tab-a': {
      activeLeafId: 'leaf-a1',
      ptyIdsByLeafId: { 'leaf-a1': 'pty-a1', 'leaf-a2': 'pty-a2' }
    },
    'tab-b': { activeLeafId: 'leaf-b1', ptyIdsByLeafId: { 'leaf-b1': 'pty-b1' } }
  }
}

const LIVE = new Set(['pty-a1', 'pty-a2', 'pty-b1'])

const bindingTo = (worktreeId: string) => ({ repoId: 'repo-1', worktreeId })

describe('resolveTaskbarPreviewSubject', () => {
  it('resolves a window to the pty behind its own active pane', () => {
    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-a'),
        session: SESSION,
        livePtyIds: LIVE
      })
    ).toEqual({
      status: 'available',
      ptyId: 'pty-a1',
      worktreeId: 'worktree-a',
      tabId: 'tab-a',
      leafId: 'leaf-a1'
    })
  })

  it('keeps two open windows on their own subjects when the global active tab names one of them', () => {
    // Both windows are open. `activeTabId` is a single scalar for the whole profile, so it holds
    // whichever window published last — here, window B. Window A must still answer about window A.
    const sessionWithGlobalPointingElsewhere = {
      ...SESSION,
      activeTabId: 'tab-b'
    } as TaskbarPreviewSessionView

    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-a'),
        session: sessionWithGlobalPointingElsewhere,
        livePtyIds: LIVE
      })
    ).toMatchObject({ status: 'available', ptyId: 'pty-a1' })

    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-b'),
        session: sessionWithGlobalPointingElsewhere,
        livePtyIds: LIVE
      })
    ).toMatchObject({ status: 'available', ptyId: 'pty-b1' })
  })

  it('refuses rather than borrowing the global when this worktree has no recorded tab', () => {
    // The tempting fallback. It would make a launcher window show another window's terminal.
    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-c'),
        session: { ...SESSION, activeTabId: 'tab-a' } as TaskbarPreviewSessionView,
        livePtyIds: LIVE
      })
    ).toEqual({ status: 'unavailable', reason: 'no-tab' })
  })

  it('reports a window owning no project as having no workspace, not as having no terminal', () => {
    expect(
      resolveTaskbarPreviewSubject({ binding: null, session: SESSION, livePtyIds: LIVE })
    ).toEqual({ status: 'unavailable', reason: 'no-workspace' })
  })

  it('reports a tab with no active pane distinctly from a pane with no pty', () => {
    const session: TaskbarPreviewSessionView = {
      activeTabIdByWorktree: { 'worktree-a': 'tab-empty' },
      terminalLayoutsByTabId: { 'tab-empty': { activeLeafId: null, ptyIdsByLeafId: {} } }
    }
    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-a'),
        session,
        livePtyIds: LIVE
      })
    ).toEqual({ status: 'unavailable', reason: 'no-pane' })
  })

  it('reports a pane that has not spawned as not-started rather than closed', () => {
    const session: TaskbarPreviewSessionView = {
      activeTabIdByWorktree: { 'worktree-a': 'tab-a' },
      terminalLayoutsByTabId: { 'tab-a': { activeLeafId: 'leaf-new', ptyIdsByLeafId: {} } }
    }
    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-a'),
        session,
        livePtyIds: LIVE
      })
    ).toEqual({ status: 'unavailable', reason: 'no-pty' })
  })

  it('reports a pty missing from the live index as closed, not as not-started', () => {
    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-a'),
        session: SESSION,
        livePtyIds: new Set(['pty-b1'])
      })
    ).toEqual({ status: 'unavailable', reason: 'not-live' })
  })

  it('does not fall back to a sibling pane of the same tab', () => {
    // leaf-a2 has a perfectly good live pty. Showing it would be a confident wrong answer.
    const session: TaskbarPreviewSessionView = {
      activeTabIdByWorktree: { 'worktree-a': 'tab-a' },
      terminalLayoutsByTabId: {
        'tab-a': { activeLeafId: 'leaf-a1', ptyIdsByLeafId: { 'leaf-a2': 'pty-a2' } }
      }
    }
    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-a'),
        session,
        livePtyIds: LIVE
      })
    ).toEqual({ status: 'unavailable', reason: 'no-pty' })
  })

  it('treats an unreadable session as having nothing to show rather than throwing', () => {
    expect(
      resolveTaskbarPreviewSubject({
        binding: bindingTo('worktree-a'),
        session: {},
        livePtyIds: new Set()
      })
    ).toEqual({ status: 'unavailable', reason: 'no-tab' })
  })
})
