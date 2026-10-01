import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BACKLOG_INBOX_RUNTIME_CAPABILITY,
  BACKLOG_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { createBacklogHost } from '../backlog/backlog-host'
import { BacklogService } from '../backlog/backlog-service'
import { createBacklogHarvestRunner } from '../backlog/harvest/backlog-harvest-runner'
import { conversationSourceFromStore } from '../backlog/harvest/orca-conversation-harvest'
import { ConversationStore } from '../conversation/conversation-store'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'

const BACKLOG_STRINGS = ['backlog.v1', 'backlog.inbox.v1']

function backlogHostOn(root: string): ReturnType<typeof createBacklogHost> {
  const service = new BacklogService(() => join(root, 'backlog'))
  const harvester = createBacklogHarvestRunner({
    service,
    sources: {
      conversations: () =>
        conversationSourceFromStore(new ConversationStore(join(root, 'conversations'))),
      transcripts: () => ({
        list: async () => ({ sessions: [], issues: [], scannedAt: '' }),
        statBytes: async () => 0,
        readTranscript: async () => ({ messages: [] })
      })
    },
    ledgerRoot: () => join(root, 'backlog')
  })
  return createBacklogHost(service, harvester)
}

async function statusCapabilities(runtime: OrcaRuntimeService): Promise<string[]> {
  const response = await new RpcDispatcher({ runtime }).dispatch({
    id: 'req-status',
    authToken: 'tok',
    method: 'status.get'
  })
  if (!response.ok) {
    throw new Error(`status.get failed: ${response.error.message}`)
  }
  return (response.result as { capabilities: string[] }).capabilities
}

describe('backlog runtime capabilities', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-backlog-cap-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('names the two capability strings', () => {
    expect(BACKLOG_RUNTIME_CAPABILITY).toBe('backlog.v1')
    expect(BACKLOG_INBOX_RUNTIME_CAPABILITY).toBe('backlog.inbox.v1')
  })

  it('advertises backlog.v1 and backlog.inbox.v1 only while a backlog host is wired', async () => {
    const runtime = new OrcaRuntimeService()
    // Station control: status.get answered with a real list before absence means anything.
    const bare = await statusCapabilities(runtime)
    expect(bare.length).toBeGreaterThan(0)
    for (const capability of BACKLOG_STRINGS) {
      expect(bare).not.toContain(capability)
    }

    runtime.setBacklogHost(backlogHostOn(root))
    const wired = await statusCapabilities(runtime)
    expect(wired).toEqual(expect.arrayContaining(BACKLOG_STRINGS))

    runtime.setBacklogHost(null)
    const unwired = await statusCapabilities(runtime)
    expect(unwired.length).toBeGreaterThan(0)
    for (const capability of BACKLOG_STRINGS) {
      expect(unwired).not.toContain(capability)
    }
  })
})
