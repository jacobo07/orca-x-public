// WR-03: per-item link and evidence counts are bounded so a full item can still change state.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BACKLOG_DEPENDENCIES_MAX,
  BACKLOG_EVIDENCE_PER_ITEM_MAX,
  BACKLOG_EVIDENCE_PER_UPDATE_MAX,
  BACKLOG_EXECUTION_LINKS_PER_ITEM_MAX,
  BACKLOG_NORMALIZED_INTENT_MAX,
  BACKLOG_PROJECT_ID_MAX,
  BACKLOG_PROJECT_REFS_MAX,
  BACKLOG_RECORD_MAX_BYTES,
  BACKLOG_RECORD_STATE_HEADROOM_BYTES,
  BACKLOG_REF_MAX,
  BACKLOG_SHORT_TEXT_MAX,
  BACKLOG_SOURCE_LINKS_PER_ITEM_MAX,
  BACKLOG_TEXT_MAX
} from '../../shared/backlog-rpc-limits'
import type { BacklogItem, BacklogItemState } from '../../shared/backlog-types'
import { BacklogUpdateParams } from '../runtime/rpc/methods/backlog-params'
import {
  mintBacklogEventId,
  mintBacklogEvidenceId,
  mintBacklogItemId
} from './backlog-identity-mint'
import { describeBacklogItemDefect } from './backlog-item-validation'
import { BacklogService } from './backlog-service'

// JSON escapes a control character to six bytes: the most any bounded string can cost on disk.
const worst = (length: number): string => '\u0001'.repeat(length)
const candidateIdAt = (n: number): string => `blc_${n.toString(16).padStart(32, '0')}`

type Counts = { evidence: number; executionLinks: number; sourceLinks: number }

const FULL: Counts = {
  evidence: BACKLOG_EVIDENCE_PER_ITEM_MAX,
  executionLinks: BACKLOG_EXECUTION_LINKS_PER_ITEM_MAX,
  sourceLinks: BACKLOG_SOURCE_LINKS_PER_ITEM_MAX
}

function worstItem(state: BacklogItemState, counts: Counts = FULL): BacklogItem {
  const id = mintBacklogItemId()
  const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)
  return {
    schemaVersion: 1,
    id,
    kind: 'engineering',
    originalText: `x${worst(BACKLOG_TEXT_MAX - 1)}`,
    normalizedIntent: worst(BACKLOG_NORMALIZED_INTENT_MAX),
    projectRefs: range(BACKLOG_PROJECT_REFS_MAX).map((i) => ({
      projectId: `${i}${worst(BACKLOG_PROJECT_ID_MAX - String(i).length)}`,
      mapping: 'explicit' as const,
      evidence: worst(BACKLOG_SHORT_TEXT_MAX)
    })),
    state,
    priority: 'normal',
    dependencies: range(BACKLOG_DEPENDENCIES_MAX).map(() => mintBacklogItemId()),
    executorPolicy: null,
    sourceLinks: range(counts.sourceLinks).map((i) => ({
      kind: 'claude-code-transcript' as const,
      ref: `${i}${worst(BACKLOG_REF_MAX - String(i).length)}`,
      capturedAt: Number.MAX_SAFE_INTEGER,
      candidateId: candidateIdAt(i)
    })),
    executionLinks: range(counts.executionLinks).map((i) => ({
      kind: 'github-issue' as const,
      ref: `${i}${worst(BACKLOG_REF_MAX - String(i).length)}`
    })),
    evidence: range(counts.evidence).map(() => ({
      id: mintBacklogEvidenceId(),
      class: 'OBSERVED' as const,
      origin: 'tool' as const,
      subject: 'artifact' as const,
      source: worst(BACKLOG_SHORT_TEXT_MAX),
      ref: worst(BACKLOG_REF_MAX),
      observedAt: Number.MAX_SAFE_INTEGER
    })),
    events: [{ id: mintBacklogEventId(), type: 'created', at: 1, data: { origin: 'manual' } }],
    mergedInto: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

const bytes = (item: BacklogItem): number =>
  Buffer.byteLength(`${JSON.stringify(item, null, 2)}\n`, 'utf-8')

let root: string
let service: BacklogService

const pathOf = (id: string): string => join(root, 'items', `${id}.json`)
const sha = (id: string): string =>
  createHash('sha256').update(readFileSync(pathOf(id))).digest('hex')

function seed(item: BacklogItem): BacklogItem {
  writeFileSync(pathOf(item.id), `${JSON.stringify(item, null, 2)}\n`)
  return item
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-capacity-'))
  mkdirSync(join(root, 'items'))
  service = new BacklogService(() => root, { now: () => 5 })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('per-item capacity', () => {
  it('sizes the caps so a worst-case full item leaves the state headroom under the byte cap', () => {
    const item = worstItem('needs-triage')
    expect(describeBacklogItemDefect(item)).toBeNull()
    expect(bytes(item) + BACKLOG_RECORD_STATE_HEADROOM_BYTES).toBeLessThanOrEqual(
      BACKLOG_RECORD_MAX_BYTES
    )
    // A max-reason transition event, escaped at the worst rate, fits the headroom many times over.
    expect(BACKLOG_RECORD_STATE_HEADROOM_BYTES).toBeGreaterThan(8 * (6 * BACKLOG_SHORT_TEXT_MAX + 400))
  })

  it('reads an item over any per-item count as invalid', () => {
    for (const field of ['evidence', 'executionLinks', 'sourceLinks'] as const) {
      const over = worstItem('ready', { ...FULL, [field]: FULL[field] + 1 })
      expect(describeBacklogItemDefect(over), field).not.toBeNull()
    }
  })

  it('refuses growth past the cap, then a full item still transitions to dismissed', async () => {
    const item = seed(worstItem('needs-triage'))
    const before = sha(item.id)

    const grown = await service.update(item.id, {
      addEvidence: [{ class: 'OBSERVED', origin: 'tool', subject: 'gate', source: 'ci', ref: null }]
    })
    expect(grown).toMatchObject({ outcome: 'refused', code: 'item-capacity-exceeded' })
    const linked = await service.update(item.id, {
      addExecutionLinks: [{ kind: 'github-issue', ref: 'one-more' }]
    })
    expect(linked).toMatchObject({ outcome: 'refused', code: 'item-capacity-exceeded' })
    expect(sha(item.id)).toBe(before)

    const dismissed = await service.transition(item.id, {
      to: 'dismissed',
      reason: worst(BACKLOG_SHORT_TEXT_MAX)
    })
    expect(dismissed).toMatchObject({ outcome: 'published', record: { state: 'dismissed' } })
  })

  it('a full loser still takes its merge leg', async () => {
    const survivor = seed({ ...worstItem('ready', { evidence: 0, executionLinks: 0, sourceLinks: 1 }) })
    const loser = seed(
      worstItem('needs-triage', { ...FULL, sourceLinks: BACKLOG_SOURCE_LINKS_PER_ITEM_MAX - 1 })
    )

    const result = await service.mergeItems({ survivorId: survivor.id, loserId: loser.id })

    expect(result.survivor).toMatchObject({ outcome: 'published' })
    expect(result.loser).toMatchObject({
      outcome: 'published',
      record: { state: 'superseded', mergedInto: survivor.id }
    })
  })

  it('refuses a merge whose union would overflow the survivor, with both files untouched', async () => {
    const survivor = seed(worstItem('ready', { evidence: 0, executionLinks: 0, sourceLinks: 1 }))
    const loser = seed(worstItem('needs-triage'))
    const before = [sha(survivor.id), sha(loser.id)]

    const result = await service.mergeItems({ survivorId: survivor.id, loserId: loser.id })

    expect(result).toMatchObject({
      survivor: { outcome: 'refused', code: 'item-capacity-exceeded' },
      loser: null
    })
    expect([sha(survivor.id), sha(loser.id)]).toEqual(before)
  })

  it('bounds each update array at the params by the per-item caps', () => {
    const id = mintBacklogItemId()
    const evidenceRow = { class: 'OBSERVED', origin: 'tool', subject: 'gate', source: 's', ref: null }
    expect(BACKLOG_EVIDENCE_PER_UPDATE_MAX).toBeLessThanOrEqual(BACKLOG_EVIDENCE_PER_ITEM_MAX)
    const tooManyLinks = Array.from(
      { length: BACKLOG_EXECUTION_LINKS_PER_ITEM_MAX + 1 },
      (_, i) => ({ kind: 'github-issue', ref: `#${i}` })
    )
    expect(
      BacklogUpdateParams.safeParse({ id, patch: { addExecutionLinks: tooManyLinks } }).success
    ).toBe(false)
    expect(
      BacklogUpdateParams.safeParse({
        id,
        patch: { addEvidence: Array(BACKLOG_EVIDENCE_PER_ITEM_MAX + 1).fill(evidenceRow) }
      }).success
    ).toBe(false)
    // Control: a call at the cap is admitted by the params.
    expect(
      BacklogUpdateParams.safeParse({
        id,
        patch: { addExecutionLinks: tooManyLinks.slice(1) }
      }).success
    ).toBe(true)
  })
})
