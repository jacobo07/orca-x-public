import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BacklogItem } from '../../shared/backlog-types'
import { openBacklogLedger } from './backlog-ledger-open'
import { BacklogService } from './backlog-service'

const TRUNCATED_ID = 'bli_00000000-0000-4000-8000-00000000000a'
const MISMATCH_ID = 'bli_00000000-0000-4000-8000-00000000000b'
const TOO_NEW_ID = 'bli_00000000-0000-4000-8000-00000000000c'
const ORPHAN_ID = 'bli_00000000-0000-4000-8000-00000000000d'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-backlog-salvage-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function captured(service: BacklogService, text: string): Promise<BacklogItem> {
  const result = await service.capture({ text, kind: 'engineering' })
  if (result.outcome !== 'published') {
    throw new Error(`capture did not publish: ${result.outcome}`)
  }
  return result.record
}

describe('ledger open with per-record salvage', () => {
  it('loads the good records, quarantines exactly the 4 bad files and leaves their bytes alone', async () => {
    const service = new BacklogService(() => root)
    const first = await captured(service, 'first good item')
    const second = await captured(service, 'second good item')
    const [candidate] = await service.ingestCandidates([
      {
        source: {
          kind: 'orca-conversation',
          ref: 'conv_1',
          capturedAt: 1,
          adapter: 'orca-conversations',
          capabilityLevel: 'full'
        },
        fingerprint: 'fp-1',
        text: 'harvested',
        uncertainty: 'low'
      }
    ])
    const items = join(root, 'items')
    const bad = {
      truncated: join(items, `${TRUNCATED_ID}.json`),
      mismatch: join(items, `${MISMATCH_ID}.json`),
      tooNew: join(items, `${TOO_NEW_ID}.json`),
      garbage: join(items, 'garbage.json')
    }
    writeFileSync(bad.truncated, '{"schemaVersion": 1, "id": "bli_')
    writeFileSync(bad.mismatch, readFileSync(join(items, `${first.id}.json`)))
    writeFileSync(bad.tooNew, JSON.stringify({ ...second, id: TOO_NEW_ID, schemaVersion: 2 }))
    writeFileSync(bad.garbage, 'not a record')
    const orphan = join(items, `${ORPHAN_ID}.json.1.2.ab.tmp`)
    writeFileSync(orphan, '{"half":')
    const before = Object.fromEntries(Object.entries(bad).map(([key, path]) => [key, sha256(path)]))

    const ledger = await openBacklogLedger(root)

    if (ledger.outcome !== 'opened') {
      throw new Error(`open returned ${ledger.outcome}`)
    }
    expect(ledger.items.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
    expect(ledger.candidates.map((row) => row.id)).toEqual([candidate.id])
    expect(ledger.quarantined).toHaveLength(4)
    expect(new Set(ledger.quarantined.map((entry) => entry.code))).toEqual(
      new Set(['not-json', 'id-mismatch', 'schema-too-new', 'invalid-name'])
    )
    expect(ledger.quarantined.find((entry) => entry.code === 'invalid-name')).toMatchObject({
      recordKind: 'item',
      fileName: 'garbage.json',
      id: null
    })
    expect(ledger.quarantined.find((entry) => entry.code === 'schema-too-new')?.id).toBe(TOO_NEW_ID)
    expect(JSON.stringify(ledger.quarantined)).not.toContain('first good item')
    for (const [key, path] of Object.entries(bad)) {
      expect(sha256(path), key).toBe(before[key])
    }
    expect(existsSync(orphan)).toBe(true)
    expect(JSON.stringify(ledger.quarantined)).not.toContain(ORPHAN_ID)

    const refused = await service.update(TRUNCATED_ID, { priority: 'high' })
    expect(refused).toMatchObject({ outcome: 'unreadable', code: 'not-json' })
    for (const [key, path] of Object.entries(bad)) {
      expect(sha256(path), `${key} after refused update`).toBe(before[key])
    }
  })

  it('reports a scan failure, never an empty ledger, when items is not a directory', async () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'items'), 'a file where a directory belongs')

    const ledger = await openBacklogLedger(root)

    expect(ledger).toMatchObject({ outcome: 'storage-failed', stage: 'scan' })
    expect((ledger as { code: string | null }).code).not.toBeNull()
  })

  it('opens an empty ledger when the backlog directory does not exist', async () => {
    const ledger = await openBacklogLedger(join(root, 'never-created'))
    expect(ledger).toEqual({ outcome: 'opened', items: [], candidates: [], quarantined: [] })
  })

  it('loads every record past the concurrency limit', async () => {
    const service = new BacklogService(() => root)
    const ids = new Set<string>()
    for (let index = 0; index < 40; index += 1) {
      ids.add((await captured(service, `item ${index}`)).id)
    }

    const ledger = await openBacklogLedger(root)

    if (ledger.outcome !== 'opened') {
      throw new Error(`open returned ${ledger.outcome}`)
    }
    expect(ledger.items).toHaveLength(40)
    expect(new Set(ledger.items.map((item) => item.id))).toEqual(ids)
    expect(ledger.quarantined).toEqual([])
  })
})
