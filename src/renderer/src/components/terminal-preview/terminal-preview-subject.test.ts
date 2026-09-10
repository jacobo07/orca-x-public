import { describe, expect, it } from 'vitest'
import { resolveTerminalPreviewSubject } from './terminal-preview-subject'

/**
 * A preview must know exactly which terminal it is about before it paints anything.
 *
 * Rail rows are keyed by tab and leaf; the PTY is one lookup further down. Every way that lookup can
 * fail has to stay a distinct reason, because "this pane has not started yet" and "this terminal has
 * closed" want opposite sentences from the user's point of view — and a preview that collapses both
 * into an empty frame is the false-live failure this capability exists to avoid.
 */

const LAYOUTS = {
  'tab-1': { ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-b' } },
  'tab-2': { ptyIdsByLeafId: {} }
}

describe('resolveTerminalPreviewSubject', () => {
  it('resolves a live leaf to its pty', () => {
    expect(
      resolveTerminalPreviewSubject({
        tabId: 'tab-1',
        leafId: 'leaf-a',
        layoutsByTabId: LAYOUTS,
        ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'] }
      })
    ).toEqual({ status: 'available', ptyId: 'pty-a', tabId: 'tab-1', leafId: 'leaf-a' })
  })

  it('reports a leaf with no pty as not-started rather than closed', () => {
    expect(
      resolveTerminalPreviewSubject({
        tabId: 'tab-2',
        leafId: 'leaf-z',
        layoutsByTabId: LAYOUTS,
        ptyIdsByTabId: { 'tab-2': [] }
      })
    ).toEqual({ status: 'unavailable', reason: 'no-pty' })
  })

  it('reports a pty missing from the live index as closed, not as not-started', () => {
    // The leaf still remembers its pty; the runtime no longer lists it. Telling the user to wait
    // would be a lie, and refreshing would never help.
    expect(
      resolveTerminalPreviewSubject({
        tabId: 'tab-1',
        leafId: 'leaf-b',
        layoutsByTabId: LAYOUTS,
        ptyIdsByTabId: { 'tab-1': ['pty-a'] }
      })
    ).toEqual({ status: 'unavailable', reason: 'not-live' })
  })

  it('does not fall back to another pane of the same tab', () => {
    // Retargeting by convenience is how a preview ends up confidently showing the wrong terminal.
    expect(
      resolveTerminalPreviewSubject({
        tabId: 'tab-1',
        leafId: 'leaf-missing',
        layoutsByTabId: LAYOUTS,
        ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-b'] }
      })
    ).toEqual({ status: 'unavailable', reason: 'no-pty' })
  })

  it('treats an unknown tab as not-started rather than throwing', () => {
    expect(
      resolveTerminalPreviewSubject({
        tabId: 'tab-gone',
        leafId: 'leaf-a',
        layoutsByTabId: LAYOUTS,
        ptyIdsByTabId: {}
      })
    ).toEqual({ status: 'unavailable', reason: 'no-pty' })
  })

  it('treats a tab absent from the live index as closed once its leaf knows a pty', () => {
    expect(
      resolveTerminalPreviewSubject({
        tabId: 'tab-1',
        leafId: 'leaf-a',
        layoutsByTabId: LAYOUTS,
        ptyIdsByTabId: {}
      })
    ).toEqual({ status: 'unavailable', reason: 'not-live' })
  })
})
