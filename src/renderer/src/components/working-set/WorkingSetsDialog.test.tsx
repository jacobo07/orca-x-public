/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { representativeManifest } from '../../../../shared/project-working-set-test-fixtures'
import type { WorkingSetListResult } from '../../../../shared/project-working-set-store-types'
import type { WorkingSetRestorePlan } from '../../../../shared/project-working-set-restore-plan'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const holder = vi.hoisted(() => ({
  store: null as unknown,
  list: null as unknown as (scope: unknown) => Promise<unknown>,
  preview: null as unknown as (request: unknown) => Promise<unknown>,
  restore: null as unknown as (request: unknown) => Promise<unknown>,
  save: null as unknown as (request: unknown) => Promise<unknown>,
  launch: { readiness: 'resolved', profiles: [] as { id: string }[] }
}))

vi.mock('@/store', () => {
  type Hook = ((selector?: unknown) => unknown) & {
    getState: () => unknown
    setState: (partial: unknown) => void
    subscribe: (listener: unknown) => () => void
  }
  const target = () => holder.store as Hook
  const useAppStore = Object.assign((selector?: unknown) => target()(selector), {
    getState: () => target().getState(),
    setState: (partial: unknown) => target().setState(partial),
    subscribe: (listener: unknown) => target().subscribe(listener)
  })
  return { useAppStore }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/project-working-set-client', () => ({
  listWorkingSets: (scope: unknown) => holder.list(scope)
}))
vi.mock('@/lib/project-working-set-restore', () => ({
  previewWorkingSetRestore: (request: unknown) => holder.preview(request)
}))
vi.mock('@/lib/project-working-set-product-restore', () => ({
  restoreWorkingSetFromProduct: (request: unknown) => holder.restore(request)
}))
vi.mock('@/lib/project-working-set-save', () => ({
  saveProjectWorkingSet: (request: unknown) => holder.save(request)
}))
vi.mock('@/hooks/useTerminalLaunchProfiles', () => ({
  useTerminalLaunchProfiles: () => holder.launch
}))

const { createTestStore } = await import('../../store/slices/store-test-helpers')
const store = createTestStore()
holder.store = store
const { WorkingSetsDialog } = await import('./WorkingSetsDialog')

const OWNER = 'repo-1::C:/work/orca'
const FIRST = representativeManifest()
const SECOND = { ...FIRST, workingSetId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', createdAt: 1 }
const PROFILES = [{ id: 'agent:claude' }]

function listed(): WorkingSetListResult {
  return {
    status: 'listed',
    valid: [FIRST, SECOND],
    latestWorkingSetId: FIRST.workingSetId,
    problems: [],
    tempArtifactCount: 0
  }
}

function plan(blockers: WorkingSetRestorePlan['blockers'] = []): WorkingSetRestorePlan {
  return {
    workingSetId: SECOND.workingSetId,
    label: SECOND.label,
    scope: SECOND.scope,
    railGroups: [],
    revivalOrder: [],
    activeTabId: null,
    entries: [],
    excludedSourceTabIds: [],
    blockers,
    summary: {
      entries: 5,
      panes: 5,
      byCapability: {
        'exact-resume': 2,
        restartable: 1,
        'recreate-context': 2,
        'history-only': 0,
        'not-restorable': 0,
        unknown: 0
      },
      autoWake: 0,
      liveElsewhere: 0,
      excluded: 0
    }
  }
}

let root: Root
let host: HTMLDivElement

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<void> {
  store.getState().openModal('working-sets', { ownerKey: OWNER, displayName: 'orca' })
  await act(async () => {
    root.render(<WorkingSetsDialog />)
  })
  await flush()
}

const q = (id: string) => document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)
const restoreButton = () => q('working-set-restore')[0] as HTMLButtonElement

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
  await flush()
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  holder.list = vi.fn(async () => listed())
  holder.preview = vi.fn(async () => ({ status: 'planned', plan: plan() }))
  holder.restore = vi.fn(async () => ({ status: 'restored', rows: 5 }))
  holder.launch = { readiness: 'resolved', profiles: PROFILES }
  holder.save = vi.fn(async () => ({
    status: 'saved',
    workingSetId: SECOND.workingSetId,
    bytes: 1,
    scrollback: { sealed: 0, absent: 0, failed: [] }
  }))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  store.getState().closeModal()
})

describe('WorkingSetsDialog', () => {
  it('says the store is unavailable instead of showing an empty history', async () => {
    holder.list = vi.fn(async () => ({ status: 'unavailable' }))
    await render()
    expect(q('working-sets-state')[0].dataset.workingSetsState).toBe('unavailable')
    expect(q('working-set-row')).toHaveLength(0)
    expect(restoreButton().disabled).toBe(true)
  })

  it('lists snapshots from the store for this workspace, by id', async () => {
    await render()
    expect(holder.list).toHaveBeenCalledWith({ executionHostId: 'local', ownerKey: OWNER })
    expect([...q('working-set-row')].map((row) => row.dataset.workingSetId)).toEqual([
      FIRST.workingSetId,
      SECOND.workingSetId
    ])
    expect(restoreButton().disabled).toBe(true)
  })

  it('restores the selected snapshot with the resolved profiles and closes', async () => {
    await render()
    await click(q('working-set-row')[1])
    expect(holder.preview).toHaveBeenLastCalledWith({
      scope: { executionHostId: 'local', ownerKey: OWNER },
      workingSetId: SECOND.workingSetId,
      launchProfiles: PROFILES
    })
    expect(restoreButton().disabled).toBe(false)
    await click(restoreButton())
    expect(holder.restore).toHaveBeenCalledExactlyOnceWith({
      scope: { executionHostId: 'local', ownerKey: OWNER },
      workingSetId: SECOND.workingSetId,
      launchProfiles: PROFILES
    })
    expect(store.getState().activeModal).toBe('none')
  })

  it('waits for launch options before previewing or restoring', async () => {
    holder.launch = { readiness: 'resolving', profiles: [] }
    await render()
    await click(q('working-set-row')[0])
    expect(holder.preview).not.toHaveBeenCalled()
    expect(restoreButton().disabled).toBe(true)
  })

  it('judges against no profiles, not a partial set, when a probe could not run', async () => {
    holder.launch = { readiness: 'unresolvable', profiles: PROFILES }
    await render()
    await click(q('working-set-row')[0])
    expect(holder.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ launchProfiles: null })
    )
  })

  it('keeps Restore off and says why when the workspace has open tabs', async () => {
    holder.preview = vi.fn(async () => ({
      status: 'planned',
      plan: plan(['current-work-present'])
    }))
    await render()
    await click(q('working-set-row')[0])
    expect(restoreButton().disabled).toBe(true)
    expect(
      document.body.querySelector('[data-working-set-blocker="current-work-present"]')
    ).not.toBeNull()
  })

  it('stays open and names a refusal the restore made after a clean preview', async () => {
    holder.restore = vi.fn(async () => ({ status: 'refused', blockers: ['current-work-present'] }))
    await render()
    await click(q('working-set-row')[0])
    await click(restoreButton())
    expect(store.getState().activeModal).toBe('working-sets')
    expect(q('working-set-restore-result')[0].textContent).toContain('open tabs')
  })

  it('saves this workspace and lists what the store now holds', async () => {
    holder.list = vi
      .fn()
      .mockResolvedValueOnce({ ...listed(), valid: [FIRST] })
      .mockResolvedValueOnce(listed())
    await render()
    expect(q('working-set-row')).toHaveLength(1)
    await click(q('working-set-save')[0])
    expect(holder.save).toHaveBeenCalledExactlyOnceWith({ ownerKey: OWNER })
    expect(holder.list).toHaveBeenCalledTimes(2)
    expect(q('working-set-row')).toHaveLength(2)
    expect(q('working-set-save-result')[0].dataset.workingSetSaveOk).toBe('true')
  })

  it('names a save that captured nothing and keeps the list as it was', async () => {
    holder.save = vi.fn(async () => ({
      status: 'not-capturable',
      reason: 'no-terminals',
      detail: OWNER
    }))
    await render()
    await click(q('working-set-save')[0])
    expect(holder.list).toHaveBeenCalledTimes(1)
    const result = q('working-set-save-result')[0]
    expect(result.dataset.workingSetSaveOk).toBe('false')
    expect(result.textContent).toContain('no terminals')
  })

  it('offers no save where the client has no store', async () => {
    holder.list = vi.fn(async () => ({ status: 'unavailable' }))
    await render()
    expect((q('working-set-save')[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('lets the click that owns a restore report it when a second click lands in the same turn', async () => {
    let release!: (value: unknown) => void
    holder.restore = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce({ status: 'in-flight' })
    await render()
    await click(q('working-set-row')[0])
    await act(async () => {
      restoreButton().click()
      restoreButton().click()
    })
    await flush()
    expect(q('working-set-restore-result')).toHaveLength(0)
    expect(restoreButton().disabled).toBe(true)
    await act(async () => release({ status: 'restored', rows: 5 }))
    await flush()
    expect(store.getState().activeModal).toBe('none')
  })

  it('re-checks the workspace when the selected row is chosen again', async () => {
    await render()
    await click(q('working-set-row')[0])
    await click(q('working-set-row')[0])
    expect(holder.preview).toHaveBeenCalledTimes(2)
  })

  it('never reports a rolled-back restore as a success', async () => {
    holder.restore = vi.fn(async () => ({ status: 'failed', stage: 'verify', rolledBack: true }))
    await render()
    await click(q('working-set-row')[0])
    await click(restoreButton())
    expect(store.getState().activeModal).toBe('working-sets')
    expect(q('working-set-restore-result')[0].textContent).toContain('undone')
  })
})
