import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  appendProviderProvenance,
  latestProviderProvenance,
  mintConversationId
} from '../../shared/conversation-identity'
import type { ConversationRecord } from '../../shared/conversation-types'
import { CONVERSATION_RECORD_SCHEMA_VERSION } from '../../shared/conversation-types'
import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { createAgentApprovalAuthority } from '../../shared/agent-approval-authority'
import { ConversationStore } from '../conversation/conversation-store'
import { runCodexAppServerSession } from './codex-app-server-session'
import { createCodexServerRequestBridge } from './codex-server-request-bridge'
import { mapCodexNotification } from './codex-turn-event-mapping'

// PRODUCTION REALITY GATE — W2.
//
// Drives the real `codex app-server` binary through the production transport, the production
// server-request bridge and the production event mapping. A fake server cannot stand in for this:
// the two defects W2 closes are both about what a REAL peer sends unprompted, and the id space it
// numbers its own requests in.
//
// Opt-in, because it spends a real account's tokens and needs an authenticated Codex:
//   ORCA_CODEX_REALITY=1  (optionally ORCA_CODEX_BIN=<path to codex>)
//
// Safety: the thread is read-only sandboxed, approvals are set to `untrusted` so every command is
// asked about, and Orca's authority has NO decider — so every approval is DENIED and nothing the
// model proposes is ever executed. The evidence is the denial being honoured.

const ENABLED = process.env.ORCA_CODEX_REALITY === '1'
const CODEX_BIN =
  process.env.ORCA_CODEX_BIN ??
  'C:\\Users\\User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'

type Trace = {
  events: AgentTurnEvent[]
  rawMethods: string[]
  /** Methods seen before thread/start's response — the handshake window. */
  duringHandshake: string[]
  approvals: { method: string; approved: boolean }[]
}

function emptyRecord(id: string): ConversationRecord {
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id,
    title: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'active',
    projectId: null,
    provenance: [],
    turns: [],
    messages: [],
    nextSeq: 1
  }
}

describe.skipIf(!ENABLED)('codex provider reality', () => {
  it(
    'runs a real turn, denies a real approval, and keeps one conversation across a provider death',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'orca-codex-reality-'))
      const store = new ConversationStore(join(cwd, 'conversations'))
      // The Orca-side identity, minted once and never re-derived from anything the provider owns.
      const conversationId = mintConversationId()
      let record = emptyRecord(conversationId)

      const trace: Trace = { events: [], rawMethods: [], duringHandshake: [], approvals: [] }
      let handshakeOpen = true

      const bridge = createCodexServerRequestBridge({
        // No decider: W2 has no surface that can ask a human, so every approval must be refused.
        authority: createAgentApprovalAuthority(),
        mintApprovalId: () => `appr_${trace.approvals.length}`,
        observe: (observation) => {
          if (observation.event === 'approval-requested') {
            trace.approvals.push({ method: observation.request.method, approved: false })
          }
          if (observation.event === 'approval-resolved') {
            const last = trace.approvals.at(-1)
            if (last) {
              last.approved = observation.approved
            }
          }
        }
      })

      const handlers = {
        onNotification: (notification: { method: string; params: unknown }) => {
          trace.rawMethods.push(notification.method)
          if (handshakeOpen) {
            trace.duringHandshake.push(notification.method)
          }
          trace.events.push(mapCodexNotification(notification))
        },
        onServerRequest: bridge.handle
      }

      const invocation = {
        command: CODEX_BIN,
        args: ['app-server'],
        timeoutMs: 240_000
      }

      // ── Leg 1: a real turn that wants to run a command ───────────────────────────────────────
      const threadId = await runCodexAppServerSession(
        invocation,
        async (rpc) => {
          const started = (await rpc.request('thread/start', {
            cwd,
            sandbox: 'read-only',
            approvalPolicy: 'untrusted'
          })) as { thread?: { id?: string } }
          handshakeOpen = false
          const id = started?.thread?.id
          expect(id, 'thread/start must report a thread id').toBeTruthy()

          await rpc.request('turn/start', {
            threadId: id,
            input: [
              {
                type: 'text',
                text: 'Run the shell command `echo orca-approval-probe` using your command execution tool, then report its output.'
              }
            ]
          })

          // The turn advances by notification, not by the turn/start response.
          await waitFor(
            () => trace.events.some((event) => event.kind === 'turn-completed'),
            200_000,
            'turn/completed'
          )
          return id as string
        },
        undefined,
        handlers
      )

      // A notification reached a consumer DURING the handshake — the traffic the old reader
      // discarded, and the reason the sink installs before the spawn.
      expect(trace.duringHandshake.length).toBeGreaterThan(0)

      // Streaming, lifecycle and content all normalized.
      expect(trace.events.some((event) => event.kind === 'turn-started')).toBe(true)
      expect(trace.events.some((event) => event.kind === 'assistant-delta')).toBe(true)
      expect(trace.events.some((event) => event.kind === 'turn-completed')).toBe(true)

      // A REAL server request arrived and was refused. Under the previous reader its id was not in
      // the pending map, so it was discarded and the peer waited for an answer that never came.
      expect(trace.approvals.length).toBeGreaterThan(0)
      expect(trace.approvals.every((approval) => approval.approved === false)).toBe(true)

      // The refusal was honoured: the command is recorded as not having run.
      const toolResults = trace.events.flatMap((event) =>
        event.kind === 'message-completed' && event.role === 'tool' ? event.blocks : []
      )
      expect(
        toolResults.some((block) => block.type === 'tool-result' && block.isError === true),
        'the declined command must be recorded as an error result, not an empty success'
      ).toBe(true)

      // Bind the provider thread as PROVENANCE, then persist.
      record = appendProviderProvenance(record, {
        agent: 'codex',
        providerSessionId: threadId,
        transcriptPath: null,
        observedAt: Date.now()
      })
      await store.save(record)

      // ── Leg 2: the provider process is gone. A new one resumes the same thread. ──────────────
      const resumedThreadId = await runCodexAppServerSession(
        invocation,
        async (rpc) => {
          const loaded = await store.load(conversationId)
          expect(loaded.outcome).toBe('loaded')
          const binding = latestProviderProvenance(
            (loaded as { record: ConversationRecord }).record
          )
          expect(binding?.providerSessionId).toBe(threadId)

          const resumed = (await rpc.request('thread/resume', {
            threadId: binding?.providerSessionId
          })) as { thread?: { id?: string } }
          return resumed?.thread?.id
        },
        undefined,
        { onNotification: () => {} }
      )

      // Same provider thread, recovered by a process that never shared memory with the first.
      expect(resumedThreadId).toBe(threadId)

      // And the Orca conversation is the one it always was: the provider death added lineage, it
      // did not mint a second conversation.
      const finalLoad = await store.load(conversationId)
      expect(finalLoad.outcome).toBe('loaded')
      const finalRecord = (finalLoad as { record: ConversationRecord }).record
      expect(finalRecord.id).toBe(conversationId)
      expect(finalRecord.provenance).toHaveLength(1)

      rmSync(cwd, { recursive: true, force: true })
    },
    600_000
  )
})

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}
