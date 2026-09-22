import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintAgentId } from '../../shared/agent-identity'
import type { Agent } from '../../shared/agent-types'
import { ConversationService } from './conversation-service'

// W-C2 proved the STORE keeps `agentId`. It never crossed the owner that creates conversations, so
// the relation had zero producers. These cases drive the owner, which is where the producer lives.

let root: string
let roster: Agent[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-agent-binding-'))
  roster = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: mintAgentId(),
    name: 'Reliability',
    role: 'Finds the failure nobody measured.',
    projectId: 'repo:alpha',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function service(withRoster = true): ConversationService {
  return new ConversationService(
    () => join(root, 'conversations'),
    withRoster ? { readAgents: () => roster } : undefined
  )
}

describe('a conversation created with an agent', () => {
  it('carries the agent through the owner and survives a cold read', async () => {
    const ada = agent()
    roster.push(ada)

    const created = await service().createForAgent({ agentId: ada.id, title: 'first' })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return

    const loaded = await service().read(created.record.id)
    expect(loaded.outcome === 'loaded' && loaded.record.agentId).toBe(ada.id)
  })

  it('refuses an agent the roster does not hold, and writes nothing', async () => {
    const svc = service()
    const missing = mintAgentId()

    const created = await svc.createForAgent({ agentId: missing, title: 'ghost' })

    expect(created).toEqual({ outcome: 'agent-not-found', agentId: missing })
    expect(await svc.list()).toEqual([])
  })

  // Fail closed: a service that cannot see the roster must not guess that the agent exists.
  it('refuses when it has no roster to check against, and writes nothing', async () => {
    const svc = service(false)

    const created = await svc.createForAgent({ agentId: mintAgentId(), title: 'unchecked' })

    expect(created).toEqual({ outcome: 'agent-unverifiable' })
    expect(await svc.list()).toEqual([])
  })

  // The project mismatch is unrepresentable rather than validated: the agent path takes no project,
  // and the conversation holds none, so there is no second value that could disagree.
  it('holds no project of its own; the agent owns it', async () => {
    const ada = agent({ projectId: 'repo:alpha' })
    roster.push(ada)

    const created = await service().createForAgent({ agentId: ada.id, title: 'owned' })
    expect(created.outcome === 'created' && created.record.projectId).toBeNull()
  })

  // Project ids are promoted repo: -> git: -> github: mid-session. Deriving through the roster per
  // read means the conversation follows the promotion with no remap of its own.
  it('resolves the effective project through the agent, after a promotion', async () => {
    const ada = agent({ projectId: 'repo:alpha' })
    roster.push(ada)
    const svc = service()
    const created = await svc.createForAgent({ agentId: ada.id, title: 'promoted' })
    if (created.outcome !== 'created') throw new Error('precondition: create failed')

    roster[0] = { ...ada, projectId: 'github:org/alpha' }

    const binding = svc.agentFor(created.record)
    expect(binding.kind).toBe('agent')
    expect(binding.kind === 'agent' && binding.agent.projectId).toBe('github:org/alpha')
  })

  it('lists the agent binding so a surface can find an agent’s conversations', async () => {
    const ada = agent()
    roster.push(ada)
    const svc = service()
    await svc.createForAgent({ agentId: ada.id, title: 'listed' })
    await svc.create({ title: 'brainstorm' })

    const rows = await svc.list()
    const agentIds = rows.map((row) => (row.outcome === 'ok' ? row.agentId : 'unreadable'))
    expect(agentIds.sort()).toEqual([ada.id, null].sort())
  })
})

describe('the binding a turn reads', () => {
  it('is none for a Brainstorming conversation', async () => {
    const svc = service()
    const created = await svc.create({ title: 'no one' })
    expect(created.agentId).toBeUndefined()
    expect(svc.agentFor(created)).toEqual({ kind: 'none' })
  })

  // An agent-bound chat whose agent cannot be found must not quietly become Brainstorming.
  it('is agent-missing when the roster lost the agent, never none', async () => {
    const ada = agent()
    roster.push(ada)
    const svc = service()
    const created = await svc.createForAgent({ agentId: ada.id, title: 'orphan' })
    if (created.outcome !== 'created') throw new Error('precondition: create failed')

    roster.length = 0

    expect(svc.agentFor(created.record)).toEqual({ kind: 'agent-missing', agentId: ada.id })
  })

  it('is agent-unverifiable without a roster, never none', async () => {
    const ada = agent()
    roster.push(ada)
    const created = await service().createForAgent({ agentId: ada.id, title: 'x' })
    if (created.outcome !== 'created') throw new Error('precondition: create failed')

    expect(service(false).agentFor(created.record)).toEqual({
      kind: 'agent-unverifiable',
      agentId: ada.id
    })
  })
})
