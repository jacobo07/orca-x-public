import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AiVaultListResult, AiVaultSession } from '../../../shared/ai-vault-types'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { readNativeChatTranscript } from '../../native-chat/transcript-reader'
import type { BacklogIngestEntryResult } from '../backlog-candidate-operations'
import { BacklogService } from '../backlog-service'
import { createBacklogHarvestRunner } from './backlog-harvest-runner'
import type { BacklogTranscriptSource } from './ai-vault-transcript-harvest'
import type { HarvestIngestPort } from './harvest-ingest-pipeline'

// Record shapes copied from src/main/native-chat/transcript-reader.test.ts (claude + codex cases).
function claudeLines(sessionTag: string): string {
  return [
    {
      type: 'user',
      uuid: `u-${sessionTag}`,
      timestamp: '2026-06-01T10:00:00.000Z',
      message: { role: 'user', content: '- [ ] wire the sources card' }
    },
    {
      type: 'assistant',
      uuid: `a-${sessionTag}`,
      timestamp: '2026-06-01T10:00:30.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '- [ ] wire the sources card' }] }
    }
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')
}

const CODEX_LINES = [
  {
    type: 'session_meta',
    timestamp: '2026-06-01T10:00:00.000Z',
    payload: { id: 'codex-sess-1', cwd: '/repo' }
  },
  {
    type: 'response_item',
    timestamp: '2026-06-01T10:00:01.000Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'Next: seed the export' }] }
  },
  {
    type: 'response_item',
    timestamp: '2026-06-01T10:00:05.000Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
  }
]
  .map((record) => JSON.stringify(record))
  .join('\n')

function sessionRow(
  agent: AiVaultSession['agent'],
  sessionId: string,
  filePath: string,
  modifiedAt: string,
  cwd: string | null = null
): AiVaultSession {
  return {
    id: `${agent}:${sessionId}`,
    executionHostId: 'local',
    agent,
    sessionId,
    title: 'Secret session title',
    cwd,
    branch: null,
    model: null,
    filePath,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt,
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  } as AiVaultSession
}

function isoAt(minute: number): string {
  return new Date(Date.UTC(2026, 5, 1, 0, 0) + minute * 60_000).toISOString()
}

type Read = (
  agent: 'claude' | 'codex',
  sessionId: string,
  filePath: string
) => ReturnType<BacklogTranscriptSource['readTranscript']>

// The real reader and real stat behind the port; the list is the only thing crossed at its port.
function portOver(
  rows: AiVaultSession[],
  options: {
    issues?: AiVaultListResult['issues']
    statBytes?: (filePath: string) => Promise<number>
    read?: Read
  } = {}
) {
  const reads: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const read: Read =
    options.read ?? ((agent, sessionId, filePath) =>
      readNativeChatTranscript(agent, sessionId, { filePath }))
  const source: BacklogTranscriptSource = {
    list: async () => ({ sessions: rows, issues: options.issues ?? [], scannedAt: isoAt(0) }),
    statBytes: options.statBytes ?? (async (filePath) => statSync(filePath).size),
    readTranscript: async (agent, sessionId, filePath) => {
      reads.push(sessionId)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setImmediate(resolve))
      try {
        return await read(agent, sessionId, filePath)
      } finally {
        inFlight -= 1
      }
    }
  }
  return { source, reads, maxInFlight: () => maxInFlight }
}

function publishingPort(): HarvestIngestPort {
  return {
    ingestCandidates: async (entries) =>
      entries.map(
        (_, index): BacklogIngestEntryResult => ({
          index,
          id: `blc_${index}`,
          outcome: 'published',
          code: null
        })
      )
  }
}

function runnerOver(source: BacklogTranscriptSource, service: HarvestIngestPort) {
  return createBacklogHarvestRunner({
    service,
    sources: {
      conversations: () => ({ listIds: async () => [], read: async () => ({ outcome: 'absent' }) }),
      transcripts: () => source
    }
  })
}

function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value)
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      stringsIn(entry, into)
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key)
      stringsIn(entry, into)
    }
  }
  return into
}

function messagesOf(
  specs: { id: string; role: 'user' | 'assistant'; text: string }[]
): NativeChatMessage[] {
  return specs.map((spec, index) => ({
    id: spec.id,
    role: spec.role,
    blocks: [{ type: 'text', text: spec.text }],
    timestamp: 1_000 + index,
    source: 'transcript'
  }))
}

describe('AI Vault transcript harvest', () => {
  let dir: string
  let claudeFile: string
  let codexFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-harvest-transcripts-'))
    claudeFile = join(dir, 'claude-session.jsonl')
    codexFile = join(dir, 'codex-session.jsonl')
    writeFileSync(claudeFile, claudeLines('one'))
    writeFileSync(codexFile, CODEX_LINES)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('turns user markers in Claude and Codex transcripts into candidates with provenance', async () => {
    const subagent = {
      ...sessionRow('claude', 'claude-sub', claudeFile, isoAt(9)),
      subagent: { parentSessionId: 'claude-sess-1', agentType: null, status: null }
    }
    const rows = [
      sessionRow('claude', 'claude-sess-1', claudeFile, isoAt(5), dir),
      sessionRow('codex', 'codex-sess-1', codexFile, isoAt(4), dir),
      sessionRow('gemini', 'gemini-1', join(dir, 'gemini.json'), isoAt(8)),
      subagent
    ]
    const counted = portOver(rows)
    const service = new BacklogService(() => join(dir, 'backlog'))

    const report = await runnerOver(counted.source, service).run('agent-transcripts')

    expect(report).toMatchObject({
      outcome: 'completed',
      unit: 'agent-transcripts',
      seen: 4,
      read: 2,
      candidatesNew: 2,
      unsupported: 1,
      cap: null
    })
    expect(report.outcome === 'completed' && report.skipped).toEqual({ subagent: 1 })
    expect(counted.reads).toEqual(['claude-sess-1', 'codex-sess-1'])
    expect(counted.maxInFlight()).toBe(1)

    const listed = (await new BacklogService(() => join(dir, 'backlog')).listCandidates({})) as {
      candidates: { text: string; source: Record<string, unknown>; projectHint: unknown }[]
    }
    const byKind = new Map(listed.candidates.map((row) => [row.source.kind, row]))
    expect(byKind.get('claude-code-transcript')).toMatchObject({
      text: 'wire the sources card',
      projectHint: null,
      source: {
        ref: 'claude:claude-sess-1#u-one#L0',
        adapter: 'ai-vault-transcript-harvest.v1',
        capabilityLevel: 'full',
        capturedAt: Date.parse('2026-06-01T10:00:00.000Z')
      }
    })
    const codex = byKind.get('codex-transcript')
    expect(codex).toMatchObject({
      text: 'seed the export',
      projectHint: null,
      source: {
        adapter: 'ai-vault-transcript-harvest.v1',
        capabilityLevel: 'full',
        capturedAt: Date.parse('2026-06-01T10:00:01.000Z')
      }
    })
    // Codex user records carry no id, so the reader's position id stands in, minus the file path.
    expect(codex?.source.ref).toMatch(/^codex:codex-sess-1#pos-\d{16}#L0$/)

    // Nothing that crosses the wire names a path, a title or a cwd (W-3).
    const forbidden = [dir, 'Secret session title']
    const leaks = (value: unknown) =>
      stringsIn(value).filter((text) => forbidden.some((needle) => text.includes(needle)))
    expect(leaks(report)).toEqual([])
    expect(leaks(listed)).toEqual([])
    const planted = { ...report, skipped: { planted: [{ deeper: claudeFile }] } }
    expect(leaks(planted)).toEqual([claudeFile])
    const plantedCandidate = { candidates: [{ source: { nested: { ref: `x${dir}` } } }] }
    expect(leaks(plantedCandidate)).toEqual([`x${dir}`])
  })

  it('filters to Claude and Codex before the cap, so newer foreign rows cannot starve them', async () => {
    const foreign = Array.from({ length: 600 }, (_, index) =>
      sessionRow('gemini', `gemini-${index}`, join(dir, 'g.json'), isoAt(1_000 + index))
    )
    const older = [0, 1, 2].map((index) =>
      sessionRow('claude', `claude-old-${index}`, claudeFile, isoAt(index))
    )
    const counted = portOver([...foreign, ...older])

    const report = await runnerOver(counted.source, publishingPort()).run('agent-transcripts')

    expect(report).toMatchObject({ outcome: 'completed', read: 3, unsupported: 600, cap: null })
    expect(counted.reads.toSorted()).toEqual(['claude-old-0', 'claude-old-1', 'claude-old-2'])
  })

  it('reads the 500 newest supported sessions and names the 3 it did not scan', async () => {
    const oldest = [0, 1, 2].map((index) =>
      sessionRow('claude', `claude-oldest-${index}`, claudeFile, isoAt(index))
    )
    const newer = Array.from({ length: 500 }, (_, index) =>
      sessionRow('claude', `claude-new-${index}`, claudeFile, isoAt(100 + index))
    )
    const counted = portOver([...oldest, ...newer].toReversed())

    const report = await runnerOver(counted.source, publishingPort()).run('agent-transcripts')

    expect(report).toMatchObject({
      outcome: 'completed',
      read: 500,
      cap: { code: 'sources-per-run', notScanned: 3, kept: 'newest' }
    })
    expect(counted.reads).toHaveLength(500)
    for (const row of oldest) {
      expect(counted.reads).not.toContain(row.sessionId)
    }

    const exact = portOver(newer)
    const boundary = await runnerOver(exact.source, publishingPort()).run('agent-transcripts')
    expect(boundary).toMatchObject({ outcome: 'completed', read: 500, cap: null })
  }, 60_000)

  it('never reads a transcript over 32 MiB, and counts read errors as unreadable', async () => {
    const hugeFile = join(dir, 'huge-session.jsonl')
    const rows = [
      sessionRow('claude', 'claude-huge', hugeFile, isoAt(3)),
      sessionRow('claude', 'claude-broken', claudeFile, isoAt(2)),
      sessionRow('codex', 'codex-sess-1', codexFile, isoAt(1))
    ]
    const counted = portOver(rows, {
      statBytes: async (filePath) => (filePath === hugeFile ? 32 * 1024 * 1024 + 1 : 10),
      read: async (agent, sessionId, filePath) =>
        sessionId === 'claude-broken'
          ? { error: 'EIO' }
          : readNativeChatTranscript(agent, sessionId, { filePath })
    })

    const report = await runnerOver(counted.source, publishingPort()).run('agent-transcripts')

    expect(counted.reads).toEqual(['claude-broken', 'codex-sess-1'])
    expect(report).toMatchObject({
      outcome: 'completed',
      read: 1,
      candidatesNew: 1,
      skipped: { 'transcript-too-large': 1, unreadable: 1 }
    })
  })

  it('counts a still-working unanswered ask as turn-unsettled and keeps its markers', async () => {
    const messages = messagesOf([
      { id: 'm1', role: 'user', text: '- [ ] keep this marker' },
      { id: 'm2', role: 'assistant', text: 'ok' },
      { id: 'm3', role: 'user', text: 'please ship it' }
    ])
    const lifecycle = (state: 'working' | 'completed') => ({
      state,
      turnId: 't',
      timestamp: null
    })
    const run = (state: 'working' | 'completed') =>
      runnerOver(
        portOver([sessionRow('claude', 'claude-live', claudeFile, isoAt(1))], {
          read: async () => ({ messages, lifecycle: lifecycle(state) })
        }).source,
        publishingPort()
      ).run('agent-transcripts')

    expect(await run('working')).toMatchObject({
      outcome: 'completed',
      candidatesNew: 1,
      skipped: { 'turn-unsettled': 1 }
    })
    // Control: the same transcript with a finished turn admits the unanswered ask too.
    const settled = await run('completed')
    expect(settled).toMatchObject({ outcome: 'completed', candidatesNew: 2 })
    expect(settled.outcome === 'completed' && settled.skipped).toEqual({})
  })

  it('counts scan issues as unreadable, and refuses the run when the list throws', async () => {
    const issue = { agent: 'claude' as const, kind: 'scope' as const, path: dir, message: 'EACCES' }
    const notice = { agent: 'claude' as const, kind: 'notice' as const, path: dir, message: 'more' }
    const withIssues = portOver([sessionRow('codex', 'codex-sess-1', codexFile, isoAt(1))], {
      issues: [issue, notice]
    })
    const report = await runnerOver(withIssues.source, publishingPort()).run('agent-transcripts')
    expect(report).toMatchObject({ outcome: 'completed', read: 1, skipped: { unreadable: 1 } })

    const failing: BacklogTranscriptSource = {
      ...withIssues.source,
      list: async () => {
        throw new Error('scan failed')
      }
    }
    const refused = await runnerOver(failing, publishingPort()).run('agent-transcripts')
    expect(refused).toMatchObject({ outcome: 'refused', code: 'source-unreadable' })
  })
})
