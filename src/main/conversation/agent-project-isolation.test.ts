// A Project A agent receiving Project B's directory is a severity-one correctness failure: the
// provider would read the wrong repository and answer confidently about it.
//
// These cases drive the dimension the runner cannot see and therefore cannot be trusted on by
// inspection — a window whose focus is on the OTHER project. The window is represented by the only
// thing it actually controls here, the caller's cwd, because that is the whole surface through
// which UI state could ever reach a turn.

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintAgentId } from '../../shared/agent-identity'
import type { Agent } from '../../shared/agent-types'
import type { ProjectHostSetup } from '../../shared/project-types'

import { resolveAgentProjectLocation } from './agent-project-location'
import { ConversationService } from './conversation-service'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ProviderTurnRequest
} from './conversation-turn-runner'

const LEDGER = 'C:/work/ledger'
const BILLING = 'C:/work/billing'

let root = ''
let roster: Agent[] = []
let setups: ProjectHostSetup[] = []
let service: ConversationService
let driverCalls: ProviderTurnRequest[] = []
let counter = 0

function deps(): ConversationTurnDeps {
  return {
    service,
    driver: {
      provider: 'codex',
      runTurn: async (request) => {
        driverCalls.push(request)
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: `thread-${driverCalls.length}` }
      }
    },
    checkAuth: async () => ({ ready: true }),
    resolveProjectLocation: (agent) =>
      resolveAgentProjectLocation(agent, { readProjectHostSetups: () => setups }),
    fallbackCwd: () => homedir(),
    mintTurnId: () => `turn-${++counter}`,
    mintItemId: () => `user-${++counter}`,
    emit: () => {}
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-project-isolation-'))
  roster = []
  driverCalls = []
  counter = 0
  setups = [project('github:acme/ledger', LEDGER), project('github:acme/billing', BILLING)]
  service = new ConversationService(() => join(root, 'conversations'), {
    readAgents: () => roster
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function project(projectId: string, path: string): ProjectHostSetup {
  return {
    id: `setup-${projectId}`,
    projectId,
    hostId: 'local',
    repoId: `repo-${projectId}`,
    path,
    displayName: projectId.split('/').pop() ?? projectId,
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1
  }
}

function agentIn(name: string, projectId: string): Agent {
  const created = { id: mintAgentId(), name, role: '', projectId, createdAt: 1, updatedAt: 1 }
  roster.push(created)
  return created
}

async function chatWith(target: Agent): Promise<string> {
  const created = await service.createForAgent({ agentId: target.id, title: target.name })
  if (created.outcome !== 'created') throw new Error(`precondition: ${created.outcome}`)
  return created.record.id
}

describe('an agent cannot be handed another project', () => {
  it("keeps the Project A agent in Project A while the window is focused on Project B", async () => {
    const ada = agentIn('Ada', 'github:acme/ledger')

    // The window is showing billing. Every signal the surface controls points the other way.
    await runConversationTurn(deps(), {
      conversationId: await chatWith(ada),
      text: 'what is in this repo?',
      cwd: BILLING
    })

    expect(driverCalls[0].cwd).toBe(LEDGER)
    expect(driverCalls[0].developerInstructions).toContain('ledger')
    expect(driverCalls[0].developerInstructions).not.toContain('billing')
  })

  it('gives two agents in two projects two directories, interleaved', async () => {
    const ada = agentIn('Ada', 'github:acme/ledger')
    const mo = agentIn('Mo', 'github:acme/billing')
    const adaChat = await chatWith(ada)
    const moChat = await chatWith(mo)

    // Interleaved on purpose: a resolver that cached the first answer would pass a sequential test.
    await runConversationTurn(deps(), { conversationId: adaChat, text: 'a', cwd: null })
    await runConversationTurn(deps(), { conversationId: moChat, text: 'b', cwd: null })
    await runConversationTurn(deps(), { conversationId: adaChat, text: 'c', cwd: null })

    expect(driverCalls.map((call) => call.cwd)).toEqual([LEDGER, BILLING, LEDGER])
  })

  it('keeps the same project across a resume, not whichever was opened last', async () => {
    const ada = agentIn('Ada', 'github:acme/ledger')
    const mo = agentIn('Mo', 'github:acme/billing')
    const adaChat = await chatWith(ada)

    await runConversationTurn(deps(), { conversationId: adaChat, text: 'first', cwd: null })
    // Another project's agent is opened in between, as a person switching context would.
    await runConversationTurn(deps(), { conversationId: await chatWith(mo), text: 'x', cwd: null })
    // Returning to the first conversation resumes its provider thread.
    await runConversationTurn(deps(), { conversationId: adaChat, text: 'second', cwd: null })

    const resumed = driverCalls[2]
    expect(resumed.cwd).toBe(LEDGER)
    expect(resumed.resumeSessionId).toBe('thread-1')
  })

  it('follows the agent when its project binding changes, with no remap of its own', async () => {
    // The roster is the single authority. An agent moved to another project — by succession or by
    // the user — must move with it, and nothing here caches a second answer that could disagree.
    const ada = agentIn('Ada', 'github:acme/ledger')
    const chat = await chatWith(ada)

    await runConversationTurn(deps(), { conversationId: chat, text: 'before', cwd: null })
    roster[0] = { ...ada, projectId: 'github:acme/billing' }
    await runConversationTurn(deps(), { conversationId: chat, text: 'after', cwd: null })

    expect(driverCalls.map((call) => call.cwd)).toEqual([LEDGER, BILLING])
  })

  it('holds no project on the conversation record that could disagree with the agent', async () => {
    // The record's own projectId stays null for an agent chat BY CONSTRUCTION: createForAgent takes
    // no project. If it ever started carrying one, two authorities would exist and this would fail.
    const ada = agentIn('Ada', 'github:acme/ledger')
    const chat = await chatWith(ada)
    const loaded = await service.read(chat)
    if (loaded.outcome !== 'loaded') throw new Error(`precondition: ${loaded.outcome}`)

    expect(loaded.record.projectId).toBeNull()
    expect(loaded.record.agentId).toBe(ada.id)
  })
})
