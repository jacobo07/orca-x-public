import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { ReplicaPairView } from '../../../shared/replica-pair-view'
import {
  ANCHOR_SETUP_ID,
  CALLSITE_PROJECTION,
  CALLSITE_REPOS,
  FOLDER_SETUP_ID,
  REPLICA_SETUP_ID,
  RELATION_CALLSITE_CASES,
  relationFieldsOf
} from '../../../shared/replica-topology-relations-callsite-cases'
import { getReplicaTopologyFromState } from './replica-topology-selector'
import { createReplicaPairSlice } from './slices/replica-pair'
import type { AppState } from './types'

const client = vi.hoisted(() => ({
  compareReplicaPairs: vi.fn(),
  readReplicaRelations: vi.fn()
}))
vi.mock('@/runtime/runtime-replica-pair-client', () => client)

// Why: the renderer call site, fed by the real replica-pair slice rather than a hand-built relations map.
async function entriesBySetupId(views: ReplicaPairView[] | undefined) {
  const store = create<AppState>()(
    (...a) =>
      ({
        repos: [...CALLSITE_REPOS],
        projects: [...CALLSITE_PROJECTION.projects],
        projectHostSetups: [...CALLSITE_PROJECTION.setups],
        settings: null,
        ...createReplicaPairSlice(...a)
      }) as unknown as AppState
  )
  if (views) {
    client.readReplicaRelations.mockResolvedValue({ status: 'ok', pairs: views })
    await store.getState().refreshReplicaPairRelations()
  }
  return getReplicaTopologyFromState(store.getState())
}

beforeEach(() => {
  client.readReplicaRelations.mockReset()
  client.compareReplicaPairs.mockReset()
})

describe('the renderer topology selector reads published relations (row 60)', () => {
  it.each(RELATION_CALLSITE_CASES.map((c) => [c.name, c] as const))(
    'replica relation for %s',
    async (_name, relationCase) => {
      const entries = await entriesBySetupId(relationCase.views)

      expect(relationFieldsOf(entries.get(REPLICA_SETUP_ID))).toEqual(relationCase.replica)
    }
  )

  it('anchor reads unverified with no reason, whatever the feed publishes (recorded Phase 2 risk)', async () => {
    for (const relationCase of RELATION_CALLSITE_CASES) {
      const anchor = (await entriesBySetupId(relationCase.views)).get(ANCHOR_SETUP_ID)

      expect(anchor).toMatchObject({ membership: 'grouped', relation: 'unverified' })
      expect(anchor).not.toHaveProperty('relationUnknownReason')
    }
  })

  it('keeps the folder workspace host-local with no relation', async () => {
    for (const relationCase of RELATION_CALLSITE_CASES) {
      const folder = (await entriesBySetupId(relationCase.views)).get(FOLDER_SETUP_ID)

      expect(folder).toMatchObject({ membership: 'host-local' })
      expect(folder).not.toHaveProperty('relation')
    }
  })
})
