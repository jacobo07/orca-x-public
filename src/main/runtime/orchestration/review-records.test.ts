import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb, SCHEMA_VERSION } from './db'
import { deriveIndependence, judgeReviewCurrency } from './review-records'

const REV_A = 'a'.repeat(40)
const REV_B = 'b'.repeat(40)

describe('review independence is derived, never declared', () => {
  it('names the same agent, the same provider, and missing facts apart from independence', () => {
    expect(deriveIndependence({ agentId: 'builder', provider: 'codex' }, { agentId: 'reviewer', provider: 'claude' })).toBe('independent')
    expect(deriveIndependence({ agentId: 'builder', provider: 'codex' }, { agentId: 'reviewer', provider: 'codex' })).toBe('degraded-same-provider')
    expect(deriveIndependence({ agentId: 'builder', provider: 'codex' }, { agentId: 'builder', provider: 'claude' })).toBe('degraded-same-agent')
    expect(deriveIndependence({ agentId: 'builder', provider: null }, { agentId: 'reviewer', provider: 'claude' })).toBe('unknown')
    expect(deriveIndependence({ agentId: null, provider: 'codex' }, { agentId: 'reviewer', provider: null })).toBe('unknown')
  })

  it('does not call an unknown builder independent just because the providers differ', () => {
    // An unnamed builder may be the reviewer itself; that is a missing fact, not independence.
    expect(deriveIndependence({ agentId: null, provider: 'codex' }, { agentId: 'reviewer', provider: 'claude' })).toBe('unknown')
  })
})

describe('a review describes one revision', () => {
  const review = { subject_revision: REV_A, subject_patch_hash: 'patch-a' }

  it('is current only for that exact revision and patch', () => {
    expect(judgeReviewCurrency(review, { revision: REV_A, patchHash: 'patch-a' })).toEqual({ current: true })
    expect(judgeReviewCurrency(review, { revision: REV_B, patchHash: 'patch-a' })).toEqual({ current: false, reason: 'revision-moved' })
    expect(judgeReviewCurrency(review, { revision: REV_A, patchHash: 'patch-b' })).toEqual({ current: false, reason: 'patch-changed' })
    expect(judgeReviewCurrency(review, null)).toEqual({ current: false, reason: 'subject-unreadable' })
  })
})

describe('ReviewStore', () => {
  const opened: OrchestrationDb[] = []
  let dir = ''

  afterEach(() => {
    for (const db of opened) {
      db.close()
    }
    opened.length = 0
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  function open(path = ':memory:'): OrchestrationDb {
    const db = new OrchestrationDb(path)
    opened.push(db)
    return db
  }

  const subject = { projectId: 'github:acme/api', worktreePath: '/w/api', revision: REV_A, patchHash: 'patch-a' }

  it('records the request, then re-derives independence from the provider that actually reviewed', () => {
    const store = open().reviews()
    const created = store.create({
      runId: 'legacy',
      subject,
      producer: { agentId: 'builder', provider: 'codex' },
      reviewer: { agentId: 'reviewer', provider: null },
      reviewTaskId: null
    })
    expect(created).toMatchObject({ status: 'requested', independence: 'unknown', subject_revision: REV_A })

    const sameProvider = store.settle(created.id, { status: 'completed', reviewerProvider: 'codex', findings: 'looks fine' })

    expect(sameProvider).toMatchObject({ status: 'completed', independence: 'degraded-same-provider', findings: 'looks fine' })
    expect(store.listForSubject('github:acme/api', REV_A).map((row) => row.id)).toEqual([created.id])
    expect(store.listForSubject('github:acme/api', REV_B)).toEqual([])
  })

  it('arrives on a database created before reviews existed', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reviews-v30-'))
    const path = join(dir, 'orchestration.db')
    open(path).close()
    opened.length = 0
    const raw = new Database(path)
    raw.exec('DROP TABLE reviews')
    raw.pragma('user_version = 30')
    raw.close()

    const upgraded = open(path)

    expect(upgraded.reviews().create({
      runId: 'legacy',
      subject,
      producer: { agentId: null, provider: null },
      reviewer: { agentId: 'reviewer', provider: null },
      reviewTaskId: null
    }).status).toBe('requested')
    const check = new Database(path)
    expect(check.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    check.close()
  })
})
