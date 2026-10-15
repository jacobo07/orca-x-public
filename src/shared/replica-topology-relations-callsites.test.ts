import { describe, expect, it } from 'vitest'
import {
  ANCHOR_SETUP_ID,
  CALLSITE_PROJECTION,
  CALLSITE_REPOS,
  FOLDER_SETUP_ID,
  REPLICA_SETUP_ID,
  RELATION_CALLSITE_CASES,
  relationFieldsOf
} from './replica-topology-relations-callsite-cases'
import { publishedRelationsOf } from './replica-pair-view'
import { deriveReplicaTopology, type ReplicaTopologyEntry } from './replica-topology'

// Why: the two call sites (RPC projection, renderer selector) each have a test in their own tsc
// project that asserts these same literal cases; this file proves the cases match the pure producer.
function producerEntries(
  views: Parameters<typeof publishedRelationsOf>[0] | undefined
): Map<string, ReplicaTopologyEntry> {
  const entries = deriveReplicaTopology({
    setups: CALLSITE_PROJECTION.setups,
    repos: [...CALLSITE_REPOS],
    identityCollisions: CALLSITE_PROJECTION.identityCollisions,
    ...(views ? { relations: publishedRelationsOf(views) } : {})
  })
  return new Map(entries.map((entry) => [entry.setupId, entry]))
}

describe('relation call-site cases agree with the pure producer (row 60)', () => {
  it.each(RELATION_CALLSITE_CASES.map((c) => [c.name, c] as const))(
    'replica relation for %s',
    (_name, relationCase) => {
      const entries = producerEntries(relationCase.views)

      expect(relationFieldsOf(entries.get(REPLICA_SETUP_ID))).toEqual(relationCase.replica)
    }
  )

  it('anchor reads unverified with no reason, whatever the feed publishes (recorded Phase 2 risk)', () => {
    for (const relationCase of RELATION_CALLSITE_CASES) {
      const anchor = producerEntries(relationCase.views).get(ANCHOR_SETUP_ID)

      expect(anchor).toMatchObject({ membership: 'grouped', relation: 'unverified' })
      expect(anchor).not.toHaveProperty('relationUnknownReason')
    }
  })

  it('keeps the folder workspace host-local with no relation, whatever the feed publishes', () => {
    for (const relationCase of RELATION_CALLSITE_CASES) {
      const folder = producerEntries(relationCase.views).get(FOLDER_SETUP_ID)

      expect(folder).toMatchObject({ membership: 'host-local' })
      expect(folder).not.toHaveProperty('relation')
    }
  })

  it('has a case for every relation kind and a reason-carrying unverified (control)', () => {
    const relations = new Set(RELATION_CALLSITE_CASES.map((c) => c.replica.relation))

    expect([...relations].sort()).toEqual(
      ['ahead', 'behind', 'diverged', 'same', 'unrelated', 'unverified'].sort()
    )
    expect(RELATION_CALLSITE_CASES.some((c) => c.replica.relationUnknownReason)).toBe(true)
  })
})
