// Conversations are profile-scoped, and this proves it by ASKING THE STORE rather than by reading
// the pathname. A test that asserts the string contains the profile id would pass against a store
// that writes everywhere and reads everything — the question is what a profile can SEE.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationId,
  type ConversationRecord
} from '../../shared/conversation-types'
import { ConversationStore } from '../conversation/conversation-store'

import { getOrcaConversationsDirectory, getOrcaProfileDirectory } from './profile-storage-paths'

const PROFILE_A = 'profile-alpha'
const PROFILE_B = 'profile-beta'

let userDataPath = ''

function record(id: ConversationId, title: string): ConversationRecord {
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id,
    title,
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

function storeFor(profileId: string): ConversationStore {
  return new ConversationStore(getOrcaConversationsDirectory(profileId, userDataPath))
}

beforeEach(() => {
  // The temp name deliberately carries no conversation id, so an absence assertion below cannot be
  // satisfied by the fixture's own path.
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-conv-profile-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('conversation directory profile isolation', () => {
  it('keeps one profile’s conversations out of another profile’s listing', async () => {
    const storeA = storeFor(PROFILE_A)
    const storeB = storeFor(PROFILE_B)
    const idA = mintConversationId()

    await storeA.save(record(idA, 'alpha planning'))

    // Positive control FIRST: without it, a store that lists nothing at all would satisfy every
    // isolation assertion in this file and read as perfect isolation.
    expect(await storeA.list()).toContain(idA)
    expect(await storeB.list()).not.toContain(idA)
    expect(await storeB.list()).toEqual([])
  })

  it('isolates in both directions, so neither profile is merely empty', async () => {
    const storeA = storeFor(PROFILE_A)
    const storeB = storeFor(PROFILE_B)
    const idA = mintConversationId()
    const idB = mintConversationId()

    await storeA.save(record(idA, 'alpha'))
    await storeB.save(record(idB, 'beta'))

    expect(await storeA.list()).toEqual([idA])
    expect(await storeB.list()).toEqual([idB])
  })

  it('cannot read the other profile’s record even when handed its id', async () => {
    const storeA = storeFor(PROFILE_A)
    const storeB = storeFor(PROFILE_B)
    const idA = mintConversationId()

    await storeA.save(record(idA, 'alpha secrets'))

    // Discovery is not the only boundary: a leaked id must not become a read.
    expect((await storeA.load(idA)).outcome).toBe('loaded')
    expect((await storeB.load(idA)).outcome).toBe('absent')
  })

  it('nests the conversations directory inside the profile it belongs to', () => {
    // Structural, and secondary to the behavioural cases above: it is what makes a profile delete
    // take its conversations with it rather than orphaning them.
    expect(getOrcaConversationsDirectory(PROFILE_A, userDataPath)).toContain(
      getOrcaProfileDirectory(PROFILE_A, userDataPath)
    )
    expect(getOrcaConversationsDirectory(PROFILE_A, userDataPath)).not.toEqual(
      getOrcaConversationsDirectory(PROFILE_B, userDataPath)
    )
  })
})
