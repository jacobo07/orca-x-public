// Real BacklogService on a temp root and a real ConversationStore directory: the SC2 property the
// export import reuses. Records are literal objects written to disk, never produced by the store.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConversationStore } from '../../conversation/conversation-store'
import { BacklogService } from '../backlog-service'
import { createBacklogHarvestRunner } from './backlog-harvest-runner'
import { conversationSourceFromStore } from './orca-conversation-harvest'

function writeConversation(dir: string, id: string, userText: string): void {
  const record = {
    schemaVersion: 1,
    id,
    title: null,
    createdAt: 1,
    updatedAt: 2,
    status: 'active',
    projectId: 'proj-1',
    provenance: [],
    turns: [{ turnId: 't1', seq: 0, state: 'completed', startedAt: 1, endedAt: 2 }],
    messages: [
      {
        id: 'u1',
        seq: 1,
        role: 'user',
        blocks: [{ type: 'text', text: userText }],
        timestamp: 10,
        turnId: 't1'
      },
      {
        id: 'a1',
        seq: 2,
        role: 'assistant',
        blocks: [{ type: 'text', text: 'ok' }],
        timestamp: 11,
        turnId: 't1'
      }
    ],
    nextSeq: 3
  }
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record))
}

describe('Orca conversation harvest idempotency', () => {
  let dir: string
  let conversations: string
  let ledger: string

  const runner = () => {
    const service = new BacklogService(() => ledger)
    return createBacklogHarvestRunner({
      service,
      sources: {
        conversations: () => conversationSourceFromStore(new ConversationStore(conversations))
      }
    })
  }
  const listed = async () =>
    (await new BacklogService(() => ledger).listCandidates({})) as {
      total: number
      candidates: { id: string; status: string; text: string; projectHint: unknown }[]
    }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-harvest-idem-'))
    conversations = join(dir, 'conversations')
    ledger = join(dir, 'backlog')
    mkdirSync(conversations)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds nothing on re-run, keeps a dismissal, and treats edited text as a new candidate', async () => {
    writeConversation(conversations, 'conv_a', '- [ ] first task\n- [ ] second task')

    expect(await runner().run('orca-conversations')).toMatchObject({
      outcome: 'completed',
      candidatesNew: 2,
      candidatesDuplicate: 0
    })
    expect(await runner().run('orca-conversations')).toMatchObject({
      candidatesNew: 0,
      candidatesDuplicate: 2
    })
    const first = await listed()
    expect(first.total).toBe(2)
    expect(first.candidates.every((row) => row.projectHint !== null)).toBe(true)
    const dismissed = first.candidates.find((row) => row.text === 'first task')!
    const resolved = await new BacklogService(() => ledger).resolveCandidate({
      action: 'dismiss',
      candidateId: dismissed.id
    })
    expect(resolved.candidate).toMatchObject({ outcome: 'published' })

    expect(await runner().run('orca-conversations')).toMatchObject({
      candidatesNew: 0,
      candidatesDuplicate: 2
    })
    const afterDismiss = await listed()
    expect(afterDismiss.candidates.find((row) => row.id === dismissed.id)?.status).toBe('dismissed')

    writeConversation(conversations, 'conv_a', '- [ ] first task, edited\n- [ ] second task')
    expect(await runner().run('orca-conversations')).toMatchObject({
      candidatesNew: 1,
      candidatesDuplicate: 1
    })
    const afterEdit = await listed()
    expect(afterEdit.total).toBe(3)
    expect(afterEdit.candidates.find((row) => row.id === dismissed.id)?.status).toBe('dismissed')
  })

  it('keeps the ref in the identity: one line in two conversations is two candidates', async () => {
    writeConversation(conversations, 'conv_a', '- [ ] shared line')
    writeConversation(conversations, 'conv_b', '- [ ] shared line')

    expect(await runner().run('orca-conversations')).toMatchObject({ candidatesNew: 2 })
    expect((await listed()).total).toBe(2)
  })

  it('writes each candidate once when two runs race over the same store', async () => {
    writeConversation(conversations, 'conv_a', '- [ ] one\n- [ ] two\n- [ ] three')
    const shared = runner()

    const reports = await Promise.all([
      shared.run('orca-conversations'),
      runner().run('orca-conversations')
    ])

    const created = reports.map((report) =>
      report.outcome === 'completed' ? report.candidatesNew + report.candidatesDuplicate : -1
    )
    expect(created).toEqual([3, 3])
    expect(
      reports.reduce((sum, r) => sum + (r.outcome === 'completed' ? r.candidatesNew : 0), 0)
    ).toBe(3)
    expect((await listed()).total).toBe(3)
  })
})
