// Inheritance gate for the one property W1 exists to establish.
//
// The identity tests assert that today's conversation is pane-independent. This file asserts that
// it CANNOT QUIETLY STOP BEING SO: a later change that threads a pane, leaf, PTY, provider session
// or host into conversation identity — or lets one reach the durable record — fails here, whoever
// writes it and whichever layer they write it in.
//
// Every check ships a positive control, because each one is an absence assertion and an absence
// assertion satisfied by a detector that stopped detecting looks exactly like a pass.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import { ConversationPresentationAttachments } from '../../shared/conversation-presentation-attachment'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationRecord
} from '../../shared/conversation-types'

import { ConversationStore } from './conversation-store'

/** Identifiers whose lifetime is shorter than a conversation's. None may name a field of the
 *  durable record, and none may be readable out of the bytes on disk. */
const TRANSIENT_IDENTITY_FIELDS = [
  'paneKey',
  'leafId',
  'tabId',
  'ptyId',
  'terminalHandle',
  'providerThreadId',
  'providerSessionId',
  'processIncarnation',
  'runtimeIncarnation',
  'hostId'
] as const

function transientFieldsIn(record: object): string[] {
  return TRANSIENT_IDENTITY_FIELDS.filter((field) => field in record)
}

/** Compile-time half of the same claim, and the half that matters most: the runtime check reads a
 *  record this file builds, so an OPTIONAL pane field added to the type would never appear in it
 *  and the assertion would pass forever. This one fails `tsc --noEmit` the moment any transient
 *  identifier becomes a key of the record, optional or not. */
type TransientKeysOnRecord = Extract<
  keyof ConversationRecord,
  (typeof TRANSIENT_IDENTITY_FIELDS)[number]
>
const NO_TRANSIENT_KEYS_ON_RECORD: TransientKeysOnRecord extends never ? true : never = true

function record(): ConversationRecord {
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id: mintConversationId(),
    title: 'inheritance',
    createdAt: 1,
    updatedAt: 1,
    status: 'active',
    projectId: null,
    provenance: [],
    turns: [],
    messages: [],
    nextSeq: 0
  }
}

describe('conversation identity cannot be re-bound to a presentation', () => {
  it('mints from no input at all', () => {
    // Arity is the enforcement. Adding a parameter — the first move in re-deriving an id from a
    // pane — changes this number, and a caller cannot pass what the signature does not accept.
    expect(mintConversationId).toHaveLength(0)
  })

  it('keeps every transient identifier out of the durable record shape', () => {
    expect(transientFieldsIn(record())).toEqual([])
    // Holds the compile-time assertion above in the build graph; its real failure mode is tsc.
    expect(NO_TRANSIENT_KEYS_ON_RECORD).toBe(true)
  })

  it('CONTROL: the detector names a transient field when one is present', () => {
    // Without this, a typo in the field list would report every record clean forever.
    const contaminated = { ...record(), paneKey: 'tab-1:leaf-a', ptyId: 'pty-9' }
    expect(transientFieldsIn(contaminated).sort()).toEqual(['paneKey', 'ptyId'])
  })
})

describe('presentation cannot leak into durable bytes', () => {
  it('writes no pane key even while the conversation is attached to one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-conversation-inherit-'))
    try {
      const written = record()
      const paneKey = 'tab-77:8f3c1d20-0000-4000-8000-abcdefabcdef'
      const attachments = new ConversationPresentationAttachments()
      attachments.attach(written.id, paneKey)
      expect(attachments.paneFor(written.id)).toBe(paneKey)

      await new ConversationStore(directory).save(written)
      const onDisk = readFileSync(join(directory, `${written.id}.json`), 'utf-8')

      // The attachment is live and the bytes know nothing about it. That is the invariant: a
      // restart cannot resurrect a pane binding, because none was ever persisted.
      expect(onDisk).not.toContain(paneKey)
      expect(onDisk).not.toContain('tab-77')
      expect(onDisk).toContain(written.id)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('CONTROL: the same assertion fails when a pane key is put in the record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-conversation-inherit-control-'))
    try {
      const paneKey = 'tab-77:8f3c1d20-0000-4000-8000-abcdefabcdef'
      const contaminated = { ...record(), title: `pinned to ${paneKey}` }

      await new ConversationStore(directory).save(contaminated)
      const onDisk = readFileSync(join(directory, `${contaminated.id}.json`), 'utf-8')

      // Proves the byte-level check above can actually see a pane key, rather than passing
      // because nothing it looks for could ever appear in a JSON record.
      expect(onDisk).toContain(paneKey)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the conversation model does not depend on presentation modules', () => {
  const MODULES = [
    'src/shared/conversation-types.ts',
    'src/shared/conversation-identity.ts',
    'src/main/conversation/conversation-store.ts',
    'src/main/conversation/conversation-record-parse.ts'
  ]
  // A pane/terminal/PTY import into the identity or storage layer is how the coupling comes back:
  // once the type is in scope, putting it on the record is one line nobody reviews twice.
  const FORBIDDEN_IMPORT = /from\s+['"][^'"]*(?:pane|terminal|pty|tab-group|leaf)[^'"]*['"]/i

  it('imports nothing from the pane, terminal or PTY layers', () => {
    for (const module of MODULES) {
      const source = readFileSync(join(process.cwd(), module), 'utf-8')
      expect({ module, forbidden: FORBIDDEN_IMPORT.test(source) }).toEqual({
        module,
        forbidden: false
      })
    }
  })

  it('CONTROL: the import detector matches a real pane import', () => {
    expect(FORBIDDEN_IMPORT.test("import type { PaneKey } from '../terminal/pane-types'\n")).toBe(
      true
    )
    expect(FORBIDDEN_IMPORT.test("import { x } from './conversation-types'\n")).toBe(false)
  })
})
