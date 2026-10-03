// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { DeskSavedReading } from '../../../../shared/desk-continuity-read-types'
import type { ResumeCenterModel, WorkspaceRowModel } from './resume-center-model'
import { ResumeCenterSummaryPanel } from './ResumeCenterSummaryPanel'

function row(name: string): WorkspaceRowModel {
  return {
    kind: 'projected',
    key: `r::/w/${name}`,
    hostId: 'local',
    identity: { kind: 'known', name, path: `/w/${name}` },
    window: { kind: 'unattributed', reason: 'no-window-binding' },
    lastVisitedAt: null,
    tabs: [],
    orphanSessions: [],
    openFileCount: 0,
    browserTabCount: 0,
    windowOrder: null,
    counts: { tabs: 0, panes: 0, warm: 0, dormant: 0, unknown: 0 }
  }
}

const desk = [row('alpha'), row('beta')]

// A search narrowed the visible rows to alpha; the snapshot still describes the whole desk.
const searched: ResumeCenterModel = {
  workspaces: [desk[0]!],
  unprojectable: [],
  unreadableHosts: [],
  totals: {
    workspaces: 2,
    tabs: 0,
    panes: 0,
    byResidency: { warm: 0, dormant: 0, 'no-process': 0, unknown: 0 }
  } as ResumeCenterModel['totals'],
  windowsRecorded: false,
  windowCount: 0
}

function savedLine(deskSaved: DeskSavedReading): HTMLElement {
  render(<ResumeCenterSummaryPanel model={searched} deskRows={desk} deskSaved={deskSaved} />)
  return screen.getByTestId('resume-center-desk-saved')
}

afterEach(cleanup)

describe('ResumeCenterSummaryPanel current snapshot', () => {
  it('names the save as a write time with its exact moment, never as a close', () => {
    const line = savedLine({ kind: 'observed', at: Date.now() - 5 * 60_000 })
    expect(line.textContent).toMatch(/^Desk saved .*5 min/)
    expect(line.textContent).not.toMatch(/clos/i)
    expect(line.getAttribute('title')).toBeTruthy()
    expect(line.dataset.deskSaved).toBe('observed')
  })

  it('keeps never-saved apart from could-not-tell', () => {
    expect(savedLine({ kind: 'never' }).textContent).toBe('Desk not saved yet')
    cleanup()
    const unknown = savedLine({ kind: 'unknown' })
    expect(unknown.textContent).toBe('Save time unknown')
    expect(unknown.getAttribute('title')).toBeNull()
  })

  it('lists every workspace on the desk, not only the ones a search left visible', () => {
    savedLine({ kind: 'unknown' })
    expect(screen.getByTestId('resume-center-snapshot-names').textContent).toBe('alpha, beta')
    expect(screen.getByRole('complementary', { name: 'Current snapshot' })).toBeTruthy()
  })
})

describe('ResumeCenterSummaryPanel tip', () => {
  afterEach(() => {
    delete (window as { api?: unknown }).api
  })

  it('dismissal is the persisted one, not a local flag', () => {
    const setMock = vi.fn(() => Promise.resolve())
    Object.assign(window, { api: { ui: { set: setMock } } })
    useAppStore.setState({ persistedUIReady: true, resumeCenterTipDismissed: false })
    savedLine({ kind: 'unknown' })

    fireEvent.click(screen.getByTestId('resume-center-tip-dismiss'))

    expect(screen.queryByTestId('resume-center-tip')).toBeNull()
    expect(setMock).toHaveBeenCalledWith({ resumeCenterTipDismissed: true })
  })

  it('stays away when hydrated as dismissed, and before hydration', () => {
    useAppStore.setState({ persistedUIReady: true, resumeCenterTipDismissed: true })
    savedLine({ kind: 'unknown' })
    expect(screen.queryByTestId('resume-center-tip')).toBeNull()
    cleanup()

    useAppStore.setState({ persistedUIReady: false, resumeCenterTipDismissed: false })
    savedLine({ kind: 'unknown' })
    expect(screen.queryByTestId('resume-center-tip')).toBeNull()
    cleanup()

    // Positive control: the same render shows it once hydrated and not dismissed.
    useAppStore.setState({ persistedUIReady: true, resumeCenterTipDismissed: false })
    savedLine({ kind: 'unknown' })
    expect(screen.getByTestId('resume-center-tip')).toBeTruthy()
  })
})
