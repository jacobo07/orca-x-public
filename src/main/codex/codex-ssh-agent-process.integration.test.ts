// Rung 2: the whole remote-turn path in one process, with nothing faked but the ssh wire itself.
//
// A REAL relay dispatcher and the REAL agentProcess handler spawn a REAL child; a REAL multiplexer
// talks to them over an in-memory transport; the ssh adapter and the unchanged local app-server
// session drive a real Codex conversation driver through it. The child is a scripted app-server:
// "codex" resolves to this node, and `app-server` is a script file of that name in the project
// directory, so `node app-server` is what runs — in the directory the turn was located in.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { ProviderUnavailableError } from '../conversation/provider-unavailable'
import { TurnInterruptedError } from '../conversation/turn-interruption'

import { runCodexAppServerSession } from './codex-app-server-session'
import { createCodexConversationDriver } from './codex-conversation-driver'
import {
  createRelayHarness,
  disposeRelayHarness,
  isAlive,
  processesIn,
  waitUntil,
  type RelayHarness
} from './codex-relay-test-harness'
import { createSshAgentProcessSpawn } from './codex-ssh-agent-process'
import { resolveSshCodexDriver } from './codex-ssh-conversation-driver'

const SCRIPTED_APP_SERVER = String.raw`
const fs = require('fs')
fs.writeFileSync('pid.txt', String(process.pid))
const hang = fs.existsSync('hang.flag')
let buffer = ''
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const waiting = new Map()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
function handle(message) {
  if (message.id !== undefined && !message.method) {
    const resolve = waiting.get(message.id)
    if (resolve) { waiting.delete(message.id); resolve(message) }
    return
  }
  if (message.method === 'initialize') return send({ id: message.id, result: {} })
  if (message.method === 'thread/start') {
    return send({ id: message.id, result: { thread: { id: 'thr-remote', cwd: process.cwd() } } })
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } })
    return runTurn()
  }
}
async function runTurn() {
  send({ method: 'turn/started', params: { turn: { id: 'turn-1' } } })
  if (hang) return
  const answer = await new Promise((resolve) => {
    waiting.set('srv-1', resolve)
    send({ id: 'srv-1', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thr-remote', turnId: 'turn-1', itemId: 'cmd-1', command: 'ls' } })
  })
  fs.writeFileSync('approval.json', JSON.stringify(answer))
  const burst = 'x'.repeat(200 * 1024)
  send({ method: 'item/agentMessage/delta', params: { itemId: 'msg-1', turnId: 'turn-1', delta: burst } })
  send({ method: 'item/completed', params: { item: { id: 'msg-1', type: 'agentMessage', text: 'cwd=' + process.cwd() } } })
  send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
}
`

let project = ''
let harness: RelayHarness

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'orca-remote-project-'))
  writeFileSync(join(project, 'app-server'), SCRIPTED_APP_SERVER)
  harness = createRelayHarness()
})

afterEach(async () => {
  await disposeRelayHarness(harness)
  rmSync(project, { recursive: true, force: true })
})

function remoteDriver(timeoutMs: number) {
  return createCodexConversationDriver({
    command: 'codex',
    timeoutMs,
    runSession: (invocation, body, _spawn, handlers) =>
      runCodexAppServerSession(
        { ...invocation, exitGraceMs: 5_000 },
        body,
        createSshAgentProcessSpawn(harness.mux, {
          cwd: project,
          deadlineMs: timeoutMs
        }) as never,
        handlers
      )
  })
}

describe('a remote turn through the real relay handler and a real child', () => {
  it('completes a turn in the located directory, answers the approval, survives a burst, and reaps the child', async () => {
    const events: AgentTurnEvent[] = []

    const result = await remoteDriver(60_000).runTurn({
      resumeSessionId: null,
      cwd: project,
      text: 'what is here?',
      developerInstructions: null,
      turnId: 'turn-local-1',
      onEvent: (event) => events.push(event)
    })

    expect(result.providerSessionId).toBe('thr-remote')
    expect(events.map((event) => event.kind)).toContain('turn-completed')
    const deltas = events.filter((event) => event.kind === 'assistant-delta')
    expect(deltas.map((event) => (event as { text: string }).text).join('')).toHaveLength(
      200 * 1024
    )
    const completed = events.find(
      (event) => event.kind === 'message-completed' && event.role === 'assistant'
    ) as { blocks?: { type: string; text?: string }[] } | undefined
    // The provider ran in the project directory the turn was located in, not wherever Orca runs.
    expect(completed?.blocks?.[0]?.text?.toLowerCase()).toBe(`cwd=${project}`.toLowerCase())
    // The server->client request crossed the relay both ways and was answered.
    expect(JSON.parse(readFileSync(join(project, 'approval.json'), 'utf8'))).toMatchObject({
      id: 'srv-1'
    })

    const pid = Number(readFileSync(join(project, 'pid.txt'), 'utf8'))
    expect(await waitUntil(() => !isAlive(pid), 10_000)).toBe(true)
  }, 90_000)

  it('names a codex too old for app-server as its own state, through the ssh driver', async () => {
    writeFileSync(
      join(project, 'app-server'),
      `process.stderr.write("error: unrecognized subcommand 'app-server'\\n"); process.exit(2)\n`
    )
    const resolution = await resolveSshCodexDriver(
      { projectId: 'github:acme/ledger', hostId: 'ssh:box', setupId: 'setup-1', path: project },
      () => harness.mux
    )
    if (!('driver' in resolution)) {
      throw new Error(`expected a driver, got ${resolution.refusal}`)
    }
    const outcome = await resolution.driver
      .runTurn({
        resumeSessionId: null,
        cwd: project,
        text: 'hello',
        developerInstructions: null,
        turnId: 'turn-local-3',
        onEvent: () => {}
      })
      .then(
        () => 'returned',
        (error: unknown) => error
      )
    expect(outcome).toBeInstanceOf(ProviderUnavailableError)
    expect(outcome).toMatchObject({ reason: 'protocol-unsupported' })
  }, 60_000)

  it('ends a turn whose host goes away mid-turn at once, as host-lost, not at the deadline', async () => {
    // Found while writing Phase 7: mid-turn nothing is pending, so a dead child failed no request and
    // the session waited out its deadline, then reported the lost host as a timeout.
    writeFileSync(join(project, 'hang.flag'), '1')
    const resolution = await resolveSshCodexDriver(
      { projectId: 'github:acme/ledger', hostId: 'ssh:box', setupId: 'setup-1', path: project },
      () => harness.mux
    )
    if (!('driver' in resolution)) {
      throw new Error(`expected a driver, got ${resolution.refusal}`)
    }
    const started = Date.now()
    const outcome = resolution.driver
      .runTurn({
        resumeSessionId: null,
        cwd: project,
        text: 'hang',
        developerInstructions: null,
        turnId: 'turn-local-4',
        onEvent: (event) => {
          if (event.kind === 'turn-started') {
            harness.mux.dispose()
          }
        }
      })
      .then(
        () => 'returned',
        (error: unknown) => error
      )

    await expect(outcome).resolves.toBeInstanceOf(TurnInterruptedError)
    await expect(outcome).resolves.toMatchObject({ cause: 'host-lost' })
    // The driver's own deadline is 300 s; this must not be waiting it out.
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 60_000)

  it('kills the remote child when the session deadline lapses mid-turn', async () => {
    writeFileSync(join(project, 'hang.flag'), '1')

    const outcome = await remoteDriver(4_000)
      .runTurn({
        resumeSessionId: null,
        cwd: project,
        text: 'hang',
        developerInstructions: null,
        turnId: 'turn-local-2',
        onEvent: () => {}
      })
      .then(
        () => 'returned',
        (error: Error) => error.name
      )

    expect(outcome).not.toBe('returned')
    const pid = Number(readFileSync(join(project, 'pid.txt'), 'utf8'))
    expect(await waitUntil(() => !isAlive(pid), 10_000)).toBe(true)
  }, 60_000)
})

// Rung 3, opt-in: the installed Codex CLI on a Linux host, with the host deps unreplaced — real
// command resolution, spawn and group kill. Needs no login: `thread/start` answers without a model.
describe.skipIf(process.platform !== 'linux' || process.env.ORCA_REAL_CODEX_RUNG !== '1')(
  'a real codex app-server through the relay handler',
  () => {
    it('runs in the located directory, reports it, and leaves no process behind', async () => {
      const real = createRelayHarness(true)
      const home = mkdtempSync(join(tmpdir(), 'orca-isolated-codex-home-'))
      try {
        const observed = await runCodexAppServerSession(
          { command: 'codex', args: ['app-server'], timeoutMs: 60_000, exitGraceMs: 5_000 },
          async (rpc) => {
            const started = (await rpc.request('thread/start', { cwd: project })) as {
              thread?: { cwd?: string }
            }
            return { threadCwd: started.thread?.cwd, running: processesIn(project) }
          },
          createSshAgentProcessSpawn(real.mux, {
            cwd: project,
            deadlineMs: 60_000,
            envOverlay: { CODEX_HOME: home }
          }) as never
        )
        expect(realpathSync(observed.threadCwd ?? '')).toBe(realpathSync(project))
        // The kernel's answer, not the echoed request: the installed binary runs in the project.
        expect(observed.running.some((exe) => /codex/.test(exe))).toBe(true)
        expect(await waitUntil(() => processesIn(project).length === 0, 10_000)).toBe(true)
      } finally {
        await disposeRelayHarness(real)
        rmSync(home, { recursive: true, force: true })
      }
    }, 90_000)

    // Phase 4's protocol rung: the DRIVER's resume path, not a probe. The model turn itself cannot
    // answer (no login, and the account is quota-blocked), so the evidence is which thread the
    // driver kept and whether it had to fall back — both decided before any model runs.
    it('resumes a thread from one directory into another only as the provider confirms it', async () => {
      const real = createRelayHarness(true)
      const home = mkdtempSync(join(tmpdir(), 'orca-isolated-codex-home-'))
      const moved = mkdtempSync(join(tmpdir(), 'orca-remote-moved-'))
      const turnIn = (dir: string, resumeSessionId: string | null, resumeCwd: string | null) => {
        const events: AgentTurnEvent[] = []
        const driver = createCodexConversationDriver({
          command: 'codex',
          timeoutMs: 30_000,
          runSession: (invocation, body, _spawn, handlers) =>
            runCodexAppServerSession(
              { ...invocation, exitGraceMs: 5_000 },
              body,
              createSshAgentProcessSpawn(real.mux, {
                cwd: dir,
                deadlineMs: 30_000,
                envOverlay: { CODEX_HOME: home }
              }) as never,
              handlers
            )
        })
        return driver
          .runTurn({
            resumeSessionId,
            resumeCwd,
            cwd: dir,
            text: 'hi',
            developerInstructions: null,
            turnId: 'turn-real',
            onEvent: (event) => events.push(event)
          })
          .then(
            (result) => ({ id: result.providerSessionId, error: null, events }),
            (error: Error) => ({ id: null, error: error.message, events })
          )
      }
      // Only the driver's own fallbacks: Codex's thread-status notifications (`idle`, `active`) also
      // arrive as provider-status, and are not a lost thread.
      const FALLBACKS = [
        'thread-resume-failed',
        'thread-resume-empty',
        'thread-relocation-unconfirmed'
      ]
      const statuses = (events: AgentTurnEvent[]) =>
        events.flatMap((event) =>
          event.kind === 'provider-status' && FALLBACKS.includes(event.status) ? [event.status] : []
        )
      try {
        // Whole objects asserted, so a red run prints what the provider actually did.
        const first = await turnIn(project, null, null)
        expect({ ...first, events: statuses(first.events) }).toMatchObject({
          id: expect.any(String)
        })

        const relocated = await turnIn(moved, first.id, project)
        expect({ ...relocated, events: statuses(relocated.events) }).toMatchObject({
          id: first.id,
          events: []
        })

        // Control: the fallback channel is live, so the empty list above is an observation.
        const gone = await turnIn(moved, '00000000-0000-0000-0000-000000000000', moved)
        expect(statuses(gone.events)).toContain('thread-resume-failed')
      } finally {
        await disposeRelayHarness(real)
        rmSync(home, { recursive: true, force: true })
        rmSync(moved, { recursive: true, force: true })
      }
    }, 180_000)
  }
)
