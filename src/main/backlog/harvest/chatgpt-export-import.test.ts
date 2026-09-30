// Real files and a real BacklogService on a temp root. Fixtures are literal objects run through
// JSON.stringify; the export shape is ASSUMED (research Q3): UNVERIFIED-ON-REAL-EXPORT (D-13).

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BACKLOG_HARVEST_EXPORT_BYTES_MAX } from '../../../shared/backlog-harvest-limits'
import type { BacklogCandidate } from '../../../shared/backlog-types'
import { BacklogService } from '../backlog-service'
import { importChatGptExportFile } from './chatgpt-export-import'

function textMessage(role: string, text: string, createTime: number | null = 1_700_000_100) {
  return {
    id: `m-${role}-${text.length}`,
    author: { role, name: null, metadata: {} },
    create_time: createTime,
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully',
    end_turn: true,
    metadata: {}
  }
}

const exportMembers = [
  {
    id: 'conv-a',
    update_time: 1_700_000_500,
    current_node: 'a1',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['a1'],
        message: textMessage(
          'user',
          '- [ ] rotate the keys\ntodo: renew the certificate\n- [ ] assistant marker'
        )
      },
      a1: { id: 'a1', parent: 'u1', children: [], message: textMessage('assistant', 'Sure.') }
    }
  },
  {
    id: 'conv-b',
    update_time: 1_700_000_900,
    current_node: 'u2',
    mapping: {
      u1: { id: 'u1', parent: null, children: ['a1'], message: textMessage('user', 'hello there') },
      a1: { id: 'a1', parent: 'u1', children: ['u2'], message: textMessage('assistant', 'Hi.') },
      u2: {
        id: 'u2',
        parent: 'a1',
        children: [],
        message: textMessage('user', 'please draft the migration plan', null)
      }
    }
  },
  {
    id: 'conv-e',
    update_time: 1_700_003_000,
    current_node: 'a1',
    mapping: {
      u1: {
        id: 'u1',
        parent: null,
        children: ['a1'],
        message: textMessage('user', 'what should I track?')
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: textMessage('assistant', '- [ ] assistant marker')
      }
    }
  },
  { id: 'x', mapping: null }
]

function walkFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .toSorted()
}

describe('importChatGptExportFile', () => {
  let dir: string
  let exportDir: string
  let exportPath: string
  let ledger: string

  const service = () => new BacklogService(() => ledger)
  const now = () => 1_800_000_000_000
  const listed = async () =>
    (await service().listCandidates({})) as { total: number; candidates: BacklogCandidate[] }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-chatgpt-import-'))
    exportDir = join(dir, 'export')
    ledger = join(dir, 'backlog')
    mkdirSync(exportDir)
    exportPath = join(exportDir, 'conversations.json')
    writeFileSync(exportPath, JSON.stringify(exportMembers))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports the user asks as bounded chatgpt-export candidates and names the malformed member', async () => {
    const result = await importChatGptExportFile(exportPath, { service: service(), now })

    expect(result).toMatchObject({
      outcome: 'scanned',
      seen: 4,
      read: 3,
      skipped: { 'missing-mapping': 1 },
      cap: null,
      tally: { candidatesNew: 4, candidatesDuplicate: 0, halted: null }
    })
    const { candidates } = await listed()
    const byText = new Map(candidates.map((candidate) => [candidate.text, candidate]))
    expect([...byText.keys()].toSorted()).toEqual([
      'assistant marker',
      'please draft the migration plan',
      'renew the certificate',
      'rotate the keys'
    ])
    expect(byText.get('rotate the keys')).toMatchObject({
      uncertainty: 'medium',
      projectHint: null,
      source: {
        kind: 'chatgpt-export',
        ref: 'conv-a#u1#L0',
        adapter: 'chatgpt-export-import.v1',
        capabilityLevel: 'bounded',
        capturedAt: 1_700_000_100_000
      }
    })
    // The same marker line from the assistant (conv-e) yields nothing; this one is the user's.
    expect(byText.get('assistant marker')?.source.ref).toBe('conv-a#u1#L2')
    expect(byText.get('please draft the migration plan')).toMatchObject({
      uncertainty: 'high',
      source: { ref: 'conv-b#u2', capturedAt: 1_700_000_900_000 }
    })
  })

  it('adds nothing on a second import and keeps a dismissal', async () => {
    const first = await importChatGptExportFile(exportPath, { service: service(), now })
    const firstTotal =
      first.outcome === 'scanned' ? first.tally.candidatesNew + first.tally.candidatesDuplicate : -1
    const dismissed = (await listed()).candidates[0]
    await service().resolveCandidate({ action: 'dismiss', candidateId: dismissed.id })

    const second = await importChatGptExportFile(exportPath, { service: service(), now })

    expect(second).toMatchObject({
      outcome: 'scanned',
      tally: { candidatesNew: 0, candidatesDuplicate: firstTotal }
    })
    const after = await listed()
    expect(after.total).toBe(4)
    expect(after.candidates.find((row) => row.id === dismissed.id)?.status).toBe('dismissed')
  })

  it('writes nothing but candidate records and leaves the export directory untouched', async () => {
    const exportListing = walkFiles(exportDir)

    await importChatGptExportFile(exportPath, { service: service(), now })

    expect(walkFiles(exportDir)).toEqual(exportListing)
    const written = walkFiles(ledger)
    expect(written).toHaveLength(4)
    expect(written.every((path) => /^candidates\/[^/]+\.json$/.test(path))).toBe(true)
  })

  it('refuses a directory, a missing file and a parse refusal, ingesting nothing', async () => {
    writeFileSync(join(exportDir, 'broken.json'), '{')
    writeFileSync(join(exportDir, 'object.json'), JSON.stringify({ conversations: [] }))
    const cases: [string, string][] = [
      [exportDir, 'not-a-file'],
      [join(exportDir, 'missing.json'), 'read-failed'],
      [join(exportDir, 'broken.json'), 'not-json'],
      [join(exportDir, 'object.json'), 'not-an-export']
    ]
    for (const [path, code] of cases) {
      expect(await importChatGptExportFile(path, { service: service(), now })).toEqual({
        outcome: 'refused',
        code
      })
    }
    expect((await listed()).total).toBe(0)
  })

  it('refuses a symbolic link to a valid export', async (context) => {
    const link = join(dir, 'link.json')
    try {
      symlinkSync(exportPath, link, 'file')
    } catch (error) {
      const reason = `symlink-unavailable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`
      console.warn(`[chatgpt-export-import.test] skipped real symlink case: ${reason}`)
      expect(reason).toMatch(/^symlink-unavailable:/)
      context.skip()
      return
    }
    expect(await importChatGptExportFile(link, { service: service(), now })).toEqual({
      outcome: 'refused',
      code: 'not-a-file'
    })
    expect((await listed()).total).toBe(0)
  })

  it('refuses what lstat reports as a symlink even where the host cannot create one', async () => {
    const readFile = vi.fn(async () => JSON.stringify(exportMembers))
    const fs = {
      lstat: async () => ({ isFile: () => false, isSymbolicLink: () => true, size: 10 }),
      readFile
    }

    expect(await importChatGptExportFile(exportPath, { service: service(), now, fs })).toEqual({
      outcome: 'refused',
      code: 'not-a-file'
    })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('refuses a stat over 128 MiB without reading, and passes one exactly at the cap', async () => {
    const readFile = vi.fn(async () => JSON.stringify(exportMembers))
    const statOf = (size: number) => ({
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size }),
      readFile
    })

    const over = await importChatGptExportFile(exportPath, {
      service: service(),
      now,
      fs: statOf(BACKLOG_HARVEST_EXPORT_BYTES_MAX + 1)
    })
    expect(over).toEqual({ outcome: 'refused', code: 'too-large' })
    expect(readFile).not.toHaveBeenCalled()
    expect((await listed()).total).toBe(0)

    const atCap = await importChatGptExportFile(exportPath, {
      service: service(),
      now,
      fs: statOf(BACKLOG_HARVEST_EXPORT_BYTES_MAX)
    })
    expect(atCap).toMatchObject({ outcome: 'scanned' })
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('refuses a file that grew past the cap between the stat and the read', async () => {
    const grown = JSON.stringify(exportMembers)
    const readFile = vi.fn(async () => grown)
    const fs = {
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 8 }),
      readFile
    }

    expect(
      await importChatGptExportFile(exportPath, {
        service: service(),
        now,
        fs,
        bytesMax: Buffer.byteLength(grown) - 1
      })
    ).toEqual({ outcome: 'refused', code: 'too-large' })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect((await listed()).total).toBe(0)
  })

  it('reads an export saved with a byte-order mark', async () => {
    writeFileSync(exportPath, `\uFEFF${JSON.stringify(exportMembers)}`)

    expect(await importChatGptExportFile(exportPath, { service: service(), now })).toMatchObject({
      outcome: 'scanned',
      tally: { candidatesNew: 4 }
    })
  })
})
