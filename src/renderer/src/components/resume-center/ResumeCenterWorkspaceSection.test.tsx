// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MissionBriefResult } from '../../../../shared/mission-brief-types'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ worktreesByRepo: {} })
}))

import {
  probeMissionRecordsInto,
  resetMissionRecordsPresence
} from '../mission-brief/use-mission-records-presence'
import { readMissionBriefInto, resetMissionBriefStore } from '../mission-brief/use-mission-brief'
import type { WorkspaceRowModel } from './resume-center-model'
import { ResumeCenterWorkspaceSection } from './ResumeCenterWorkspaceSection'

function row(key: string, name: string): WorkspaceRowModel {
  return {
    kind: 'projected',
    key,
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

const A = row('r::/w/alpha', 'alpha')
const B = row('r::/w/beta', 'beta')
const probe = vi.fn()
const read = vi.fn()

function chip(name: string): HTMLElement | null {
  return screen
    .getByRole('region', { name })
    .querySelector('[data-testid="resume-center-workspace-mission-chip"]')
}

beforeEach(() => {
  probe.mockResolvedValue({
    status: 'probed',
    presence: { [A.key]: 'present', [B.key]: 'absent' }
  })
  ;(window as unknown as { api: unknown }).api = { missionBrief: { probe, read } }
})

afterEach(() => {
  cleanup()
  resetMissionRecordsPresence()
  resetMissionBriefStore()
  vi.clearAllMocks()
})

function renderRows(onShowBrief = vi.fn(), onSelect = vi.fn()) {
  render(
    <>
      <ResumeCenterWorkspaceSection
        row={A}
        selected={false}
        onSelect={onSelect}
        onShowBrief={onShowBrief}
      />
      <ResumeCenterWorkspaceSection
        row={B}
        selected={false}
        onSelect={vi.fn()}
        onShowBrief={vi.fn()}
      />
    </>
  )
  return { onShowBrief, onSelect }
}

describe('Mission Brief is discoverable on the row before any brief is read', () => {
  it('marks only the workspace whose records exist, before anything is selected', async () => {
    renderRows()
    await act(() => probeMissionRecordsInto([A, B]))
    expect(read).not.toHaveBeenCalled()
    expect(chip('alpha')?.textContent).toBe('Mission Brief')
    expect(chip('beta')).toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith({ hostId: 'local', workspaceKeys: [A.key, B.key] })
  })

  it('opens that workspace brief from the chip, with a name that says so', async () => {
    const { onShowBrief, onSelect } = renderRows()
    await act(() => probeMissionRecordsInto([A, B]))
    const button = chip('alpha')!
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('aria-label')).toContain('alpha')
    await userEvent.click(button)
    // Select, never toggle: on the already-selected row a toggle would hide the brief.
    expect(onShowBrief).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('lets a read brief replace the mark with its signal, and a read "no mission" remove it', async () => {
    renderRows()
    await act(() => probeMissionRecordsInto([A, B]))
    read.mockResolvedValueOnce({ status: 'no-mission' } satisfies MissionBriefResult)
    await act(() => readMissionBriefInto('local', A.key, false))
    expect(chip('alpha')).toBeNull()
  })

  it('splits a desk larger than one request into several probes', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => row(`r::/w/${i}`, `ws${i}`))
    probe.mockResolvedValue({ status: 'probed', presence: {} })
    await probeMissionRecordsInto(many)
    expect(probe.mock.calls.map(([request]) => request.workspaceKeys.length)).toEqual([500, 500, 1])
  })

  it('draws nothing after a refresh clears the answers, until the new probe lands', async () => {
    renderRows()
    await act(() => probeMissionRecordsInto([A, B]))
    let land: (value: unknown) => void = () => {}
    probe.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
    const pending = probeMissionRecordsInto([A, B])
    await act(async () => {})
    expect(chip('alpha')).toBeNull()
    await act(async () => {
      land({ status: 'probed', presence: { [A.key]: 'absent', [B.key]: 'present' } })
      await pending
    })
    expect(chip('alpha')).toBeNull()
    expect(chip('beta')?.textContent).toBe('Mission Brief')
  })
})
