// Where does a project-scoped agent's turn actually RUN?
//
// CHARACTERIZATION (2026-09-22). These cases pin today's behaviour, which is wrong, so that the
// commit that fixes it INVERTS them in place and the diff between the two versions is the evidence.
// Nothing here is a statement about what the product should do.
//
// The defect is not "the agent lacks project context". It is worse and more specific: the agent is
// rooted in ORCA'S OWN INSTALL DIRECTORY, so a question about "this repository" is answered about
// Orca's packaged files. Wrong context is not absent context — it looks like an answer.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintAgentId } from '../../shared/agent-identity'
import type { Agent } from '../../shared/agent-types'
import { ConversationService } from './conversation-service'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ProviderTurnRequest
} from './conversation-turn-runner'
import { createConversationIpcHandlers } from '../ipc/conversations'

let root = ''
let roster: Agent[] = []
let service: ConversationService
let driverCalls: ProviderTurnRequest[] = []
let counter = 0

const driver = {
  runTurn: async (request: ProviderTurnRequest) => {
    driverCalls.push(request)
    request.onEvent({ kind: 'turn-started', turnId: request.turnId })
    request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
    return { providerSessionId: 'thread-1' }
  }
}

function turnDeps(): Omit<ConversationTurnDeps, 'service'> {
  return {
    driver,
    checkAuth: async () => ({ ready: true }),
    mintTurnId: () => `turn-${++counter}`,
    mintItemId: () => `user-${++counter}`,
    emit: () => {}
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-agent-project-'))
  roster = []
  driverCalls = []
  counter = 0
  service = new ConversationService(() => join(root, 'conversations'), {
    readAgents: () => roster
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function agentOwnedBy(projectId: string | null): Agent {
  const created = {
    id: mintAgentId(),
    name: 'Ada',
    role: 'Knows this project.',
    projectId,
    createdAt: 1,
    updatedAt: 1
  }
  roster.push(created)
  return created
}

async function chatWith(target: Agent): Promise<string> {
  const created = await service.createForAgent({ agentId: target.id, title: target.name })
  if (created.outcome !== 'created') throw new Error(`precondition: ${created.outcome}`)
  return created.record.id
}

describe('CHARACTERIZATION: where a project-scoped agent runs today', () => {
  it('ignores the agent project entirely and runs wherever the caller pointed', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'orca-not-the-project-'))
    try {
      const ada = agentOwnedBy('github:acme/ledger')
      const outcome = await runConversationTurn(
        { ...turnDeps(), service },
        { conversationId: await chatWith(ada), text: 'what is in this repo?', cwd: elsewhere }
      )

      expect(outcome.outcome).toBe('completed')
      // The agent owns a project. Nothing consults it: the caller's directory wins outright.
      expect(driverCalls[0].cwd).toBe(elsewhere)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("turns an unset working directory into Orca's own, rather than refusing", async () => {
    // This is the live product path: ConversationsPage sends `cwd: ''` for every turn, and the IPC
    // handler resolves that to `process.cwd()`. Absence becomes a plausible-looking location that
    // nobody chose, which is the one outcome a missing value must never produce.
    const handlers = createConversationIpcHandlers({
      service,
      turnDeps: turnDeps()
    })
    const ada = agentOwnedBy('github:acme/ledger')
    const id = await chatWith(ada)

    await handlers['conversations:sendTurn']({ id, text: 'what is in this repo?', cwd: '' })

    expect(driverCalls[0].cwd).toBe(process.cwd())
  })

  it('compiles an instruction envelope that names no project', async () => {
    const ada = agentOwnedBy('github:acme/ledger')
    await runConversationTurn(
      { ...turnDeps(), service },
      { conversationId: await chatWith(ada), text: 'hi', cwd: root }
    )

    const instructions = driverCalls[0].developerInstructions ?? ''
    expect(instructions).toContain('Ada')
    // Ownership is declared on the agent and reaches the model nowhere.
    expect(instructions).not.toContain('ledger')
  })
})
