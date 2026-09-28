// Halves of the process-boundary durability gate. Driven by
// config/scripts/conversation-durability-process-boundary.mjs, which runs this file twice in two
// separate OS processes: a writer that SIGKILLs itself the instant the durable write returns, and
// a cold reader that has never shared memory with it.
//
// Why not a same-process test: every other durability test here reloads through a fresh store
// INSTANCE, which proves nothing about the process dying. This is the closest thing to a crash
// that can be staged without cutting power.
//
// Both halves are inert without the driver's environment, so the driver requires each to print its
// token — a half that silently skipped would otherwise read exactly like a half that passed.

import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationRecord
} from '../../shared/conversation-types'

import { ConversationStore } from './conversation-store'

const directory = process.env.ORCA_CONVERSATION_PROBE_DIR
const role = process.env.ORCA_CONVERSATION_PROBE_ROLE
const probeId = process.env.ORCA_CONVERSATION_PROBE_ID
const MARKER = 'ORCA_W1_CROSSED_A_PROCESS_BOUNDARY'

/** Tokens go to a file, not stdout: vitest intercepts console output, so a console.log token
 *  reads as "the half never ran" even when it did. Measured here on the first attempt — every
 *  role passed and every token was missing. */
function reportToken(token: string): void {
  writeFileSync(join(directory as string, `${token}.token`), probeId as string, 'utf-8')
}

function probeRecord(id: string): ConversationRecord {
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id,
    title: 'process boundary',
    createdAt: 1,
    updatedAt: 2,
    status: 'active',
    projectId: null,
    provenance: [
      {
        agent: 'claude',
        providerSessionId: 'provider-session-that-will-not-outlive-this-process',
        transcriptPath: null,
        observedAt: 2
      }
    ],
    turns: [{ turnId: 'turn-1', seq: 0, state: 'working', startedAt: 2, endedAt: null }],
    messages: [
      {
        id: 'm-0',
        seq: 0,
        role: 'user',
        blocks: [{ type: 'text', text: MARKER }],
        timestamp: 2,
        turnId: 'turn-1'
      }
    ],
    nextSeq: 1
  }
}

describe.runIf(directory && role && probeId)('conversation survives a real process boundary', () => {
  it.runIf(role === 'write')('writes the record and then dies without cleanup', async () => {
    await new ConversationStore(directory as string).save(probeRecord(probeId as string))
    // Prove the bytes are on disk before dying, so a missing file in the reader means the record
    // did not survive rather than that the write never happened.
    expect(readdirSync(directory as string)).toContain(`${probeId}.json`)
    reportToken('PROBE_WRITE_OK')
    // SIGKILL, not a clean exit: no flush, no teardown, no atexit hook gets to help.
    process.kill(process.pid, 'SIGKILL')
  })

  it.runIf(role === 'read')('reads it back in a process that never saw the writer', async () => {
    const result = await new ConversationStore(directory as string).load(probeId as string)

    expect(result.outcome).toBe('loaded')
    if (result.outcome !== 'loaded') {
      return
    }
    expect(result.record.id).toBe(probeId)
    expect(result.record.messages[0]?.blocks[0]).toEqual({ type: 'text', text: MARKER })
    // The turn was unfinished when the writer died, and it must still say so.
    expect(result.record.turns[0]?.state).toBe('working')
    expect(result.record.turns[0]?.endedAt).toBeNull()
    // Provider continuation is still recorded as provenance, and is still not the identity.
    expect(result.record.provenance[0]?.providerSessionId).not.toBe(result.record.id)
    reportToken('PROBE_READ_OK')
  })

  it.runIf(role === 'read-absent')('reports absent when nothing was ever written', async () => {
    // The control that makes the reader's success mean something: it can return a different
    // answer. Without it, a reader that always said "loaded" would pass the case above.
    const result = await new ConversationStore(directory as string).load(mintConversationId())

    expect(result.outcome).toBe('absent')
    reportToken('PROBE_ABSENT_OK')
  })
})
