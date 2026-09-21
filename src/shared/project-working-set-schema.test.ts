import { describe, expect, it } from 'vitest'
import { readProjectWorkingSetManifest } from './project-working-set-schema'
import {
  entryOf,
  leafId,
  representativeManifest,
  SHARED_LABEL
} from './project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from './project-working-set-types'

function corruptReasonOf(mutate: (manifest: ProjectWorkingSetManifest) => void): string {
  const manifest = representativeManifest()
  mutate(manifest)
  const outcome = readProjectWorkingSetManifest(manifest)
  return outcome.status === 'corrupt' ? outcome.reason : outcome.status
}

describe('readProjectWorkingSetManifest — the representative working set', () => {
  it('accepts it unchanged', () => {
    expect(readProjectWorkingSetManifest(representativeManifest())).toEqual({
      status: 'valid',
      manifest: representativeManifest()
    })
  })

  it('keeps two rows that share a title as two distinct sessions', () => {
    const outcome = readProjectWorkingSetManifest(representativeManifest())
    if (outcome.status !== 'valid') {
      throw new Error(`expected valid, got ${outcome.status}`)
    }
    const shared = outcome.manifest.entries.filter((candidate) => candidate.label === SHARED_LABEL)

    expect(shared.map((candidate) => candidate.tabId)).toEqual(['tab-a', 'tab-b'])
    expect(shared[0].panes[0].resume).not.toEqual(shared[1].panes[0].resume)
  })

  it('returns rail order as captured, not sorted and not in entry order', () => {
    const outcome = readProjectWorkingSetManifest(representativeManifest())
    const rail = outcome.status === 'valid' ? outcome.manifest.railGroups.flat() : []

    expect(rail).toEqual(['tab-b', 'tab-e', 'tab-a', 'tab-d', 'tab-c'])
    expect(rail).not.toEqual([...rail].sort())
  })

  it('keeps a revival order that disagrees with rail order', () => {
    const manifest = representativeManifest()
    const autoInRailOrder = manifest.railGroups
      .flat()
      .filter((tabId) => entryOf(manifest, tabId).restorePolicy === 'auto-restore')

    expect(autoInRailOrder).toEqual(['tab-b', 'tab-a'])
    expect(readProjectWorkingSetManifest(manifest)).toMatchObject({
      status: 'valid',
      manifest: { revivalOrder: ['tab-a', 'tab-b'] }
    })
  })

  it('lets the active row be one that never materializes', () => {
    const manifest = representativeManifest()

    expect(entryOf(manifest, manifest.activeTabId!).restorePolicy).toBe('keep-dormant')
    expect(readProjectWorkingSetManifest(manifest).status).toBe('valid')
  })
})

describe('readProjectWorkingSetManifest — scope', () => {
  it('accepts a worktree owner written as a WorkspaceKey', () => {
    const manifest = representativeManifest()
    manifest.scope.ownerKey = 'worktree:repo-1::C:/work/orca'

    expect(readProjectWorkingSetManifest(manifest).status).toBe('valid')
  })

  it('accepts a folder workspace, whose key carries no repo or path', () => {
    const manifest = representativeManifest()
    manifest.scope = {
      executionHostId: 'ssh:target-1',
      ownerKey: 'folder:fw-1',
      location: { kind: 'folder-workspace', folderWorkspaceId: 'fw-1', folderPath: '/srv/notes' }
    }

    expect(readProjectWorkingSetManifest(manifest).status).toBe('valid')
  })

  it.each<[string, (manifest: ProjectWorkingSetManifest) => void]>([
    [
      'a sibling repo under the same key',
      (m) => {
        m.scope.location = { kind: 'repo-worktree', repoId: 'repo-2', worktreePath: 'C:/work/orca' }
      }
    ],
    [
      'a sibling worktree path under the same key',
      (m) => {
        m.scope.location = {
          kind: 'repo-worktree',
          repoId: 'repo-1',
          worktreePath: 'C:/work/other'
        }
      }
    ],
    [
      'a folder location under a worktree key',
      (m) => {
        m.scope.location = { kind: 'folder-workspace', folderWorkspaceId: 'fw-1', folderPath: '/x' }
      }
    ],
    [
      'a worktree location under a folder key',
      (m) => {
        m.scope.ownerKey = 'folder:fw-1'
      }
    ],
    [
      'an owner key that is neither shape',
      (m) => {
        m.scope.ownerKey = 'orca'
      }
    ]
  ])('rejects %s', (_label, mutate) => {
    expect(corruptReasonOf(mutate)).toBe('scope')
  })

  it('rejects an execution host id the host parser refuses', () => {
    expect(
      corruptReasonOf((m) => void Object.assign(m.scope, { executionHostId: 'runtime:' }))
    ).toBe('shape')
  })
})

describe('readProjectWorkingSetManifest — identity and order contradictions', () => {
  it.each<[string, string, (manifest: ProjectWorkingSetManifest) => void]>([
    ['two entries claim one tab', 'duplicate-entry', (m) => void (m.entries[1].tabId = 'tab-a')],
    [
      'one tab holds a leaf twice',
      'duplicate-entry',
      (m) => void m.entries[0].panes.push({ ...m.entries[0].panes[0] })
    ],
    [
      'the rail names a tab that is not an entry',
      'rail-order',
      (m) => void m.railGroups[0].push('tab-z')
    ],
    ['the rail places a tab twice', 'rail-order', (m) => void m.railGroups[1].push('tab-b')],
    ['the rail omits a restorable entry', 'rail-order', (m) => void m.railGroups[1].pop()],
    [
      'the rail shows a do-not-restore entry',
      'rail-order',
      (m) => void m.railGroups[1].push('tab-f')
    ],
    [
      'revival names a tab that is not an entry',
      'revival-order',
      (m) => void m.revivalOrder.push('tab-z')
    ],
    ['revival repeats a tab', 'revival-order', (m) => void m.revivalOrder.push('tab-a')],
    [
      'revival includes a non-auto entry',
      'revival-order',
      (m) => void m.revivalOrder.push('tab-c')
    ],
    ['revival omits an auto entry', 'revival-order', (m) => void m.revivalOrder.pop()],
    ['the active tab is not an entry', 'active-selection', (m) => void (m.activeTabId = 'tab-z')],
    ['the active tab is never restored', 'active-selection', (m) => void (m.activeTabId = 'tab-f')],
    [
      'the active leaf belongs to another tab',
      'active-selection',
      (m) => void (m.entries[0].activeLeafId = leafId(2))
    ]
  ])('rejects a manifest where %s', (_label, reason, mutate) => {
    expect(corruptReasonOf(mutate)).toBe(reason)
  })

  it('accepts a tab with no panes yet only when nothing is active in it', () => {
    const manifest = representativeManifest()
    entryOf(manifest, 'tab-e').panes = []
    expect(readProjectWorkingSetManifest(manifest).status).toBe('corrupt')

    entryOf(manifest, 'tab-e').activeLeafId = null
    expect(readProjectWorkingSetManifest(manifest).status).toBe('valid')
  })
})

describe('readProjectWorkingSetManifest — shape', () => {
  it.each<[string, (manifest: ProjectWorkingSetManifest) => void]>([
    [
      'a field this version does not define',
      (m) => void Object.assign(m.entries[0], { pid: 4242 })
    ],
    ['a malformed leaf id', (m) => void (m.entries[0].panes[0].leafId = 'leaf-1')],
    ['a tab id with a pane-key separator', (m) => void (m.entries[3].tabId = 'tab:d')],
    ['a working set id that is not a uuid', (m) => void (m.workingSetId = 'latest')],
    [
      'no entries at all',
      (m) =>
        void Object.assign(m, { entries: [], railGroups: [], revivalOrder: [], activeTabId: null })
    ],
    [
      'a provider session the agent cannot resume',
      (m) =>
        void (m.entries[0].panes[0].resume = {
          kind: 'provider-session',
          agent: 'claude',
          providerSession: { key: 'conversation_id', id: 'claude-session-a' },
          ompResumeFilePath: null
        })
    ],
    [
      'an unknown launch agent',
      (m) => void Object.assign(m.entries[0].launch, { launchAgent: 'not-an-agent' })
    ]
  ])('rejects %s', (_label, mutate) => {
    expect(corruptReasonOf(mutate)).toBe('shape')
  })

  it('names the failing path without echoing user content', () => {
    const manifest = representativeManifest()
    Object.assign(manifest.entries[0], { secretPrompt: 'do not echo me' })
    const outcome = readProjectWorkingSetManifest(manifest)

    expect(outcome.status).toBe('corrupt')
    expect(JSON.stringify(outcome)).not.toContain('do not echo me')
  })

  it('reports anything that is not an object as corrupt', () => {
    for (const raw of [null, 'manifest', 7, [representativeManifest()]]) {
      expect(readProjectWorkingSetManifest(raw)).toMatchObject({
        status: 'corrupt',
        reason: 'shape'
      })
    }
  })
})

describe('readProjectWorkingSetManifest — version', () => {
  it.each([2, 99, 0])('reports version %s as unsupported, not corrupt', (version) => {
    expect(
      readProjectWorkingSetManifest({ ...representativeManifest(), manifestVersion: version })
    ).toEqual({ status: 'unsupported-version', manifestVersion: version })
  })

  it('refuses a newer version even when its shape happens to match', () => {
    const newer = { ...representativeManifest(), manifestVersion: 2 }

    expect(readProjectWorkingSetManifest(newer).status).toBe('unsupported-version')
  })

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['a string', '1'],
    ['fractional', 1.5]
  ])('reports a version that is %s as corrupt', (_label, version) => {
    expect(
      readProjectWorkingSetManifest({ ...representativeManifest(), manifestVersion: version })
    ).toMatchObject({ status: 'corrupt', reason: 'shape' })
  })
})
