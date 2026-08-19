/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest'
import {
  FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
  persistFloatingTerminalPanelInstanceListVisible,
  persistFloatingTerminalPanelMaximized,
  persistFloatingTerminalPanelOpen,
  readPersistedFloatingTerminalPanelViewState
} from './floating-terminal-panel-view-state'
import { shouldRestoreMaximizedPanelBounds } from './floating-terminal-panel-restore-geometry'

afterEach(() => {
  window.localStorage.clear()
})

describe('floating terminal panel view state', () => {
  it('returns null when nothing was ever persisted', () => {
    expect(readPersistedFloatingTerminalPanelViewState()).toBeNull()
  })

  it('round-trips every flag', () => {
    persistFloatingTerminalPanelOpen(true)
    persistFloatingTerminalPanelMaximized(true)
    persistFloatingTerminalPanelInstanceListVisible(false)
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({
      open: true,
      maximized: true,
      instanceListVisible: false
    })
  })

  it('does not clobber another owner_s flag', () => {
    // Why: `open` is written by the app shell and `maximized` by the panel, so a
    // whole-record write from either would drop the other's value.
    persistFloatingTerminalPanelMaximized(true)
    persistFloatingTerminalPanelOpen(false)
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({
      open: false,
      maximized: true,
      instanceListVisible: true
    })

    persistFloatingTerminalPanelOpen(true)
    persistFloatingTerminalPanelMaximized(false)
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({
      open: true,
      maximized: false,
      instanceListVisible: true
    })
  })

  it('keeps a hidden terminals column hidden across the other owners_ writes', () => {
    // The flag most at risk: it is written by one control and read by another, so a
    // whole-record write from the shell or the panel would silently re-show the column.
    persistFloatingTerminalPanelInstanceListVisible(false)
    persistFloatingTerminalPanelOpen(true)
    persistFloatingTerminalPanelMaximized(true)
    expect(readPersistedFloatingTerminalPanelViewState()?.instanceListVisible).toBe(false)
  })

  it('lets a later write destroy a restored open preference', () => {
    // Why pinned: this is the hazard the App-side guard exists for. `settings` hydrates
    // asynchronously, so the feature flag reads false on every boot before it resolves and
    // the feature-off effect force-closes the panel. If that path persists, it overwrites a
    // preference the user never changed - which is exactly what shipped and had to be fixed.
    persistFloatingTerminalPanelOpen(true)
    expect(readPersistedFloatingTerminalPanelViewState()?.open).toBe(true)

    persistFloatingTerminalPanelOpen(false)
    expect(readPersistedFloatingTerminalPanelViewState()?.open).toBe(false)
  })

  it('restores the half an older record carries', () => {
    // Why: a record written before the later flags existed must still restore.
    window.localStorage.setItem(
      FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({ open: true })
    )
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({
      open: true,
      maximized: false,
      instanceListVisible: true
    })
  })

  it('reads an absent terminals-column flag as shown, not hidden', () => {
    // The two later flags default in opposite directions on purpose. Absent `maximized` means a
    // panel that was never maximized. Absent `instanceListVisible` means a record written before
    // the column existed — defaulting that to hidden would keep the feature invisible for every
    // existing user, which is indistinguishable from it never having shipped.
    window.localStorage.setItem(
      FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({ open: true, maximized: true })
    )
    expect(readPersistedFloatingTerminalPanelViewState()?.instanceListVisible).toBe(true)
  })

  it('treats malformed storage as absent instead of throwing', () => {
    for (const value of ['not json', '[]', 'null', '"open"', '42']) {
      window.localStorage.setItem(FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY, value)
      expect(readPersistedFloatingTerminalPanelViewState()).toBeNull()
    }
  })

  it('ignores non-boolean flag values rather than coercing them', () => {
    window.localStorage.setItem(
      FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({ open: 'yes', maximized: 1 })
    )
    expect(readPersistedFloatingTerminalPanelViewState()).toEqual({
      open: false,
      maximized: false,
      instanceListVisible: true
    })
  })

  it('only hides the terminals column for an explicit false', () => {
    // Consistent with the absent case: anything that is not the literal `false` leaves the
    // column shown, so a corrupted value degrades to visible rather than to a missing feature.
    for (const value of [0, 'no', null]) {
      window.localStorage.setItem(
        FLOATING_TERMINAL_PANEL_VIEW_STATE_STORAGE_KEY,
        JSON.stringify({ open: true, instanceListVisible: value })
      )
      expect(readPersistedFloatingTerminalPanelViewState()?.instanceListVisible).toBe(true)
    }
  })
})

describe('shouldRestoreMaximizedPanelBounds', () => {
  it('restores maximized geometry only when the viewport can hold it', () => {
    expect(
      shouldRestoreMaximizedPanelBounds(
        { open: true, maximized: true, instanceListVisible: true },
        () => true
      )
    ).toBe(true)
    // Why: maximized bounds come from the live viewport, so restoring against one too small
    // pins terminals to a grid the window is about to leave - the jump this restore removes.
    expect(
      shouldRestoreMaximizedPanelBounds(
        { open: true, maximized: true, instanceListVisible: true },
        () => false
      )
    ).toBe(false)
  })

  it('does not restore maximized geometry for a non-maximized or absent record', () => {
    expect(
      shouldRestoreMaximizedPanelBounds(
        { open: true, maximized: false, instanceListVisible: true },
        () => true
      )
    ).toBe(false)
    expect(shouldRestoreMaximizedPanelBounds(null, () => true)).toBe(false)
  })
})
