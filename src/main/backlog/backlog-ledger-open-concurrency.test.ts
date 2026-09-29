import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BACKLOG_OPEN_CONCURRENCY } from '../../shared/backlog-rpc-limits'
import type * as BacklogRecordFile from './backlog-record-file'

const reads = vi.hoisted(() => ({ inFlight: 0, maxInFlight: 0, total: 0 }))

vi.mock('./backlog-record-file', async (importOriginal) => {
  const actual = await importOriginal<typeof BacklogRecordFile>()
  return {
    ...actual,
    readBacklogRecordText: async (...args: Parameters<typeof actual.readBacklogRecordText>) => {
      reads.inFlight += 1
      reads.total += 1
      reads.maxInFlight = Math.max(reads.maxInFlight, reads.inFlight)
      try {
        // Hold each read open so parallel reads genuinely overlap.
        await new Promise((resolve) => setTimeout(resolve, 5))
        return await actual.readBacklogRecordText(...args)
      } finally {
        reads.inFlight -= 1
      }
    }
  }
})

const { openBacklogLedger } = await import('./backlog-ledger-open')
const { BacklogService } = await import('./backlog-service')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'backlog-open-concurrency-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ledger open read concurrency (T-01-21)', () => {
  it('never holds more than BACKLOG_OPEN_CONCURRENCY record reads in flight', async () => {
    const service = new BacklogService(() => root)
    const recordCount = BACKLOG_OPEN_CONCURRENCY * 3
    for (let index = 0; index < recordCount; index += 1) {
      const result = await service.capture({ text: `item ${index}`, kind: 'engineering' })
      expect(result.outcome).toBe('published')
    }
    Object.assign(reads, { inFlight: 0, maxInFlight: 0, total: 0 })

    const ledger = await openBacklogLedger(root)

    expect(ledger.outcome).toBe('opened')
    expect(reads.total).toBe(recordCount)
    // Equality, not <=: a scan that went serial would also stay under the cap.
    expect(reads.maxInFlight).toBe(BACKLOG_OPEN_CONCURRENCY)
  })
})
