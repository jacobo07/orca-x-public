// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  syncTerminalVoiceDockSpace,
  type TerminalVoiceDockPane
} from './terminal-voice-dock-pane-state'

function makePane(id: number): TerminalVoiceDockPane {
  return { id, container: document.createElement('div') }
}

const hasDock = (pane: TerminalVoiceDockPane): boolean =>
  pane.container.hasAttribute('data-has-voice-dock')

describe('terminal voice dock pane state', () => {
  it('reserves space on every pane and asks for a fit when the dock appears', () => {
    const panes = [makePane(1), makePane(2)]

    const needsFit = syncTerminalVoiceDockSpace({ panes, isVoiceDockEnabled: true })

    expect(needsFit).toBe(true)
    expect(panes.every(hasDock)).toBe(true)
  })

  it('releases the space and asks for a fit when the dock goes away', () => {
    const panes = [makePane(1), makePane(2)]
    syncTerminalVoiceDockSpace({ panes, isVoiceDockEnabled: true })

    const needsFit = syncTerminalVoiceDockSpace({ panes, isVoiceDockEnabled: false })

    expect(needsFit).toBe(true)
    expect(panes.some(hasDock)).toBe(false)
  })

  it('does not ask for a fit when nothing changed', () => {
    const panes = [makePane(1), makePane(2)]
    syncTerminalVoiceDockSpace({ panes, isVoiceDockEnabled: true })

    // A redundant fit resizes the PTY and wakes every TUI with SIGWINCH.
    expect(syncTerminalVoiceDockSpace({ panes, isVoiceDockEnabled: true })).toBe(false)
  })

  it('reserves on a pane that is not the active one', () => {
    // Reserved geometry must not track focus: if it did, every focus change
    // would resize a PTY. The signature has no active-pane input at all, so
    // this is structural rather than a rule someone has to remember.
    const panes = [makePane(1), makePane(2), makePane(3)]

    syncTerminalVoiceDockSpace({ panes, isVoiceDockEnabled: true })

    expect(panes.map(hasDock)).toEqual([true, true, true])
  })

  it('reports a fit when a pane joins a split after the dock is already up', () => {
    const existing = makePane(1)
    syncTerminalVoiceDockSpace({ panes: [existing], isVoiceDockEnabled: true })
    const added = makePane(2)

    const needsFit = syncTerminalVoiceDockSpace({
      panes: [existing, added],
      isVoiceDockEnabled: true
    })

    expect(needsFit).toBe(true)
    expect(hasDock(added)).toBe(true)
  })
})
