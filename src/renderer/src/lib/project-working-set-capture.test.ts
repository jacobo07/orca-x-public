import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { leafId } from '../../../shared/project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from '../../../shared/project-working-set-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkingSetSaveResult } from '../../../shared/project-working-set-store-types'
import { projectWorkingSetFromState } from './project-working-set-capture'
import { saveWorkingSetManifest } from './project-working-set-client'
import { saveProjectWorkingSet } from './project-working-set-save'

const host = vi.hoisted(() => ({ id: 'local' }))
vi.mock('./worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => host.id
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

const OWNER = 'repo-1::C:/work/orca'
const request = {
  ownerKey: OWNER,
  label: null,
  workingSetId: '6f1d3c1e-2b7a-4c1e-9a3b-0d5e8f7a6b21',
  createdAt: 1
}
const session = { key: 'session_id', id: 'claude-session-1' }

function terminal(id: string, sortOrder: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    ptyId: null,
    worktreeId: OWNER,
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 0,
    ...extra
  }
}

function leaf(n: number) {
  return { type: 'leaf', leafId: leafId(n) }
}

/** Two groups; t2 sorts first by sortOrder but is second in the rail, t1 is a split. */
function baseState(): Record<string, unknown> {
  return {
    settings: { tabAutoGenerateTitle: false },
    tabsByWorktree: {
      [OWNER]: [
        terminal('t1', 5, { customTitle: 'Build', launchAgent: 'claude' }),
        terminal('t2', 0, { customTitle: 'Build' }),
        terminal('t3', 1)
      ]
    },
    unifiedTabsByWorktree: {
      [OWNER]: [
        { id: 'u1', entityId: 't1', contentType: 'terminal' },
        { id: 'u2', entityId: 't2', contentType: 'terminal' },
        { id: 'u3', entityId: 't3', contentType: 'terminal' },
        { id: 'e1', entityId: 'C:/work/orca/a.ts', contentType: 'editor' }
      ]
    },
    groupsByWorktree: {
      [OWNER]: [
        { id: 'g1', tabOrder: ['u1', 'e1', 'u2'] },
        { id: 'g2', tabOrder: ['u3'] }
      ]
    },
    activeTabIdByWorktree: { [OWNER]: 't2' },
    terminalLayoutsByTabId: {
      t1: {
        root: { type: 'split', direction: 'vertical', first: leaf(1), second: leaf(2) },
        activeLeafId: leafId(2),
        expandedLeafId: null,
        titlesByLeafId: { [leafId(1)]: 'agent' }
      },
      t2: { root: leaf(3), activeLeafId: 'not-in-layout', expandedLeafId: null },
      t3: { root: leaf(4), activeLeafId: leafId(4), expandedLeafId: null }
    },
    agentStatusByPaneKey: {
      [`t1:${leafId(1)}`]: { agentType: 'claude', providerSession: session }
    },
    sleepingAgentSessionsByPaneKey: {},
    retainedAgentsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    folderWorkspaces: []
  }
}

const capture = (state: Record<string, unknown>, req = request) =>
  projectWorkingSetFromState(state as unknown as AppState, req)

function captured(state: Record<string, unknown>, req = request) {
  const result = capture(state, req)
  if (result.status !== 'captured') {
    throw new Error(`expected a capture, got ${result.reason}: ${result.detail}`)
  }
  return result.manifest
}

describe('projectWorkingSetFromState', () => {
  beforeEach(() => {
    host.id = 'local'
  })

  it('takes display order from the rail, never from sortOrder, and wakes nothing', () => {
    const manifest = captured(baseState())
    expect(manifest.railGroups).toEqual([['t1', 't2'], ['t3']])
    expect(manifest.revivalOrder).toEqual([])
    expect(manifest.entries.every((entry) => entry.restorePolicy === 'restore-on-open')).toBe(true)
    expect(manifest.scope).toEqual({
      executionHostId: 'local',
      ownerKey: OWNER,
      location: { kind: 'repo-worktree', repoId: 'repo-1', worktreePath: 'C:/work/orca' }
    })
    expect(manifest.activeTabId).toBe('t2')
  })

  it('keys rows by terminal id, so two identical labels stay two rows', () => {
    const [t1, t2] = captured(baseState()).entries
    expect([t1.label, t2.label]).toEqual(['Build', 'Build'])
    expect([t1.tabId, t2.tabId]).toEqual(['t1', 't2'])
  })

  it('records per-pane resume evidence without lending the tab agent to a split sibling', () => {
    const t1 = captured(baseState()).entries[0]
    expect(t1.activeLeafId).toBe(leafId(2))
    expect(t1.panes.map((pane) => pane.title)).toEqual(['agent', null])
    expect(t1.panes[0].resume).toEqual({
      kind: 'provider-session',
      agent: 'claude',
      providerSession: session,
      ompResumeFilePath: null
    })
    expect(t1.panes[1].resume).toEqual({ kind: 'absent', reason: 'not-an-agent' })
  })

  it('drops an active leaf the layout does not contain', () => {
    expect(captured(baseState()).entries[1].activeLeafId).toBeNull()
  })

  it('uses a sleeping record when the pane has no live row', () => {
    const state = baseState()
    state.agentStatusByPaneKey = {}
    state.sleepingAgentSessionsByPaneKey = {
      [`t1:${leafId(1)}`]: { agent: 'claude', providerSession: session }
    }
    expect(captured(state).entries[0].panes[0].resume).toMatchObject({
      kind: 'provider-session',
      providerSession: session
    })
  })

  it('names why a pane cannot be resumed instead of guessing a launch', () => {
    const state = baseState()
    state.agentStatusByPaneKey = {
      [`t1:${leafId(1)}`]: { agentType: 'claude' },
      [`t3:${leafId(4)}`]: { agentType: 'aider' }
    }
    const manifest = captured(state)
    expect(manifest.entries[0].panes[0].resume).toEqual({
      kind: 'absent',
      reason: 'no-provider-session-captured'
    })
    expect(manifest.entries[2].panes[0].resume).toEqual({
      kind: 'absent',
      reason: 'agent-not-resumable'
    })
  })

  it('captures a folder workspace by its folder, not by a guessed worktree', () => {
    const owner = folderWorkspaceKey('fw-1')
    const state = baseState()
    for (const key of ['tabsByWorktree', 'unifiedTabsByWorktree', 'groupsByWorktree']) {
      const map = state[key] as Record<string, unknown>
      state[key] = { [owner]: map[OWNER] }
    }
    state.folderWorkspaces = [{ id: 'fw-1', folderPath: 'C:/notes', executionHostId: 'local' }]
    expect(captured(state, { ...request, ownerKey: owner }).scope.location).toEqual({
      kind: 'folder-workspace',
      folderWorkspaceId: 'fw-1',
      folderPath: 'C:/notes'
    })
    state.folderWorkspaces = []
    expect(capture(state, { ...request, ownerKey: owner })).toMatchObject({
      status: 'not-capturable',
      reason: 'folder-workspace-unknown'
    })
  })

  it('refuses a composition it cannot express faithfully', () => {
    const refusal = (mutate: (state: Record<string, unknown>) => void) => {
      const state = baseState()
      mutate(state)
      const result = capture(state)
      return result.status === 'not-capturable' ? result.reason : result.status
    }
    expect(refusal((s) => (s.tabsByWorktree = {}))).toBe('no-terminals')
    expect(refusal((s) => (s.groupsByWorktree = {}))).toBe('rail-unavailable')
    expect(
      refusal((s) => (s.groupsByWorktree = { [OWNER]: [{ id: 'g1', tabOrder: ['u1', 'u2'] }] }))
    ).toBe('terminal-outside-rail')
    expect(
      refusal(
        (s) =>
          (s.groupsByWorktree = {
            [OWNER]: [
              { id: 'g1', tabOrder: ['u1', 'u2'] },
              { id: 'g2', tabOrder: ['u3', 'u1'] }
            ]
          })
      )
    ).toBe('terminal-in-two-groups')
    expect(
      refusal((s) => {
        const layouts = s.terminalLayoutsByTabId as Record<string, { root: unknown }>
        layouts.t3.root = { type: 'leaf', leafId: '7' }
      })
    ).toBe('invalid-pane-identity')
    host.id = 'runtime:unresolved-owner'
    expect(refusal(() => {})).toBe('execution-host-unresolved')
  })

  it('does not capture the launch environment of an agent', () => {
    const state = baseState()
    state.agentLaunchConfigByPaneKey = {
      [`t1:${leafId(1)}`]: {
        launchConfig: { agentArgs: '', agentEnv: { SECRET_TOKEN: 'do-not-persist' } }
      }
    }
    expect(JSON.stringify(captured(state))).not.toContain('do-not-persist')
  })
})

describe('saveProjectWorkingSet', () => {
  const deps = (state: Record<string, unknown>, save = vi.fn()) => ({
    readState: vi.fn(() => state as unknown as AppState),
    save,
    now: () => 7,
    newId: () => '0b9e7d2c-4a1f-4e3b-8c6d-2f1a9e8b7c54'
  })

  it('projects before the first await, so a later store change cannot reach the manifest', async () => {
    const state = baseState()
    let release!: (value: unknown) => void
    const save = vi.fn(
      (_manifest: ProjectWorkingSetManifest) =>
        new Promise<WorkingSetSaveResult>((resolve) => (release = resolve as typeof release))
    )
    const d = deps(state, save)
    const pending = saveProjectWorkingSet({ ownerKey: OWNER, label: 'eod' }, d)
    ;(state.tabsByWorktree as Record<string, unknown[]>)[OWNER].push(terminal('late', 9))
    release({ status: 'saved', workingSetId: '0b9e7d2c-4a1f-4e3b-8c6d-2f1a9e8b7c54', notices: [] })
    expect(await pending).toMatchObject({ status: 'saved' })
    expect(d.readState).toHaveBeenCalledTimes(1)
    const manifest = save.mock.calls[0][0]
    expect(manifest.entries.map((entry) => entry.tabId)).toEqual(['t1', 't2', 't3'])
    expect(manifest.label).toBe('eod')
  })

  it('never calls the store for a refused capture', async () => {
    const d = deps({ ...baseState(), tabsByWorktree: {} })
    expect(await saveProjectWorkingSet({ ownerKey: OWNER }, d)).toMatchObject({
      reason: 'no-terminals'
    })
    expect(d.save).not.toHaveBeenCalled()
  })

  it('reports a client without a store as such, not as a save', async () => {
    const bridge = {
      save: vi.fn(async () => undefined),
      list: vi.fn(),
      read: vi.fn(),
      probeRestoreEvidence: vi.fn()
    }
    const d = deps(
      baseState(),
      vi.fn((manifest) => saveWorkingSetManifest(manifest, bridge))
    )
    expect(await saveProjectWorkingSet({ ownerKey: OWNER }, d)).toEqual({ status: 'unavailable' })
    expect(bridge.save).toHaveBeenCalledTimes(1)
  })
})
