import { describe, expect, it } from 'vitest'
import { buildResumeCenterModel } from './resume-center-model'
import type {
  DeskProjection,
  DeskTab,
  DeskWorkspace
} from '../../../../shared/desk-continuity-projection'

function tab(tabId: string, residency: DeskTab['residency'], title = tabId): DeskTab {
  return {
    tabId,
    title,
    agent: null,
    residency,
    resume: 'none',
    panes: [{ leafId: null, title: null, preview: { source: 'none' } }]
  }
}

function workspace(
  key: string,
  sequence: number | null,
  lastVisitedAt: number | null,
  tabs: DeskTab[]
): DeskWorkspace {
  return {
    kind: 'projected',
    key,
    hostId: 'local',
    identity: { kind: 'known', name: key.toUpperCase(), path: `/src/${key}` },
    window:
      sequence === null
        ? { kind: 'unattributed', reason: 'no-window-binding' }
        : { kind: 'bound', windowId: `w${sequence}`, sequence },
    lastVisitedAt,
    tabs,
    orphanSessions: [],
    openFileCount: 0,
    browserTabCount: 0
  }
}

const projection: DeskProjection = {
  hosts: [
    {
      kind: 'loaded',
      hostId: 'local',
      workspaces: [
        workspace('beta', 7, 10, [tab('b1', 'warm'), tab('b2', 'dormant', 'claude review')]),
        workspace('alpha', 3, 5, [tab('a1', 'unknown')]),
        workspace('loose', null, 99, [tab('l1', 'no-process')]),
        { kind: 'unprojectable', key: 'bad', hostId: 'local', reason: 'corrupt' }
      ]
    },
    { kind: 'unreadable', hostId: 'ssh:box', reason: 'parse' }
  ],
  windowsRecorded: true,
  windowCount: 2,
  totals: {
    workspaces: 4,
    tabs: 4,
    panes: 4,
    byResidency: { warm: 1, dormant: 1, 'no-process': 1, unknown: 1 }
  }
}

describe('buildResumeCenterModel', () => {
  it('orders by window position, numbering windows 1..n, then unattributed by recency', () => {
    const model = buildResumeCenterModel(projection, { query: '', sort: 'window' })
    expect(model.workspaces.map((w) => [w.key, w.windowOrder])).toEqual([
      ['alpha', 1],
      ['beta', 2],
      ['loose', null]
    ])
  })

  it('orders by most recent visit when asked', () => {
    const model = buildResumeCenterModel(projection, { query: '', sort: 'recent' })
    expect(model.workspaces.map((w) => w.key)).toEqual(['loose', 'beta', 'alpha'])
  })

  it('counts each workspace by residency without folding unknown into anything', () => {
    const beta = buildResumeCenterModel(projection, { query: '', sort: 'window' }).workspaces.find(
      (w) => w.key === 'beta'
    )
    expect(beta?.counts).toEqual({ tabs: 2, panes: 2, warm: 1, dormant: 1, unknown: 0 })
  })

  it('searches names, paths and tab titles, case-insensitively', () => {
    expect(
      buildResumeCenterModel(projection, { query: 'CLAUDE', sort: 'window' }).workspaces.map(
        (w) => w.key
      )
    ).toEqual(['beta'])
    expect(
      buildResumeCenterModel(projection, { query: '/src/alpha', sort: 'window' }).workspaces.map(
        (w) => w.key
      )
    ).toEqual(['alpha'])
  })

  it('keeps unreadable hosts and unprojectable workspaces visible instead of dropping them', () => {
    const model = buildResumeCenterModel(projection, { query: 'nothing-matches', sort: 'window' })
    expect(model.workspaces).toEqual([])
    expect(model.unreadableHosts).toEqual([{ hostId: 'ssh:box', reason: 'parse' }])
    expect(model.unprojectable).toEqual([{ key: 'bad', hostId: 'local', reason: 'corrupt' }])
  })
})
