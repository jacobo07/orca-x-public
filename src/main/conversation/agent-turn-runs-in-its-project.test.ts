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
import { ProviderUnavailableError } from './provider-unavailable'
import { TurnInterruptedError } from './turn-interruption'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ProviderTurnRequest,
  type RemoteDriverResolution
} from './conversation-turn-runner'
import type { ConversationTurnTrace } from './conversation-turn-trace'
import { createConversationIpcHandlers } from '../ipc/conversations'

let root = ''
let roster: Agent[] = []
let setups: ProjectHostSetup[] = []
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
  if (created.outcome !== 'created') {
    throw new Error(`precondition: ${created.outcome}`)
  }
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

    const runtime = agentOwnedBy('github:acme/cloud')
    remoteSetup('github:acme/cloud', 'runtime:cloud', '/srv/cloud')
    const runtimeOutcome = await runConversationTurn(
      { ...turnDeps(), service },
      { conversationId: await chatWith(runtime), text: 'hi', cwd: null }
    )
    expect(runtimeOutcome).toMatchObject({ outcome: 'project-unavailable', reason: 'remote-host' })

    // The provider was never asked anything, either time.
    expect(driverCalls).toHaveLength(0)
  })
})

function remoteSetup(projectId: string, hostId: ProjectHostSetup['hostId'], path: string): void {
  setups.push({
    id: `remote-${setups.length}`,
    projectId,
    hostId,
    repoId: `repo-r${setups.length}`,
    path,
    displayName: projectId.split('/').pop() ?? projectId,
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1
  })
}

describe("a remote project's agent runs on its host or not at all", () => {
  it('refuses with no remote driver, committing nothing and never falling back locally', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const ada = agentOwnedBy('github:acme/remote')
    const id = await chatWith(ada)
    let fallbackAsked = 0

    const outcome = await runConversationTurn(
      { ...turnDeps(), fallbackCwd: () => (fallbackAsked++, homedir()), service },
      { conversationId: id, text: 'what is in this repo?', cwd: root }
    )

    expect(outcome).toMatchObject({
      outcome: 'project-unavailable',
      reason: 'remote-execution-unavailable',
      projectId: 'github:acme/remote'
    })
    expect(driverCalls).toHaveLength(0)
    expect(fallbackAsked).toBe(0)
    const read = await service.read(id)
    expect(read.outcome).toBe('loaded')
    expect(read.outcome === 'loaded' ? read.record.messages : null).toEqual([])
  })

  it('runs through the REMOTE driver with the path on that host, never the local one', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const ada = agentOwnedBy('github:acme/remote')
    const remoteCalls: ProviderTurnRequest[] = []
    const targets: unknown[] = []
    const remoteDriver = {
      runTurn: async (request: ProviderTurnRequest) => {
        remoteCalls.push(request)
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: 'remote-thread' }
      }
    }

    let localAuthAsked = 0
    const outcome = await runConversationTurn(
      {
        ...turnDeps(),
        checkAuth: async () => (localAuthAsked++, { ready: true }),
        remoteDriverFor: async (target) => (
          targets.push(target),
          { driver: remoteDriver, checkAuth: async () => ({ ready: true }) }
        ),
        service
      },
      { conversationId: await chatWith(ada), text: 'hi', cwd: root }
    )

    expect(outcome.outcome).toBe('completed')
    expect(driverCalls).toHaveLength(0)
    // The host the turn runs on answers whether it is signed in — not this computer.
    expect(localAuthAsked).toBe(0)
    expect(targets).toEqual([
      {
        projectId: 'github:acme/remote',
        hostId: 'ssh:box',
        setupId: expect.stringMatching(/^remote-/),
        path: '/home/dev/remote'
      }
    ])
    expect(remoteCalls[0].cwd).toBe('/home/dev/remote')
    expect(remoteCalls[0].developerInstructions).toContain('on the remote host "box"')
  })

  it('refuses to choose between two ready hosts', async () => {
    remoteSetup('github:acme/twin', 'ssh:box-a', '/a/twin')
    remoteSetup('github:acme/twin', 'ssh:box-b', '/b/twin')
    const outcome = await runConversationTurn(
      {
        ...turnDeps(),
        remoteDriverFor: async () => ({ driver, checkAuth: async () => ({ ready: true }) }),
        service
      },
      { conversationId: await chatWith(agentOwnedBy('github:acme/twin')), text: 'hi', cwd: null }
    )
    expect(outcome).toMatchObject({ outcome: 'project-unavailable', reason: 'ambiguous-host' })
    expect(driverCalls).toHaveLength(0)
  })

  it('names an unreachable host and a too-old relay apart, and a probe that threw as unreachable', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const ada = agentOwnedBy('github:acme/remote')
    const send = (remoteDriverFor: ConversationTurnDeps['remoteDriverFor']) =>
      chatWith(ada).then((conversationId) =>
        runConversationTurn(
          { ...turnDeps(), remoteDriverFor, service },
          { conversationId, text: 'hi', cwd: null }
        )
      )

    await expect(send(async () => ({ refusal: 'remote-host-unreachable' }))).resolves.toMatchObject(
      { reason: 'remote-host-unreachable' }
    )
    await expect(
      send(async () => ({ refusal: 'remote-relay-unsupported' }))
    ).resolves.toMatchObject({ reason: 'remote-relay-unsupported' })
    await expect(send(async () => ({ refusal: 'remote-project-missing' }))).resolves.toMatchObject({
      reason: 'remote-project-missing',
      detail: 'This agent’s project directory is not on its remote host.'
    })
    await expect(
      send(async () => {
        throw new Error('socket hang up')
      })
    ).resolves.toMatchObject({ reason: 'remote-host-unreachable' })
    expect(driverCalls).toHaveLength(0)
  })

  it('refuses when the project moved while the host was being asked', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const ada = agentOwnedBy('github:acme/remote')
    const remoteDriver = { runTurn: async () => ({ providerSessionId: null }) }

    const outcome = await runConversationTurn(
      {
        ...turnDeps(),
        remoteDriverFor: async () => {
          // The setup is re-pointed during the probe, as a user re-adding the project would.
          setups = setups.map((setup) => ({ ...setup, path: '/home/dev/moved' }))
          return { driver: remoteDriver, checkAuth: async () => ({ ready: true }) }
        },
        service
      },
      { conversationId: await chatWith(ada), text: 'hi', cwd: null }
    )

    expect(outcome).toMatchObject({ outcome: 'project-unavailable', reason: 'location-changed' })
  })

  it('reports a remote auth check that could not ask as a failed turn, never as sign-in', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const ada = agentOwnedBy('github:acme/remote')
    const outcome = await runConversationTurn(
      {
        ...turnDeps(),
        remoteDriverFor: async () => ({
          driver,
          checkAuth: async () => {
            throw new Error('the ssh connection to the host closed')
          }
        }),
        service
      },
      { conversationId: await chatWith(ada), text: 'hi', cwd: null }
    )
    expect(outcome.outcome).toBe('failed')
    expect(driverCalls).toHaveLength(0)
  })

  it('names a provider the host cannot run as its own state, never as a failed turn', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const ada = agentOwnedBy('github:acme/remote')
    const send = (checkAuth: () => Promise<never>, runTurn: () => Promise<never>) =>
      chatWith(ada).then((conversationId) =>
        runConversationTurn(
          {
            ...turnDeps(),
            remoteDriverFor: async () => ({ driver: { runTurn }, checkAuth }),
            service
          },
          { conversationId, text: 'hi', cwd: null }
        )
      )
    const unavailable = (reason: 'not-installed' | 'protocol-unsupported') => async () => {
      throw new ProviderUnavailableError(reason, `codex ${reason} on box`)
    }
    const never = async (): Promise<never> => {
      throw new Error('the turn must not start')
    }

    await expect(send(unavailable('not-installed'), never)).resolves.toEqual({
      outcome: 'provider-unavailable',
      reason: 'not-installed',
      detail: 'codex not-installed on box'
    })
    const ready = async () => ({ ready: true }) as never
    await expect(send(ready, unavailable('protocol-unsupported'))).resolves.toMatchObject({
      outcome: 'provider-unavailable',
      reason: 'protocol-unsupported'
    })
  })

  it('records the host a thread lives on, and never resumes it from another host', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const ada = agentOwnedBy('github:acme/remote')
    const id = await chatWith(ada)
    const remoteDriver = {
      runTurn: async (request: ProviderTurnRequest) => {
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: 'remote-thread' }
      }
    }
    const remoteDeps = {
      ...turnDeps(),
      remoteDriverFor: async () => ({
        driver: remoteDriver,
        checkAuth: async () => ({ ready: true as const })
      }),
      service
    }
    await runConversationTurn(remoteDeps, { conversationId: id, text: 'one', cwd: null })

    const afterRemote = await service.read(id)
    const head = afterRemote.outcome === 'loaded' ? afterRemote.record.provenance.at(-1) : null
    expect(head).toMatchObject({ providerSessionId: 'remote-thread', executionHostId: 'ssh:box' })

    // The same project becomes ready locally: the rule now puts the turn here, and the remote
    // thread's history does not exist on this machine, so it must not be resumed.
    projectAt('github:acme/remote', 'C:/work/remote')
    await runConversationTurn(remoteDeps, { conversationId: id, text: 'two', cwd: null })
    expect(driverCalls[0].cwd).toBe('C:/work/remote')
    expect(driverCalls[0].resumeSessionId).toBeNull()

    // A local binding carries no host field at all, so local records keep the shape they had.
    const afterLocal = await service.read(id)
    const localHead = afterLocal.outcome === 'loaded' ? afterLocal.record.provenance.at(-1) : null
    expect(localHead).toMatchObject({ providerSessionId: 'thread-1' })
    expect(localHead && 'executionHostId' in localHead).toBe(false)
  })

  it('hands the driver the directory a thread was recorded in, so a moved project is relocated', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const id = await chatWith(agentOwnedBy('github:acme/remote'))
    const seen: ProviderTurnRequest[] = []
    const remoteDeps = {
      ...turnDeps(),
      remoteDriverFor: async () => ({
        driver: {
          runTurn: async (request: ProviderTurnRequest) => {
            seen.push(request)
            request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
            return { providerSessionId: 'remote-thread' }
          }
        },
        checkAuth: async () => ({ ready: true as const })
      }),
      service
    }
    await runConversationTurn(remoteDeps, { conversationId: id, text: 'one', cwd: null })
    setups = setups.map((setup) => ({ ...setup, path: '/home/dev/moved' }))
    await runConversationTurn(remoteDeps, { conversationId: id, text: 'two', cwd: null })

    expect(seen[0].resumeCwd).toBeNull()
    expect(seen[1]).toMatchObject({
      resumeSessionId: 'remote-thread',
      resumeCwd: '/home/dev/remote',
      cwd: '/home/dev/moved'
    })
    const read = await service.read(id)
    const head = read.outcome === 'loaded' ? read.record.provenance.at(-1) : null
    expect(head).toMatchObject({ providerSessionId: 'remote-thread', cwd: '/home/dev/moved' })
  })
})

describe('a remote turn while its world changes (Phase 6)', () => {
  it('reports a host lost mid-turn as a failed turn, and never retries it locally', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const id = await chatWith(agentOwnedBy('github:acme/remote'))
    const outcome = await runConversationTurn(
      {
        ...turnDeps(),
        remoteDriverFor: async () => ({
          driver: {
            runTurn: async (request: ProviderTurnRequest) => {
              request.onEvent({ kind: 'turn-started', turnId: request.turnId })
              // What the ssh driver raises when the connection closes mid-turn.
              throw new TurnInterruptedError('host-lost', 'the ssh connection to the host closed')
            }
          },
          checkAuth: async () => ({ ready: true as const })
        }),
        service
      },
      { conversationId: id, text: 'still there?', cwd: null }
    )

    expect(outcome).toMatchObject({
      outcome: 'failed',
      reason: 'the ssh connection to the host closed',
      cause: 'host-lost'
    })
    expect(driverCalls).toHaveLength(0)
    const read = await service.read(id)
    const turn = read.outcome === 'loaded' ? read.record.turns.at(-1) : null
    // Durable too: the turn does not reload as one still working.
    expect(turn?.state).toBe('failed')
  })

  it('keeps a turn on its admitted location when its project id succeeds mid-turn, and the next turn follows', async () => {
    remoteSetup('repo:repo-1', 'ssh:box', '/home/dev/ledger')
    const ada = agentOwnedBy('repo:repo-1')
    const id = await chatWith(ada)
    const seen: ProviderTurnRequest[] = []
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const deps = {
      ...turnDeps(),
      remoteDriverFor: async () => ({
        driver: {
          runTurn: async (request: ProviderTurnRequest) => {
            seen.push(request)
            if (seen.length === 1) {
              await held
            }
            request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
            return { providerSessionId: 'remote-thread' }
          }
        },
        checkAuth: async () => ({ ready: true as const })
      }),
      service
    }

    const first = runConversationTurn(deps, { conversationId: id, text: 'one', cwd: null })
    while (seen.length === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    // Succession lands while the turn is running: repo: -> github:, same host, same directory.
    roster = roster.map((agent) =>
      agent.id === ada.id ? { ...agent, projectId: 'github:acme/ledger' } : agent
    )
    setups = setups.map((setup) => ({ ...setup, projectId: 'github:acme/ledger' }))
    release()

    await expect(first).resolves.toMatchObject({ outcome: 'completed' })
    expect(seen[0].cwd).toBe('/home/dev/ledger')
    // The next turn resolves through the promoted id and continues the SAME thread on that host.
    await expect(
      runConversationTurn(deps, { conversationId: id, text: 'two', cwd: null })
    ).resolves.toMatchObject({ outcome: 'completed' })
    expect(seen[1]).toMatchObject({
      resumeSessionId: 'remote-thread',
      resumeCwd: '/home/dev/ledger',
      cwd: '/home/dev/ledger'
    })
  })
})

describe('two projects on one host never borrow each other (Phase 7)', () => {
  it('runs each agent in its own project on a shared host, and refuses one whose project is not set up there', async () => {
    remoteSetup('github:acme/ledger', 'ssh:box', '/home/dev/ledger')
    remoteSetup('github:acme/billing', 'ssh:box', '/home/dev/billing')
    const seen: ProviderTurnRequest[] = []
    const deps = {
      ...turnDeps(),
      remoteDriverFor: async () => ({
        driver: {
          runTurn: async (request: ProviderTurnRequest) => {
            seen.push(request)
            request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
            return { providerSessionId: `thread-${seen.length}` }
          }
        },
        checkAuth: async () => ({ ready: true as const })
      }),
      service
    }
    const send = async (projectId: string) =>
      runConversationTurn(deps, {
        conversationId: await chatWith(agentOwnedBy(projectId)),
        text: 'hi',
        cwd: null
      })

    await send('github:acme/ledger')
    await send('github:acme/billing')
    expect(seen.map((request) => request.cwd)).toEqual(['/home/dev/ledger', '/home/dev/billing'])
    // Wrong-project control: the host holds OTHER projects, never this one's; it is not borrowed.
    await expect(send('github:acme/payroll')).resolves.toMatchObject({
      outcome: 'project-unavailable',
      reason: 'unresolved'
    })
    expect(seen).toHaveLength(2)
  })
})

describe('the turn trace (Phase 7)', () => {
  const remoteDeps = (traces: ConversationTurnTrace[], resolution: RemoteDriverResolution) => ({
    ...turnDeps(),
    onTrace: (trace: ConversationTurnTrace) => traces.push(trace),
    remoteDriverFor: async () => resolution,
    service
  })

  it('names every link of where a remote turn ran, and carries none of what was said', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const ada = agentOwnedBy('github:acme/remote')
    const id = await chatWith(ada)
    const traces: ConversationTurnTrace[] = []
    const SAID = 'the launch code is 0000'
    await runConversationTurn(
      remoteDeps(traces, {
        driver: {
          runTurn: async (request: ProviderTurnRequest) => {
            request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
            return { providerSessionId: 'remote-thread' }
          }
        },
        checkAuth: async () => ({ ready: true as const })
      }),
      { conversationId: id, text: SAID, cwd: null }
    )

    expect(traces).toEqual([
      {
        conversationId: id,
        agentId: ada.id,
        projectId: 'github:acme/remote',
        hostId: 'ssh:box',
        setupId: expect.stringMatching(/^remote-/),
        path: '/home/dev/remote',
        authority: 'ssh-relay',
        providerSessionId: 'remote-thread',
        provider: 'codex',
        outcome: 'completed',
        reason: null
      }
    ])
    expect(JSON.stringify(traces)).not.toContain(SAID)
  })

  it('says where a refused turn tried, and why', async () => {
    remoteSetup('github:acme/remote', 'ssh:box', '/home/dev/remote')
    const traces: ConversationTurnTrace[] = []
    await runConversationTurn(remoteDeps(traces, { refusal: 'remote-host-unreachable' }), {
      conversationId: await chatWith(agentOwnedBy('github:acme/remote')),
      text: 'hi',
      cwd: null
    })
    expect(traces[0]).toMatchObject({
      hostId: 'ssh:box',
      path: '/home/dev/remote',
      authority: null,
      outcome: 'project-unavailable',
      reason: 'remote-host-unreachable'
    })
  })
})

describe('brainstorming keeps the caller location', () => {
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
