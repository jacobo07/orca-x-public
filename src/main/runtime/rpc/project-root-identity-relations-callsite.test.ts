import { describe, expect, it } from 'vitest'
import { publishedRelationsOf } from '../../../shared/replica-pair-view'
import type { ProjectHostSetupWithReplicaTopology } from '../../../shared/replica-topology'
import {
  ANCHOR_SETUP_ID,
  CALLSITE_PROJECTION,
  CALLSITE_REPOS,
  FOLDER_SETUP_ID,
  REPLICA_SETUP_ID,
  RELATION_CALLSITE_CASES,
  relationFieldsOf
} from '../../../shared/replica-topology-relations-callsite-cases'
import { projectRootIdentityForClient } from './project-root-identity-client-projection'

// Why: the projectHostSetup.list call site, fed the way the RPC method feeds it.
function entriesBySetupId(views: Parameters<typeof publishedRelationsOf>[0] | undefined) {
  const result = projectRootIdentityForClient(
    'setups',
    CALLSITE_PROJECTION.setups,
    {
      clientCapabilities: undefined,
      runtime: { listRepos: () => [...CALLSITE_REPOS] }
    } as unknown as Parameters<typeof projectRootIdentityForClient>[2],
    views ? publishedRelationsOf(views) : undefined
  )
  const setups = result.setups as ProjectHostSetupWithReplicaTopology[]
  return new Map(setups.map((setup) => [setup.id, setup.replicaTopology]))
}

describe('projectHostSetup.list passes published relations to the topology (row 60)', () => {
  it.each(RELATION_CALLSITE_CASES.map((c) => [c.name, c] as const))(
    'replica relation for %s',
    (_name, relationCase) => {
      const entries = entriesBySetupId(relationCase.views)

      expect(relationFieldsOf(entries.get(REPLICA_SETUP_ID))).toEqual(relationCase.replica)
    }
  )

  it('anchor reads unverified with no reason, whatever the feed publishes (recorded Phase 2 risk)', () => {
    for (const relationCase of RELATION_CALLSITE_CASES) {
      const anchor = entriesBySetupId(relationCase.views).get(ANCHOR_SETUP_ID)

      expect(anchor).toMatchObject({ membership: 'grouped', relation: 'unverified' })
      expect(anchor).not.toHaveProperty('relationUnknownReason')
    }
  })

  it('keeps the folder workspace host-local with no relation', () => {
    for (const relationCase of RELATION_CALLSITE_CASES) {
      const folder = entriesBySetupId(relationCase.views).get(FOLDER_SETUP_ID)

      expect(folder).toMatchObject({ membership: 'host-local' })
      expect(folder).not.toHaveProperty('relation')
    }
  })
})
