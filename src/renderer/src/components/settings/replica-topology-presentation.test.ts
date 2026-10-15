import { describe, expect, it } from 'vitest'
import type { ReplicaTopologyEntry } from '../../../../shared/replica-topology'
import {
  REPLICA_UNKNOWN_REASONS,
  type ReplicaUnknownReason
} from '../../../../shared/workspace-replica-state'
import en from '../../i18n/locales/en.json'
import es from '../../i18n/locales/es.json'
import ja from '../../i18n/locales/ja.json'
import ko from '../../i18n/locales/ko.json'
import zh from '../../i18n/locales/zh.json'
import {
  describeReplicaRelation,
  describeReplicaUnknownReason,
  type ReplicaRelationTone
} from './replica-topology-presentation'

const entry = (overrides: Partial<ReplicaTopologyEntry>): ReplicaTopologyEntry => ({
  setupId: 'b',
  projectId: 'repo:b',
  hostId: 'ssh:gpu-vm',
  path: '/srv/b',
  provenance: 'legacy',
  membership: 'grouped',
  ...overrides
})

const RELATIONS = ['same', 'ahead', 'behind', 'diverged', 'unrelated', 'unverified'] as const

describe('describeReplicaRelation', () => {
  it('reads a published same as healthy, with no reason line (control)', () => {
    expect(describeReplicaRelation(entry({ relation: 'same' }))).toMatchObject({
      state: 'same',
      tone: 'healthy',
      detail: null
    })
  })

  it('reads an equal-but-unverified pair as unverified and unknown, never healthy', () => {
    const described = describeReplicaRelation(
      entry({ relation: 'unverified', relationUnknownReason: 'worktree-not-verified-clean' })
    )

    expect(described).toMatchObject({
      state: 'unverified',
      text: 'Relation unverified',
      tone: 'unknown',
      detail: 'Same commit, but the working tree is not verified clean'
    })
  })

  it('prints the count for ahead and behind and the pair for diverged', () => {
    const ahead = describeReplicaRelation(entry({ relation: 'ahead', relationAhead: 2 }))
    const behind = describeReplicaRelation(entry({ relation: 'behind', relationBehind: 4 }))
    const diverged = describeReplicaRelation(
      entry({ relation: 'diverged', relationAhead: 1, relationBehind: 3 })
    )

    expect(ahead.text).toContain('2')
    expect(ahead.tone).toBe('pressured')
    expect(behind.text).toContain('4')
    expect(behind.tone).toBe('pressured')
    expect(diverged.text).toContain('+1/-3')
    expect(diverged.tone).toBe('critical')
  })

  it('reads unrelated as critical', () => {
    expect(describeReplicaRelation(entry({ relation: 'unrelated' }))).toMatchObject({
      state: 'unrelated',
      tone: 'critical'
    })
  })

  it('says ahead, behind and diverged without a number when the count was not published', () => {
    for (const relation of ['ahead', 'behind', 'diverged'] as const) {
      const described = describeReplicaRelation(entry({ relation }))

      expect(described.state).toBe(relation)
      expect(described.text).not.toMatch(/\d/)
      expect(described.text).not.toContain('{{')
    }
  })

  it('reads a pair with no published relation as unverified without a reason line', () => {
    expect(describeReplicaRelation(entry({}))).toMatchObject({
      state: 'unverified',
      tone: 'unknown',
      detail: null
    })
    expect(describeReplicaRelation(entry({ relation: 'unverified' }))).toMatchObject({
      state: 'unverified',
      tone: 'unknown',
      detail: null
    })
  })

  it('is healthy for the published same and for nothing else, whatever the reason', () => {
    const tones = new Map<string, ReplicaRelationTone>()
    for (const relation of RELATIONS) {
      tones.set(relation, describeReplicaRelation(entry({ relation })).tone)
      for (const reason of REPLICA_UNKNOWN_REASONS) {
        const described = describeReplicaRelation(
          entry({ relation, relationUnknownReason: reason, relationAhead: 1, relationBehind: 1 })
        )
        expect(described.tone === 'healthy', `${relation}/${reason}`).toBe(relation === 'same')
      }
    }

    expect([...tones].filter(([, tone]) => tone === 'healthy')).toEqual([['same', 'healthy']])
  })

  it('refuses the old no-argument call at compile time', () => {
    void (() => {
      // @ts-expect-error describeReplicaRelation needs the topology entry
      describeReplicaRelation()
    })
    expect(describeReplicaRelation.length).toBe(1)
  })
})

describe('describeReplicaUnknownReason', () => {
  const details = REPLICA_UNKNOWN_REASONS.map(
    (reason) => [reason, describeReplicaUnknownReason(reason)] as const
  )

  it('covers all fifteen closed reasons', () => {
    expect(REPLICA_UNKNOWN_REASONS).toHaveLength(15)
  })

  it.each(details)('gives %s a real sentence, not the raw reason word', (reason, text) => {
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text).not.toBe(reason)
    expect(text).not.toContain('relationReason')
  })

  it('gives every reason a different sentence', () => {
    expect(new Set(details.map(([, text]) => text)).size).toBe(REPLICA_UNKNOWN_REASONS.length)
  })

  it('is the detail line of an unverified entry carrying that reason', () => {
    for (const reason of REPLICA_UNKNOWN_REASONS) {
      expect(
        describeReplicaRelation(entry({ relation: 'unverified', relationUnknownReason: reason }))
          .detail
      ).toBe(describeReplicaUnknownReason(reason))
    }
  })
})

type Leaves = Record<string, unknown>

function repositoryPaneOf(catalog: unknown): Leaves {
  const pane = (catalog as { auto?: { components?: { settings?: { RepositoryPane?: Leaves } } } })
    .auto?.components?.settings?.RepositoryPane
  if (!pane) {
    throw new Error('RepositoryPane catalog node is missing')
  }
  return pane
}

function reasonKey(reason: ReplicaUnknownReason): string {
  return `relationReason${reason
    .split('-')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')}`
}

describe('relation locale leaves', () => {
  const RELATION_LEAVES = [
    'relationTerm',
    'relationUnverified',
    'relationSame',
    'relationAhead',
    'relationBehind',
    'relationDiverged',
    'relationUnrelated',
    'relationAheadUncounted',
    'relationBehindUncounted',
    'relationDivergedUncounted',
    ...REPLICA_UNKNOWN_REASONS.map(reasonKey)
  ]
  const english = repositoryPaneOf(en)

  it.each([
    ['es', es],
    ['ja', ja],
    ['ko', ko],
    ['zh', zh]
  ])('%s carries every relation leaf with its own translation', (_code, catalog) => {
    const pane = repositoryPaneOf(catalog)
    for (const key of RELATION_LEAVES) {
      expect(typeof pane[key], `${key} missing`).toBe('string')
      expect((pane[key] as string).trim(), `${key} empty`).not.toBe('')
      expect(pane[key], `${key} fell back to the English text`).not.toBe(english[key])
    }
  })

  it('keeps the interpolation slots of the counted relation words in every locale', () => {
    for (const catalog of [en, es, ja, ko, zh]) {
      const pane = repositoryPaneOf(catalog)
      expect(pane.relationAhead).toContain('{{value0}}')
      expect(pane.relationBehind).toContain('{{value0}}')
      expect(pane.relationDiverged).toContain('{{value0}}')
      expect(pane.relationDiverged).toContain('{{value1}}')
    }
  })

  it('has fifteen distinct English reason sentences in en.json', () => {
    const values = REPLICA_UNKNOWN_REASONS.map((reason) => english[reasonKey(reason)])
    expect(values.every((value) => typeof value === 'string')).toBe(true)
    expect(new Set(values).size).toBe(15)
  })
})
