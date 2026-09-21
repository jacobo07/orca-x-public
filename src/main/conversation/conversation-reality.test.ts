import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createCodexConversationDriver } from '../codex/codex-conversation-driver'
import { checkCodexAuth, codexAuthPath } from '../ipc/conversations'

import { ConversationService } from './conversation-service'
import { runConversationTurn, type ConversationTurnDeps } from './conversation-turn-runner'

// PRODUCTION REALITY GATE — W3.
//
// Drives the REAL `codex app-server` through the production driver, the production turn runner and
// the production durable store — the same objects the IPC handler builds. W2's gate proved the
// transport; this proves the PRODUCT path: a conversation that a user could have created, answered
// by a real provider, still there for a process that never shared memory with the one that wrote it.
//
// Opt-in, because it spends a real account's tokens:
//   ORCA_CODEX_REALITY=1  (optionally ORCA_CODEX_BIN=<path to codex>)
//
// Safety: the driver pins `sandbox: 'read-only'` and `approvalPolicy: 'untrusted'` with no approval
// decider, so every approval is denied and nothing the model proposes is executed. The prompt asks
// for a word, so no tool is needed and no approval should arise at all.

const ENABLED = process.env.ORCA_CODEX_REALITY === '1'
const CODEX_BIN = process.env.ORCA_CODEX_BIN

const SENTINEL = 'ORCA_W3_OK'

describe.skipIf(!ENABLED)('conversation product reality', () => {
  it(
    'answers a real turn, keeps it durably, and a cold process continues the same conversation',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-w3-reality-'))
      const directory = (): string => join(root, 'conversations')
      const cwd = mkdtempSync(join(tmpdir(), 'orca-w3-cwd-'))

      // Measured, not assumed: this names the home the CHILD inherits, which on this host is Orca's
      // managed runtime home rather than ~/.codex.
      const auth = await checkCodexAuth()
      expect(auth.ready, `codex must be signed in at ${codexAuthPath()} for this gate`).toBe(true)

      const driver = createCodexConversationDriver(
        CODEX_BIN !== undefined ? { command: CODEX_BIN } : {}
      )
      let turnSeq = 0
      let itemSeq = 0
      const deps = (service: ConversationService): ConversationTurnDeps => ({
        service,
        driver,
        checkAuth: checkCodexAuth,
        mintTurnId: () => `turn_real_${++turnSeq}`,
        mintItemId: () => `usr_real_${++itemSeq}`,
        emit: () => {}
      })

      // ── Leg 1: a real turn through the production runner ─────────────────────────────────────
      const first = new ConversationService(directory)
      const created = await first.create({ title: 'reality gate' })

      const outcome = await runConversationTurn(deps(first), {
        conversationId: created.id,
        text: `Reply with exactly ${SENTINEL} and nothing else.`,
        cwd
      })

      expect(outcome.outcome, JSON.stringify(outcome)).toBe('completed')
      if (outcome.outcome !== 'completed') {
        throw new Error('unreachable')
      }
      expect(outcome.providerSessionId).toBeTruthy()

      // ── The exchange is durable, read by a service that never saw the write ──────────────────
      const coldRead = await new ConversationService(directory).read(created.id)
      expect(coldRead.outcome).toBe('loaded')
      if (coldRead.outcome !== 'loaded') {
        throw new Error('unreachable')
      }
      const record = coldRead.record

      expect(record.id).toBe(created.id)
      expect(record.messages.map((message) => message.role)).toContain('user')
      expect(record.messages.map((message) => message.role)).toContain('assistant')

      const assistantText = record.messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.blocks)
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(' ')
      expect(assistantText).toContain(SENTINEL)

      // Settled, not merely started: a turn left `working` would load as still in progress.
      expect(record.turns).toHaveLength(1)
      expect(record.turns[0].state).toBe('completed')
      expect(record.turns[0].endedAt).not.toBeNull()

      // The provider thread is lineage, and it is NOT the conversation's identity.
      expect(record.provenance).toHaveLength(1)
      expect(record.provenance[0].providerSessionId).toBe(outcome.providerSessionId)
      expect(record.provenance[0].providerSessionId).not.toBe(record.id)

      // ── Leg 2: a cold service continues it. This is the restart the product has to survive. ──
      const second = new ConversationService(directory)
      const secondOutcome = await runConversationTurn(deps(second), {
        conversationId: created.id,
        text: `What word did you just say? Reply with exactly that word.`,
        cwd
      })

      expect(secondOutcome.outcome, JSON.stringify(secondOutcome)).toBe('completed')
      if (secondOutcome.outcome !== 'completed') {
        throw new Error('unreachable')
      }
      // Resumed rather than restarted: the same provider thread carried the second turn.
      expect(secondOutcome.providerSessionId).toBe(outcome.providerSessionId)

      const finalRead = await new ConversationService(directory).read(created.id)
      if (finalRead.outcome !== 'loaded') {
        throw new Error(`expected loaded, got ${finalRead.outcome}`)
      }
      const finalRecord = finalRead.record

      // One conversation, one identity, two turns. A provider rotation would have ADDED lineage,
      // never replaced the id.
      expect(finalRecord.id).toBe(created.id)
      expect(finalRecord.turns).toHaveLength(2)
      expect(finalRecord.provenance).toHaveLength(1)

      // No duplicated user message across the two turns.
      const userTexts = finalRecord.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''))
      expect(new Set(userTexts).size).toBe(userTexts.length)
      expect(userTexts).toHaveLength(2)

      // The model still knows what it said, which is what resuming the thread bought.
      const secondAnswer = finalRecord.messages
        .filter((message) => message.role === 'assistant')
        .slice(1)
        .flatMap((message) => message.blocks)
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(' ')
      expect(secondAnswer).toContain(SENTINEL)

      rmSync(root, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
    900_000
  )
})
