// Where does a project-scoped agent's turn actually RUN?
//
// This file began as a CHARACTERIZATION of the defect and was inverted in place when it was fixed,
// so the diff between the two versions is the evidence rather than a paragraph claiming it. What it
// used to pin: the agent's project was never consulted, and the live product path sent an empty cwd
// that the IPC handler resolved to `process.cwd()` — Orca's own install directory. A question about
// "this repository" was answered about Orca's packaged files.
//
// Wrong context is not absent context. It looks like an answer, which is why the fallback had to
// become unreachable rather than merely improved.

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
import { createConversationIpcHandlers } from '../ipc/conversations'

let root = ''
let roster: Agent[] = []
let setups: ProjectHostSetup[] = []
let service: ConversationService
let driverCalls: ProviderTurnRequest[] = []
let counter = 0

const driver = {
  provider: 'codex',
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
    resolveProjectLocation: (agent) =>
      resolveAgentProjectLocation(agent, { readProjectHostSetups: () => setups }),
    fallbackCwd: () => homedir(),
    mintTurnId: () => `turn-${++counter}`,
    mintItemId: () => `user-${++counter}`,
    emit: () => {}
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-agent-project-'))
  roster = []
  setups = []
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

function projectAt(projectId: string, path: string): void {
  setups.push({
    id: `setup-${setups.length}`,
    projectId,
    hostId: 'local',
    repoId: `repo-${setups.length}`,
    path,
    displayName: projectId.split('/').pop() ?? projectId,
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1
  })
}

async function chatWith(target: Agent): Promise<string> {
  const created = await service.createForAgent({ agentId: target.id, title: target.name })
  if (created.outcome !== 'created') throw new Error(`precondition: ${created.outcome}`)
  return created.record.id
}

describe('a project-scoped agent runs in its own project', () => {
  it("overrides the caller's directory with the agent's project", async () => {
    // INVERTED. This case used to assert the caller won outright. The caller is now a window that
    // may be focused anywhere, and the agent's project is the authority.
    const elsewhere = mkdtempSync(join(tmpdir(), 'orca-not-the-project-'))
    try {
      projectAt('github:acme/ledger', 'C:/work/ledger')
      const ada = agentOwnedBy('github:acme/ledger')

      const outcome = await runConversationTurn(
        { ...turnDeps(), service },
        { conversationId: await chatWith(ada), text: 'what is in this repo?', cwd: elsewhere }
      )

      expect(outcome.outcome).toBe('completed')
      expect(driverCalls[0].cwd).toBe('C:/work/ledger')
      expect(driverCalls[0].cwd).not.toBe(elsewhere)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("never roots a turn in Orca's own directory when nothing was supplied", async () => {
    // INVERTED. This used to assert `process.cwd()`. The live product path still sends an empty
    // cwd; what changed is that absence no longer becomes a location nobody chose.
    const handlers = createConversationIpcHandlers({ service, turnDeps: turnDeps() })
    projectAt('github:acme/ledger', 'C:/work/ledger')
    const ada = agentOwnedBy('github:acme/ledger')
    const id = await chatWith(ada)

    await handlers['conversations:sendTurn']({ id, text: 'what is in this repo?', cwd: '' })

    expect(driverCalls[0].cwd).toBe('C:/work/ledger')
    expect(driverCalls[0].cwd).not.toBe(process.cwd())
  })

  it('falls back to a declared location for an agent that owns no project', async () => {
    // `projectId: null` is a real choice, so this agent still works — it just has no project, and
    // it lands somewhere the person chose to have rather than wherever Orca was launched from.
    const handlers = createConversationIpcHandlers({ service, turnDeps: turnDeps() })
    const id = await chatWith(agentOwnedBy(null))

    const outcome = await handlers['conversations:sendTurn']({ id, text: 'hi', cwd: '' })

    expect(outcome.outcome).toBe('completed')
    expect(driverCalls[0].cwd).toBe(homedir())
  })

  it('refuses rather than running somewhere else when the project cannot be reached', async () => {
    // Nothing is committed and nothing is spent: an answer about the wrong directory is worse than
    // no answer, and these three refusals are not interchangeable.
    const gone = agentOwnedBy('github:acme/gone')
    const goneOutcome = await runConversationTurn(
      { ...turnDeps(), service },
      { conversationId: await chatWith(gone), text: 'hi', cwd: null }
    )
    expect(goneOutcome).toMatchObject({
      outcome: 'project-unavailable',
      reason: 'unresolved',
      projectId: 'github:acme/gone'
    })

    setups.push({
      id: 'remote',
      projectId: 'github:acme/remote',
      hostId: 'ssh:box',
      repoId: 'repo-r',
      path: '/home/dev/remote',
      displayName: 'remote',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    })
    const remote = agentOwnedBy('github:acme/remote')
    const remoteOutcome = await runConversationTurn(
      { ...turnDeps(), service },
      { conversationId: await chatWith(remote), text: 'hi', cwd: null }
    )
    expect(remoteOutcome).toMatchObject({
      outcome: 'project-unavailable',
      reason: 'remote-host'
    })

    // The provider was never asked anything, either time.
    expect(driverCalls).toHaveLength(0)
  })

  it('leaves Brainstorming free to run where the caller says', async () => {
    // The caller's cwd is not deprecated — it is now scoped to the cases where nothing else owns
    // the answer. A Brainstorming chat has no agent and therefore no project.
    const created = await service.create({ title: 'no one' })
    await runConversationTurn(
      { ...turnDeps(), service },
      { conversationId: created.id, text: 'hi', cwd: root }
    )
    expect(driverCalls[0].cwd).toBe(root)
  })
})
