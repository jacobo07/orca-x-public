import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import { CONVERSATION_RECORD_SCHEMA_VERSION } from '../../shared/conversation-types'

import { ConversationStore } from './conversation-store'

// A gate against a future commit, not against today's code.
//
// `conversation-record-parse.ts` refuses a record whose stored version is LOWER than the current
// one, and refuses it as `unreadable`. At version 1 that is exactly right: nothing legitimate can
// be lower, so a lower number means a malformed file.
//
// The moment someone bumps the constant, that same branch starts telling every user that their
// existing conversations are corrupt — which is the worst available framing for "this needs
// migrating", and it is unrecoverable-looking to the person reading it. The bump is the cheap,
// obvious-feeling change; the consequence is three files away.
//
// So the bump has to fail here first.

let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-conv-schema-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('conversation record schema version', () => {
  it('is still 1, or a migration path has been built for older records', () => {
    // If you are here because you bumped the version: `load()` currently answers `unreadable` for
    // every record written by the previous build, so a user's whole history reads as damaged.
    // Before raising this number, give an older record its own outcome (the way `schema-too-new`
    // has one) and migrate or refuse it in words that say "older", not "broken". Then change this
    // assertion deliberately.
    expect(
      CONVERSATION_RECORD_SCHEMA_VERSION,
      'bumping the schema version makes every existing record read as unreadable — see this file'
    ).toBe(1)
  })

  it('keeps a too-new record distinct from a damaged one, which is the shape to copy', async () => {
    const store = new ConversationStore(directory)
    const id = mintConversationId()
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({ schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION + 1, id }),
      'utf-8'
    )

    const loaded = await store.load(id)
    // Not `unreadable`: the record is fine, this build is old. The caller can say "update Orca"
    // rather than "your conversation is corrupt". An older record deserves the same courtesy.
    expect(loaded.outcome).toBe('schema-too-new')
  })

  it('still calls a genuinely damaged record unreadable', async () => {
    const store = new ConversationStore(directory)
    const id = mintConversationId()
    writeFileSync(join(directory, `${id}.json`), '{ truncated', 'utf-8')

    // The control: without it, an implementation that answered `schema-too-new` for everything
    // would satisfy the case above.
    expect((await store.load(id)).outcome).toBe('unreadable')
  })
})
